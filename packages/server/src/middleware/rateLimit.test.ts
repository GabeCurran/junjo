import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { type RawApiKey, generateApiKey } from "../apiKey";
import { createApp } from "../app";
import { errorHandler } from "./error";
import {
  RateLimiter,
  SOURCE_BUCKET_SCALE,
  buildRateLimiter,
  parseBearerPrefix,
  rateLimitMiddleware,
  resolveClientIp,
} from "./rateLimit";

describe("RateLimiter", () => {
  it("allows the first request and tracks the key in its bucket map", () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 10 }, () => 1_000);
    const result = limiter.consume("key-a");
    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBeUndefined();
    expect(limiter.size()).toBe(1);
  });

  it("rejects requests once the bucket is empty", () => {
    let now = 1_000;
    const limiter = new RateLimiter({ perMinute: 60, burst: 3 }, () => now);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(true);
    const fourth = limiter.consume("k");
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    // Time advances: at 1 token/sec, 1s later we have 1 token.
    now += 1_000;
    expect(limiter.consume("k").allowed).toBe(true);
  });

  it("refills at the configured rate up to the burst cap", () => {
    let now = 0;
    const limiter = new RateLimiter({ perMinute: 60, burst: 5 }, () => now);
    // Drain the bucket.
    for (let i = 0; i < 5; i++) expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(false);
    // Advance an hour: bucket should cap at burst (5), not 60.
    now = 60 * 60_000;
    for (let i = 0; i < 5; i++) expect(limiter.consume("k").allowed).toBe(true);
    expect(limiter.consume("k").allowed).toBe(false);
  });

  it("isolates buckets per key", () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 2 }, () => 0);
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    // Other keys are unaffected.
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("b").allowed).toBe(true);
    expect(limiter.consume("b").allowed).toBe(false);
  });

  it("computes Retry-After by rounding up sub-second waits to 1", () => {
    let now = 0;
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => now);
    expect(limiter.consume("k").allowed).toBe(true);
    // 100ms later, still under one token. Refill rate is 1 token/sec; we
    // have ~0.1 tokens, need 0.9 more = 900ms. Ceil(900/1000) = 1.
    now = 100;
    const result = limiter.consume("k");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("computes Retry-After for multi-second waits", () => {
    const now = 0;
    const limiter = new RateLimiter({ perMinute: 6, burst: 1 }, () => now);
    expect(limiter.consume("k").allowed).toBe(true);
    // Refill rate: 6/min = 0.1 tokens/sec; 1 token = 10s.
    const result = limiter.consume("k");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(10);
  });

  it("reset() clears every bucket", () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    limiter.consume("a");
    limiter.consume("b");
    expect(limiter.size()).toBe(2);
    limiter.reset();
    expect(limiter.size()).toBe(0);
    // Subsequent consume on the same key starts fresh (full bucket - 1).
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("clamps negative time deltas to zero (defensive against clock skew)", () => {
    let now = 1_000;
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => now);
    expect(limiter.consume("k").allowed).toBe(true);
    // Time goes backward (clock skew or test seam). Bucket should not
    // refill negatively.
    now = 0;
    const result = limiter.consume("k");
    expect(result.allowed).toBe(false);
  });

  describe("bucket eviction", () => {
    it("evicts fully-refilled buckets once size hits the threshold", () => {
      let now = 0;
      const limiter = new RateLimiter({ perMinute: 60, burst: 5 }, () => now, {
        evictionThreshold: 3,
      });
      // Touch 3 distinct keys to seed buckets at burst-1=4 tokens each.
      limiter.consume("idle-a");
      limiter.consume("idle-b");
      limiter.consume("idle-c");
      expect(limiter.size()).toBe(3);
      // Skip forward enough that all three buckets refill to capacity.
      // refill rate = 1/sec, so 5s gets every bucket back to burst.
      now += 5_000;
      // The next consume triggers a sweep BEFORE inserting "fresh".
      limiter.consume("fresh");
      // The three idle buckets were fully refilled and got evicted; the
      // newly-inserted "fresh" bucket survives.
      expect(limiter.size()).toBe(1);
    });

    it("does not evict partially-drained buckets even when over threshold", () => {
      let now = 0;
      const limiter = new RateLimiter({ perMinute: 60, burst: 5 }, () => now, {
        evictionThreshold: 2,
      });
      // Drain one bucket: 5 consumes -> bucket sitting at 0 tokens.
      for (let i = 0; i < 5; i++) limiter.consume("hot");
      // Seed a second bucket so size hits the threshold.
      limiter.consume("warm");
      expect(limiter.size()).toBe(2);
      // Inserting a third key triggers the sweep. Only ~0.1s have
      // elapsed in fake time -- neither existing bucket has refilled
      // back to burst, so neither should be evicted.
      now += 100;
      limiter.consume("new");
      expect(limiter.size()).toBe(3);
      // Confirm "hot" still remembers it was drained: should reject.
      expect(limiter.consume("hot").allowed).toBe(false);
    });
  });
});

