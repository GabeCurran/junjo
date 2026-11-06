import type { PartialGameConfig } from "@junjo.io/shared";
import type { MiddlewareHandler } from "hono";
import { parseApiKey, verifySecret } from "../apiKey.js";
import { resolveGameConfig } from "../config/defaults.js";
import { Errors } from "../errors.js";
import { currentRequestContext } from "../requestContext.js";

export interface ApiKeyRecord {
  gameId: string;
  hashedSecret: string;
  revokedAt: Date | null;
  // Optional so in-memory test stores can omit them; absent means no
  // attribution, no namespace preference and no declared formats.
  id?: string;
  preferredNamespaces?: string[];
  // The owning game's stored config, read in the same lookup.
  gameConfig?: unknown;
}

// Tests pass an in-memory fake; routes get the real Prisma client.
export interface ApiKeyStore {
  findByPrefix(prefix: string): Promise<ApiKeyRecord | null>;
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
    const ctx = currentRequestContext();
    if (ctx) {
      ctx.apiKeyId = record.id ?? null;
      ctx.preferredNamespaces = record.preferredNamespaces ?? [];
      if (record.gameConfig !== undefined) {
        ctx.idFormats.set(
          record.gameId,
          resolveGameConfig(record.gameConfig as PartialGameConfig | null).identity.formats,
        );
      }
    }
    await next();
  };
}
