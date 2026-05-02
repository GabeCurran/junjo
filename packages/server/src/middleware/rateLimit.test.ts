import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import { type RawApiKey, generateApiKey } from "../apiKey";
import { errorHandler } from "./error";
import { RateLimiter, buildRateLimiter, rateLimitMiddleware, resolveBucketKey } from "./rateLimit";

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

describe("resolveBucketKey", () => {
  it("returns 'anon' for null", () => {
    expect(resolveBucketKey(null)).toBe("anon");
  });

  it("returns 'anon' for an empty string", () => {
    expect(resolveBucketKey("")).toBe("anon");
  });

  it("returns 'anon' for a non-Bearer scheme", () => {
    expect(resolveBucketKey("Basic dXNlcjpwYXNz")).toBe("anon");
  });

  it("returns 'anon' for a malformed key (no dot)", () => {
    expect(resolveBucketKey("Bearer no_dot_here")).toBe("anon");
  });

  it("returns the prefix for a parseable Bearer key", () => {
    expect(resolveBucketKey("Bearer jk_someprefix.somesecret")).toBe("jk_someprefix");
  });

  it("trims whitespace around the bearer value", () => {
    expect(resolveBucketKey("Bearer    jk_a.b   ")).toBe("jk_a");
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

  it("falls back to the 'anon' bucket when no Authorization header is present", async () => {
    const limiter = new RateLimiter({ perMinute: 60, burst: 2 }, () => 0);
    const app = buildApp(limiter);
    expect((await app.request("/protected/echo")).status).toBe(200);
    expect((await app.request("/protected/echo")).status).toBe(200);
    const blocked = await app.request("/protected/echo");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
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
