import { Request, Response } from "express";
import {
  ApiKeyConfig,
  upsertApiKey,
  deleteApiKey,
  listApiKeys,
} from "../middleware/apiKeys";
import { setCachedApiKey, invalidateApiKeyCache } from "../utils/redis";

// Note: These admin endpoints are intentionally minimal — secure them in production.

export function listApiKeysHandler(req: Request, res: Response) {
  const token = req.header("x-admin-token");
  const expected = process.env.FLUID_ADMIN_TOKEN;

  if (!expected || token !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const keys = listApiKeys();
  // Mask the key in responses
  const masked = keys.map((k) => ({
    key: `${k.key.slice(0, 4)}...${k.key.slice(-4)}`,
    tenantId: k.tenantId,
    name: k.name,
    tier: k.tier,
    maxRequests: k.maxRequests,
    windowMs: k.windowMs,
  }));

  res.json({ keys: masked });
}

export async function upsertApiKeyHandler(req: Request, res: Response) {
  const payload = req.body as ApiKeyConfig | undefined;

  if (!payload || typeof payload.key !== "string") {
    res.status(400).json({ error: "Invalid payload; expected ApiKeyConfig" });
    return;
  }

  // Update the in-memory map in apiKeys.ts by importing the module and setting directly.
  // This file intentionally keeps the API_KEYS map private; instead, we simulate update by caching the updated config.
  const token = req.header("x-admin-token");
  const expected = process.env.FLUID_ADMIN_TOKEN;

  if (!expected || token !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // Update in-memory store and cache
    upsertApiKey(payload);
    res
      .status(200)
      .json({ message: "API key upserted and cached", key: payload.key });
  } catch (err) {
    res.status(500).json({ error: "Failed to upsert API key" });
  }
}

export async function revokeApiKeyHandler(req: Request, res: Response) {
  const { key } = req.params;

  if (!key) {
    res.status(400).json({ error: "Key param required" });
    return;
  }

  const token = req.header("x-admin-token");
  const expected = process.env.FLUID_ADMIN_TOKEN;

  if (!expected || token !== expected) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    // Remove from in-memory map and invalidate cache for this key so future validations re-check the DB/source
    deleteApiKey(key);
    await invalidateApiKeyCache(key);

    res
      .status(200)
      .json({ message: `API key ${key} revoked (cache invalidated)` });
  } catch (err) {
    res.status(500).json({ error: "Failed to revoke API key" });
  }
}
