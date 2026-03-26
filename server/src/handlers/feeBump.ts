import { FeeBumpRequest, FeeBumpSchema } from "../schemas/feeBump";
import { NextFunction, Request, Response } from "express";
import { createLogger, serializeError } from "../utils/logger";
import { signTransaction, signTransactionWithVault } from "../signing";

import { ApiKeyConfig } from "../middleware/apiKeys";
import { AppError } from "../errors/AppError";
import { Config } from "../config";
import StellarSdk from "@stellar/stellar-sdk";
import { calculateFeeBumpFee } from "../utils/feeCalculator";
import { checkTenantDailyQuota } from "../services/quota";
import { getHorizonFailoverClient } from "../horizon/failoverClient";
import { nativeSigner } from "../signing/native";
import { recordSponsoredTransaction } from "../models/transactionLedger";
import { syncTenantFromApiKey } from "../models/tenantStore";
import { transactionStore } from "../workers/transactionStore";
import { verifyXdrNetwork } from "../utils/networkVerification";

export const feeBumpLogger = createLogger({ component: "fee_bump_handler" });

interface FeeBumpResponse {
  xdr: string;
  status: "ready" | "submitted";
  hash?: string;
  fee_payer: string;
  submitted_via?: string;
  submission_attempts?: number;
}

