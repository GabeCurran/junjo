import type { MiddlewareHandler } from "hono";
import { parseApiKey, verifySecret } from "../apiKey.js";
import { Errors } from "../errors.js";

// Tests pass an in-memory fake; routes get the real Prisma client.
export interface ApiKeyStore {
  findByPrefix(
    prefix: string,
  ): Promise<{ gameId: string; hashedSecret: string; revokedAt: Date | null } | null>;
}

declare module "hono" {
  interface ContextVariableMap {
    gameId: string;
    // The authenticated key's unique prefix, kept in scope so long-lived
    // handlers (e.g. the SSE stream) can re-check the key's revocation
    // state after connect with a single indexed lookup.
    apiKeyPrefix: string;
  }
}

export function apiKeyMiddleware(store: ApiKeyStore): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!auth || !auth.startsWith("Bearer ")) {
      throw Errors.invalidApiKey("missing or malformed Authorization header");
    }
    const raw = auth.slice("Bearer ".length).trim();
    const parsed = parseApiKey(raw);
    if (!parsed) throw Errors.invalidApiKey("malformed API key");

    const record = await store.findByPrefix(parsed.prefix);
    if (!record) throw Errors.invalidApiKey("unknown API key");
    if (record.revokedAt) throw Errors.invalidApiKey("API key revoked");

    const ok = await verifySecret(parsed.secret, record.hashedSecret);
    if (!ok) throw Errors.invalidApiKey("invalid API key");

    c.set("gameId", record.gameId);
    c.set("apiKeyPrefix", parsed.prefix);
    await next();
  };
}