describe("buildRateLimiter", () => {
  it("returns null when config is null", () => {
    expect(buildRateLimiter(null)).toBeNull();
  });

  it("returns null when config is undefined", () => {
    expect(buildRateLimiter(undefined)).toBeNull();
  });

  it("returns null when perMinute is zero (env-var disable signal)", () => {
    expect(buildRateLimiter({ perMinute: 0, burst: 100 })).toBeNull();
  });

  it("returns null when burst is zero", () => {
    expect(buildRateLimiter({ perMinute: 600, burst: 0 })).toBeNull();
  });

  it("returns null when both are zero", () => {
    expect(buildRateLimiter({ perMinute: 0, burst: 0 })).toBeNull();
  });

  it("returns a working limiter when both are positive", () => {
    const limiter = buildRateLimiter({ perMinute: 60, burst: 5 });
    expect(limiter).not.toBeNull();
    expect(limiter?.consume("k").allowed).toBe(true);
  });

  it("treats a missing field as zero (disabled)", () => {
    expect(buildRateLimiter({ perMinute: 600 })).toBeNull();
    expect(buildRateLimiter({ burst: 100 })).toBeNull();
  });
});

describe("parseBearerPrefix", () => {
  it("returns null for null / empty / non-Bearer / malformed values", () => {
    expect(parseBearerPrefix(null)).toBeNull();
    expect(parseBearerPrefix("")).toBeNull();
    expect(parseBearerPrefix("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearerPrefix("Bearer no_dot_here")).toBeNull();
  });

  it("returns the prefix for a parseable Bearer key", () => {
    expect(parseBearerPrefix("Bearer jk_someprefix.somesecret")).toBe("jk_someprefix");
  });

  it("trims whitespace around the bearer value", () => {
    expect(parseBearerPrefix("Bearer    jk_a.b   ")).toBe("jk_a");
  });
});

describe("resolveClientIp", () => {
  it("uses the socket address when no proxy is trusted, ignoring x-forwarded-for", () => {
    // The whole header is client-controlled without a trusted proxy;
    // honoring any hop of it would let callers mint fresh buckets.
    expect(resolveClientIp("6.6.6.6", false, "203.0.113.9")).toBe("203.0.113.9");
    expect(resolveClientIp(null, false, "203.0.113.9")).toBe("203.0.113.9");
  });

  it("falls back to direct when no socket address is known", () => {
    expect(resolveClientIp(null, false, null)).toBe("direct");
    expect(resolveClientIp("6.6.6.6", false, null)).toBe("direct");
  });

  it("uses the RIGHTMOST x-forwarded-for hop when the proxy is trusted", () => {
    // The rightmost hop is appended by the closest trusted proxy; the
    // leftmost hops are client-supplied and forgeable.
    expect(resolveClientIp("203.0.113.9", true, "10.0.0.1")).toBe("203.0.113.9");
    expect(resolveClientIp("6.6.6.6, 203.0.113.9", true, "10.0.0.1")).toBe("203.0.113.9");
  });

  it("falls back to the socket when trusted but the header is absent or blank", () => {
    expect(resolveClientIp(null, true, "10.0.0.1")).toBe("10.0.0.1");
    expect(resolveClientIp("   ", true, "10.0.0.1")).toBe("10.0.0.1");
  });
});

function buildApp(limiter: RateLimiter | null) {
  const app = new Hono();
  app.onError(errorHandler);
  app.use("/protected/*", rateLimitMiddleware(limiter));
  app.get("/protected/echo", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitMiddleware", () => {
  let valid: RawApiKey;

  beforeAll(async () => {
    valid = await generateApiKey();
  });

  it("is a no-op when limiter is null (rate limiting disabled)", async () => {
    const app = buildApp(null);
    for (let i = 0; i < 50; i++) {
      const res = await app.request("/protected/echo", {
        headers: { authorization: `Bearer ${valid.full}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("lets requests through under the limit", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 5 }, () => 0);
    const app = buildApp(limiter);
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/protected/echo", {
        headers: { authorization: `Bearer ${valid.full}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 with Retry-After once the bucket is empty", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 2 }, () => 0);
    const app = buildApp(limiter);
    await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    const blocked = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const body = (await blocked.json()) as { code: string; status: number; message: string };
    expect(body.code).toBe("rate_limit_exceeded");
    expect(body.status).toBe(429);
    expect(body.message).toMatch(/rate limit exceeded/);
  });

  it("buckets per API key prefix - different keys do not share a bucket", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = buildApp(limiter);
    const other = await generateApiKey();
    const a = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    expect(a.status).toBe(200);
    // Same key is now over its limit.
    const aBlocked = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    expect(aBlocked.status).toBe(429);
    // A different key still gets its full burst.
    const b = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${other.full}` },
    });
    expect(b.status).toBe(200);
  });

  it("keyless traffic shares one scaled source bucket", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = buildApp(limiter);
    // Source-bucket capacity is burst * SOURCE_BUCKET_SCALE.
    for (let i = 0; i < SOURCE_BUCKET_SCALE; i++) {
      expect((await app.request("/protected/echo")).status).toBe(200);
    }
    const blocked = await app.request("/protected/echo");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("rotating fabricated Bearer prefixes cannot mint fresh budgets", async () => {
    // Regression: prefix buckets used to be handed to ANY dotted Bearer
    // value, so rotating junk prefixes bypassed the source limit.
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = buildApp(limiter);
    let blocked = 0;
    for (let i = 0; i < SOURCE_BUCKET_SCALE + 5; i++) {
      const res = await app.request("/protected/echo", {
        headers: { authorization: `Bearer fake${i}.secret` },
      });
      if (res.status === 429) blocked++;
    }
    expect(blocked).toBeGreaterThanOrEqual(5);
  });

  it("burst absorbs spikes up to the burst cap", async () => {
    let now = 0;
    const limiter = new RateLimiter({ perMinute: 60, burst: 10 }, () => now);
    const app = buildApp(limiter);
    // Fire 10 back-to-back at t=0, all should pass.
    for (let i = 0; i < 10; i++) {
      const res = await app.request("/protected/echo", {
        headers: { authorization: `Bearer ${valid.full}` },
      });
      expect(res.status).toBe(200);
    }
    // 11th at t=0 is over the burst.
    const blocked = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    expect(blocked.status).toBe(429);
    // Advance 1 second: 1 token refilled (at 60/min).
    now = 1_000;
    const allowed = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    expect(allowed.status).toBe(200);
  });

  it("Retry-After value is a positive integer in seconds", async () => {
    const limiter = new RateLimiter({ perMinute: 6, burst: 1 }, () => 0);
    const app = buildApp(limiter);
    await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    const blocked = await app.request("/protected/echo", {
      headers: { authorization: `Bearer ${valid.full}` },
    });
    expect(blocked.status).toBe(429);
    const retryAfter = blocked.headers.get("retry-after");
    expect(retryAfter).not.toBeNull();
    const seconds = Number(retryAfter);
    expect(Number.isInteger(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(1);
  });
});

// The limiter registers ahead of every /v1 route, so the admin-token
// surface and the unauthenticated invitation preview are covered, not
// just per-game-key routes. These tests never reach a handler that
// touches the database: the admin requests fail auth (401) and the
// preview lookup uses a stub that returns null (404). Both still
// consume rate-limit tokens, which is the point.
describe("app-wide rate limit coverage", () => {
  const prismaStub = {
    invitation: { findUnique: async () => null },
  } as unknown as PrismaClient;

  it("limits admin-token routes per source", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = createApp({
      prisma: prismaStub,
      rateLimit: limiter,
      adminToken: "test-admin-token-rate-limit",
    });
    const headers = { authorization: "Bearer wrong-token" };
    for (let i = 0; i < SOURCE_BUCKET_SCALE; i++) {
      expect((await app.request("/v1/admin/stats", { headers })).status).toBe(401);
    }
    const blocked = await app.request("/v1/admin/stats", { headers });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
  });

  it("limits the unauthenticated invitation preview", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = createApp({ prisma: prismaStub, rateLimit: limiter });
    for (let i = 0; i < SOURCE_BUCKET_SCALE; i++) {
      expect((await app.request("/v1/invitations/nope")).status).toBe(404);
    }
    expect((await app.request("/v1/invitations/nope")).status).toBe(429);
  });

  it("separates keyless buckets by trusted forwarded IP (rightmost hop)", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = createApp({ prisma: prismaStub, rateLimit: limiter, trustProxy: true });
    const from = (xff: string) => ({ headers: { "x-forwarded-for": xff } });
    for (let i = 0; i < SOURCE_BUCKET_SCALE; i++) {
      expect((await app.request("/v1/invitations/nope", from("203.0.113.9"))).status).toBe(404);
    }
    expect((await app.request("/v1/invitations/nope", from("203.0.113.9"))).status).toBe(429);
    // Spoofing a leftmost hop while the rightmost stays the same does
    // NOT mint a fresh bucket.
    expect((await app.request("/v1/invitations/nope", from("6.6.6.6, 203.0.113.9"))).status).toBe(
      429,
    );
    // A genuinely different client (different rightmost hop) keeps its
    // own budget.
    expect((await app.request("/v1/invitations/nope", from("198.51.100.4"))).status).toBe(404);
  });

  it("ignores x-forwarded-for entirely when no proxy is trusted", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 1 }, () => 0);
    const app = createApp({ prisma: prismaStub, rateLimit: limiter });
    const from = (xff: string) => ({ headers: { "x-forwarded-for": xff } });
    // All requests share the direct bucket regardless of header games.
    for (let i = 0; i < SOURCE_BUCKET_SCALE; i++) {
      expect((await app.request("/v1/invitations/nope", from(`10.0.0.${i}`))).status).toBe(404);
    }
    expect((await app.request("/v1/invitations/nope", from("10.9.9.9"))).status).toBe(429);
  });
});