export async function feeBumpHandler (
  req: Request,
  res: Response,
  config: Config,
  next: NextFunction
): Promise<void> {
  try {
    const parsedBody = FeeBumpSchema.safeParse(req.body);

    if (!parsedBody.success) {
      feeBumpLogger.warn(
        { validation_errors: parsedBody.error.format() },
        "Validation failed for fee bump request"
      );

      return next(
        new AppError(
          `Validation failed: ${JSON.stringify(parsedBody.error.format())}`,
          400,
          "INVALID_XDR",
        ),
      );
    }

    const body: FeeBumpRequest = parsedBody.data;
    const apiKeyConfig = res.locals.apiKey as ApiKeyConfig | undefined;
    if (!apiKeyConfig) {
      return next(
        new AppError(
          "Missing tenant context for fee sponsorship",
          500,
          "INTERNAL_ERROR"
        )
      );
    }

    const tenant = syncTenantFromApiKey(apiKeyConfig);
    const signerLease = await config.signerPool.acquire();
    const feePayerAccount = config.feePayerAccounts.find(
      (account) => account.publicKey === signerLease.account.publicKey
    );
    if (!feePayerAccount) {
      await signerLease.release();
      return next(
        new AppError(
          "Failed to resolve fee payer configuration",
          500,
          "INTERNAL_ERROR"
        )
      );
    }

    feeBumpLogger.info(
      {
        fee_payer: feePayerAccount.publicKey,
        submit: Boolean(body.submit),
        tenant_id: tenant.id,
      },
      "Received fee bump request"
    );

    try {
      let innerTransaction: any;
      try {
        innerTransaction = StellarSdk.TransactionBuilder.fromXDR(
          body.xdr,
          config.networkPassphrase
        ) as any;
      } catch (error: any) {
        feeBumpLogger.warn(
          {
            ...serializeError(error),
            fee_payer: feePayerAccount.publicKey,
            tenant_id: tenant.id,
          },
          "Failed to parse XDR"
        );
        return next(
          new AppError(`Invalid XDR: ${error.message}`, 400, "INVALID_XDR")
        );
      }

      // Verify network isolation - reject XDR if it doesn't match server's configured network
      const networkVerification = verifyXdrNetwork(body.xdr, config.networkPassphrase);
      if (!networkVerification.valid) {
        feeBumpLogger.warn(
          {
            xdr_network: networkVerification.xdrNetwork,
            expected_network: networkVerification.expectedNetwork,
            fee_payer: feePayerAccount.publicKey,
            tenant_id: tenant.id,
          },
          "Network mismatch: XDR is for a different network than the server"
        );
        return next(
          new AppError(networkVerification.errorMessage || "Network mismatch", 400, "NETWORK_MISMATCH")
        );
      }

      // Preflight simulation for Soroban transactions
      const isSoroban = innerTransaction.operations.some(
        (op: any) =>
          ["invokeHostFunction", "extendFootprintTtl", "restoreFootprint"].includes(op.type)
      );

      if (isSoroban) {
        if (!config.stellarRpcUrl) {
          return next(
            new AppError(
              "Soroban transaction requires STELLAR_RPC_URL for preflight simulation",
              500,
              "INTERNAL_ERROR"
            )
          );
        }

        try {
          feeBumpLogger.info(
            {
              fee_payer: feePayerAccount.publicKey,
              tenant_id: tenant.id,
            },
            "Soroban preflight simulation started"
          );
          const updatedXdr = await nativeSigner.preflightSoroban(
            config.stellarRpcUrl,
            body.xdr
          );

          // Use the updated XDR containing returned footprints and corrected resource fees
          innerTransaction = StellarSdk.TransactionBuilder.fromXDR(
            updatedXdr,
            config.networkPassphrase
          ) as any;

          feeBumpLogger.info(
            {
              fee_payer: feePayerAccount.publicKey,
              tenant_id: tenant.id,
            },
            "Soroban preflight simulation succeeded"
          );
        } catch (simError: any) {
          feeBumpLogger.warn(
            {
              ...serializeError(simError),
              fee_payer: feePayerAccount.publicKey,
              tenant_id: tenant.id,
            },
            "Soroban preflight simulation failed"
          );
          // Handle simulation failures as suggested: rejecting the bump request
          return next(
            new AppError(
              `Soroban simulation failed: ${simError.message}. The transaction would fail on-chain or out of gas.`,
              400,
              "INVALID_XDR"
            )
          );
        }
      }

      if (!innerTransaction.signatures || innerTransaction.signatures.length === 0) {
        return next(
          new AppError(
            "Inner transaction must be signed before fee-bumping",
            400,
            "UNSIGNED_TRANSACTION"
          )
        );
      }

      if ("innerTransaction" in innerTransaction) {
        feeBumpLogger.warn(
          {
            fee_payer: feePayerAccount.publicKey,
            tenant_id: tenant.id,
          },
          "Rejected already fee-bumped transaction"
        );
        return next(
          new AppError(
            "Cannot fee-bump an already fee-bumped transaction",
            400,
            "ALREADY_FEE_BUMPED"
          )
        );
      }
      const operationCount = innerTransaction.operations?.length || 0;
      const innerFee = parseInt(innerTransaction.fee || "0", 10);

      const calculatedBaseFee = calculateFeeBumpFee(
        operationCount,
        config.baseFee,
        config.feeMultiplier
      );

      // Fee-bump fee must be higher than the inner transaction fee.
      // For Soroban, the inner transaction fee includes resource fees returned by simulation.
      const feeAmount = Math.max(calculatedBaseFee, innerFee + config.baseFee);

      const quotaCheck = await checkTenantDailyQuota(tenant, feeAmount);

      if (!quotaCheck.allowed) {
        feeBumpLogger.warn(
          {
            attempted_fee_stroops: feeAmount,
            current_spend_stroops: quotaCheck.currentSpendStroops,
            daily_quota_stroops: quotaCheck.dailyQuotaStroops,
            fee_payer: feePayerAccount.publicKey,
            tenant_id: tenant.id,
          },
          "Tenant daily fee sponsorship quota exceeded"
        );
        res.status(403).json({
          error: "Daily fee sponsorship quota exceeded",
          currentSpendStroops: quotaCheck.currentSpendStroops,
          attemptedFeeStroops: feeAmount,
          dailyQuotaStroops: quotaCheck.dailyQuotaStroops,
        });
        return;
      }

      feeBumpLogger.debug({
        operationCount,
        baseFee: config.baseFee,
        multiplier: config.feeMultiplier,
        finalFee: feeAmount,
        fee_payer: feePayerAccount.publicKey,
        inner_fee: innerFee,
        tenant_id: tenant.id,
      }, "Calculated fee bump fee");

      const feeBumpTx = StellarSdk.TransactionBuilder.buildFeeBumpTransaction(
        feePayerAccount.publicKey,
        feeAmount.toString(),
        innerTransaction,
        config.networkPassphrase
      );

      if (feePayerAccount.secretSource.type === "vault") {
        if (!config.vault) {
          return next(
            new AppError(
              "Vault configuration is required for vault-backed fee payers",
              500,
              "INTERNAL_ERROR"
            )
          );
        }

        await signTransactionWithVault(
          feeBumpTx,
          feePayerAccount.publicKey,
          config.vault,
          feePayerAccount.secretSource.secretPath
        );
      } else {
        await signTransaction(feeBumpTx, feePayerAccount.secretSource.secret);
      }

      recordSponsoredTransaction(tenant.id, feeAmount);

      const feeBumpXdr = feeBumpTx.toXDR();
      feeBumpLogger.info(
        {
          fee_payer: feePayerAccount.publicKey,
          final_fee_stroops: feeAmount,
          operation_count: operationCount,
          tenant_id: tenant.id,
        },
        "Fee bump transaction created"
      );

      if (!body.submit) {
        const response: FeeBumpResponse = {
          xdr: feeBumpXdr,
          status: "ready",
          fee_payer: feePayerAccount.publicKey,
        };
        res.json(response);
        return;
      }

      if (config.horizonUrls.length === 0) {
        return next(
          new AppError(
            "Transaction submission requested but no Horizon URLs are configured",
            500,
            "SUBMISSION_FAILED"
          )
        );
      }

      const horizonClient = getHorizonFailoverClient();
      if (!horizonClient) {
        return next(
          new AppError(
            "Horizon failover client is not initialized",
            500,
            "SUBMISSION_FAILED"
          )
        );
      }

      try {
        const submission = await horizonClient.submitTransaction(feeBumpTx);
        transactionStore.addTransaction(submission.result.hash, tenant.id, "submitted");

        const response: FeeBumpResponse = {
          xdr: feeBumpXdr,
          status: "submitted",
          hash: submission.result.hash,
          fee_payer: feePayerAccount.publicKey,
          submitted_via: submission.nodeUrl,
          submission_attempts: submission.attempts,
        };
        feeBumpLogger.info(
          {
            fee_payer: feePayerAccount.publicKey,
            final_fee_stroops: feeAmount,
            node_url: submission.nodeUrl,
            submission_attempts: submission.attempts,
            tenant_id: tenant.id,
            tx_hash: submission.result.hash,
          },
          "Fee bump transaction submitted successfully"
        );
        res.json(response);
      } catch (error: any) {
        feeBumpLogger.error(
          {
            ...serializeError(error),
            fee_payer: feePayerAccount.publicKey,
            final_fee_stroops: feeAmount,
            tenant_id: tenant.id,
          },
          "Fee bump transaction submission failed"
        );
        return next(
          new AppError(
            `Transaction submission failed: ${error.message}`,
            500,
            "SUBMISSION_FAILED"
          )
        );
      }
    } finally {
      await signerLease.release();
    }
  } catch (error) {
    feeBumpLogger.error({ ...serializeError(error) }, "Error processing fee bump request");
    next(error);
  }
}
