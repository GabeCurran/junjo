import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { type RawApiKey, generateApiKey } from "../apiKey";
import { JunjoError } from "../errors";
import { type ApiKeyStore, apiKeyMiddleware } from "./apiKey";
import { errorHandler } from "./error";
import { VerifiedKeyCache, secretDigest } from "./verifiedKeyCache";

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

describe("apiKeyMiddleware verified-key cache", () => {
  interface MutableKey {
    raw: RawApiKey;
    hashedSecret: string;
    revokedAt: Date | null;
  }

  function mutableStore(key: MutableKey): ApiKeyStore {
    return {
      findByPrefix: async (prefix) =>
        prefix === key.raw.prefix
          ? { gameId: "game_gamma", hashedSecret: key.hashedSecret, revokedAt: key.revokedAt }
          : null,
    };
  }

  function appWith(store: ApiKeyStore, cache: VerifiedKeyCache) {
    const app = new Hono();
    app.onError(errorHandler);
    app.use("/protected/*", apiKeyMiddleware(store, { verifiedCache: cache }));
    app.get("/protected/whoami", (c) => c.json({ gameId: c.var.gameId }));
    return app;
  }

  async function call(app: Hono, token: string) {
    return app.request("/protected/whoami", { headers: { authorization: `Bearer ${token}` } });
  }

  it("remembers a verified key and still answers on the next request", async () => {
    const raw = await generateApiKey();
    const key: MutableKey = { raw, hashedSecret: raw.hashedSecret, revokedAt: null };
    const cache = new VerifiedKeyCache();
    const app = appWith(mutableStore(key), cache);
    expect((await call(app, raw.full)).status).toBe(200);
    expect(cache.size()).toBe(1);
    expect((await call(app, raw.full)).status).toBe(200);
  });

  it("refuses a revoked key at once even after it was verified", async () => {
    const raw = await generateApiKey();
    const key: MutableKey = { raw, hashedSecret: raw.hashedSecret, revokedAt: null };
    const app = appWith(mutableStore(key), new VerifiedKeyCache());
    expect((await call(app, raw.full)).status).toBe(200);
    key.revokedAt = new Date();
    const res = await call(app, raw.full);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_api_key");
  });

  it("refuses a wrong secret for a prefix whose real secret is cached", async () => {
    const raw = await generateApiKey();
    const key: MutableKey = { raw, hashedSecret: raw.hashedSecret, revokedAt: null };
    const app = appWith(mutableStore(key), new VerifiedKeyCache());
    expect((await call(app, raw.full)).status).toBe(200);
    expect((await call(app, `${raw.prefix}.not-the-secret`)).status).toBe(401);
    expect((await call(app, raw.full)).status).toBe(200);
  });

  it("stops accepting the old secret once the stored hash changes", async () => {
    const raw = await generateApiKey();
    const key: MutableKey = { raw, hashedSecret: raw.hashedSecret, revokedAt: null };
    const app = appWith(mutableStore(key), new VerifiedKeyCache());
    expect((await call(app, raw.full)).status).toBe(200);
    const replacement = await generateApiKey();
    key.hashedSecret = replacement.hashedSecret;
    expect((await call(app, raw.full)).status).toBe(401);
    expect((await call(app, `${raw.prefix}.${replacement.secret}`)).status).toBe(200);
  });

  it("re-verifies after the entry expires", async () => {
    let now = 1_000;
    const cache = new VerifiedKeyCache({ ttlMs: 100, now: () => now });
    const digest = secretDigest("s");
    cache.remember("p", digest, "h");
    expect(cache.matches("p", digest, "h")).toBe(true);
    now += 100;
    expect(cache.matches("p", digest, "h")).toBe(false);
    expect(cache.size()).toBe(0);
  });

  it("evicts the least recently used entry past the cap", () => {
    const cache = new VerifiedKeyCache({ maxEntries: 2 });
    const d = secretDigest("s");
    cache.remember("a", d, "h");
    cache.remember("b", d, "h");
    expect(cache.matches("a", d, "h")).toBe(true);
    cache.remember("c", d, "h");
    expect(cache.size()).toBe(2);
    expect(cache.matches("b", d, "h")).toBe(false);
    expect(cache.matches("a", d, "h")).toBe(true);
    expect(cache.matches("c", d, "h")).toBe(true);
  });
});
