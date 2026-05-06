import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { type RawApiKey, generateApiKey } from "../apiKey";
import { JunjoError } from "../errors";
import { type ApiKeyStore, apiKeyMiddleware } from "./apiKey";
import { errorHandler } from "./error";

interface SeededKey {
  raw: RawApiKey;
  gameId: string;
  revokedAt: Date | null;
}

function makeStore(keys: SeededKey[]): ApiKeyStore {
  return {
    findByPrefix: async (prefix) => {
      const hit = keys.find((k) => k.raw.prefix === prefix);
      if (!hit) return null;
      return {
        gameId: hit.gameId,
        hashedSecret: hit.raw.hashedSecret,
        revokedAt: hit.revokedAt,
      };
    },
  };
}

function buildApp(store: ApiKeyStore) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/protected/*", apiKeyMiddleware(store));
  app.get("/protected/whoami", (c) => c.json({ gameId: c.var.gameId }));
  return app;
}

describe("apiKeyMiddleware", () => {
  let valid: SeededKey;
  let revoked: SeededKey;

  beforeAll(async () => {
    valid = { raw: await generateApiKey(), gameId: "game_alpha", revokedAt: null };
    revoked = {
      raw: await generateApiKey(),
      gameId: "game_beta",
      revokedAt: new Date("2026-01-01"),
    };
  });

  it("rejects requests with no Authorization header", async () => {
    const app = buildApp(makeStore([valid]));
    const res = await app.request("/protected/whoami");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_api_key");
  });

  it("rejects a non-Bearer scheme", async () => {
    const app = buildApp(makeStore([valid]));
    const res = await app.request("/protected/whoami", {
      headers: { authorization: `Basic ${valid.raw.full}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed key (no dot)", async () => {
    const app = buildApp(makeStore([valid]));
    const res = await app.request("/protected/whoami", {
      headers: { authorization: "Bearer no_dot_here" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects an unknown prefix", async () => {
    const app = buildApp(makeStore([valid]));
    const res = await app.request("/protected/whoami", {
      headers: { authorization: "Bearer jk_unknown.secretbits" },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong secret for a known prefix", async () => {
    const app = buildApp(makeStore([valid]));
    const res = await app.request("/protected/whoami", {
      headers: { authorization: `Bearer ${valid.raw.prefix}.wrong-secret` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked key even with the correct secret", async () => {
    const app = buildApp(makeStore([revoked]));
    const res = await app.request("/protected/whoami", {
      headers: { authorization: `Bearer ${revoked.raw.full}` },
    });
    expect(res.status).toBe(401);
  });

  it("populates c.var.gameId on a valid key", async () => {
    const app = buildApp(makeStore([valid]));
    const res = await app.request("/protected/whoami", {
      headers: { authorization: `Bearer ${valid.raw.full}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ gameId: "game_alpha" });
  });

  it("propagates non-JunjoError throws to the error handler", async () => {
    const exploding: ApiKeyStore = {
      findByPrefix: async () => {
        throw new Error("db is on fire");
      },
    };
    const app = buildApp(exploding);
    const res = await app.request("/protected/whoami", {
      headers: { authorization: `Bearer ${valid.raw.full}` },
    });
    expect(res.status).toBe(500);
  });

  it("a thrown JunjoError surfaces with its own status", async () => {
    const cranky: ApiKeyStore = {
      findByPrefix: async () => {
        throw new JunjoError("permission_denied", 403, "no");
      },
    };
    const app = buildApp(cranky);
    const res = await app.request("/protected/whoami", {
      headers: { authorization: `Bearer ${valid.raw.full}` },
    });
    expect(res.status).toBe(403);
  });
});
