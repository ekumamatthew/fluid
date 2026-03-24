import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { loadConfig } from "./config";
import { feeBumpHandler } from "./handlers/feeBump";
import { initializeLedgerMonitor } from "./workers/ledgerMonitor";
import { transactionStore } from "./workers/transactionStore";

dotenv.config();

const app = express();
app.use(express.json());

const config = loadConfig();

app.get("/health", (req: Request, res: Response) => {
  res.json({ status: "ok" });
});

app.post("/fee-bump", (req: Request, res: Response) => {
  feeBumpHandler(req, res, config);
});

// Test endpoint to manually add a pending transaction
app.post("/test/add-transaction", (req: Request, res: Response) => {
  const { hash, status = "pending" } = req.body;
  if (!hash) {
    return res.status(400).json({ error: "Transaction hash is required" });
  }
  transactionStore.addTransaction(hash, status);
  res.json({ message: `Transaction ${hash} added with status ${status}` });
});

// Test endpoint to view all transactions
app.get("/test/transactions", (req: Request, res: Response) => {
  const transactions = transactionStore.getAllTransactions();
  res.json({ transactions });
});

const PORT = process.env.PORT || 3000;

// Initialize ledger monitor worker if Horizon URL is configured
let ledgerMonitor: any = null;
if (config.horizonUrl) {
  try {
    ledgerMonitor = initializeLedgerMonitor(config);
    ledgerMonitor.start();
    console.log("Ledger monitor worker started");
  } catch (error) {
    console.error("Failed to start ledger monitor:", error);
  }
} else {
  console.log("No Horizon URL configured - ledger monitor disabled");
}

app.listen(PORT, () => {
  console.log(`Fluid server running on http://0.0.0.0:${PORT}`);
  console.log(`Fee payer: ${config.feePayerPublicKey}`);
});
