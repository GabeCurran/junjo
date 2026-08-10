import { getConnInfo } from "@hono/node-server/conninfo";
import type { MiddlewareHandler } from "hono";
import { parseApiKey } from "../apiKey.js";
import { Errors } from "../errors.js";

export interface RateLimitConfig {
  perMinute: number;
  burst: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
  // Capacity multiplier the bucket was created with; undefined = 1.
  scale?: number;
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

// Map size at which the next consume() triggers a sweep. Sized so the
// sweep cost (one map iteration) is amortized across thousands of
// allowed requests, and so the steady-state map fits comfortably in
// memory even when keys are user-controlled (e.g. the passcode limiter
// keys on `${groupId}:${userId}` -- bounded by total joining users
// across all gated groups in this process).
const DEFAULT_BUCKET_EVICTION_THRESHOLD = 10_000;

// Minimum gap between O(n) eviction sweeps. Without it, holding the map
// at the threshold (cheap with attacker-controlled keys) makes every
// subsequent consume pay a full-map scan; with it, the worst case is
// one scan per interval and the map overshoot between sweeps is
// bounded by the request rate times the interval.
const MIN_SWEEP_INTERVAL_MS = 1_000;

export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly tokensPerMs: number;
  private readonly evictionThreshold: number;
  private lastSweepMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
    opts?: { evictionThreshold?: number },
  ) {
    this.tokensPerMs = config.perMinute / 60_000;
    this.evictionThreshold = opts?.evictionThreshold ?? DEFAULT_BUCKET_EVICTION_THRESHOLD;
  }

  // `scale` multiplies the configured burst + refill for this key's
  // bucket. The shared per-source buckets use a scale > 1 so one
  // address carrying many API keys (NAT, dashboard SSR) is not held to
  // a single key's budget, while still bounding what any one source
  // can mint by rotating fabricated credentials.
  consume(key: string, scale = 1): ConsumeResult {
    const nowMs = this.now();
    // Amortized sweep before insert keeps the map bounded under
    // adversarial input. Evicts buckets whose tokens have refilled
    // back to capacity -- those are equivalent to "no bucket exists"
    // (next consume would create a fresh one in the same state).
    if (
      this.buckets.size >= this.evictionThreshold &&
      nowMs - this.lastSweepMs >= MIN_SWEEP_INTERVAL_MS
    ) {
      this.lastSweepMs = nowMs;
      this.evictRefilledBuckets(nowMs);
    }
    const capacity = this.config.burst * scale;
    const refillPerMs = this.tokensPerMs * scale;
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: capacity - 1, lastRefillMs: nowMs, scale });
      return { allowed: true };
    }
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    const refilled = Math.min(capacity, bucket.tokens + elapsedMs * refillPerMs);
    if (refilled < 1) {
      // Ceil so a sub-second wait still surfaces as `Retry-After: 1`.
      const msToNextToken = (1 - refilled) / refillPerMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(msToNextToken / 1000)),
      };
    }
    bucket.tokens = refilled - 1;
    bucket.lastRefillMs = nowMs;
    return { allowed: true };
  }

  // Walks the map and removes buckets whose tokens have refilled to
  // capacity at `nowMs`. Safe because a fully-refilled bucket is
  // observationally identical to a missing bucket -- the next consume
  // for that key creates a fresh one with `capacity-1` tokens, same as
  // it would have done after evicting and re-inserting. O(n) over the
  // map size; fires at most once per MIN_SWEEP_INTERVAL_MS and only
  // when `size >= evictionThreshold`.
  private evictRefilledBuckets(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      const scale = bucket.scale ?? 1;
      const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
      const refilled = bucket.tokens + elapsedMs * this.tokensPerMs * scale;
      if (refilled >= this.config.burst * scale) {
        this.buckets.delete(key);
      }
    }
  }

  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }
}

// The shared per-source bucket gets this multiple of the per-key
// budget. Sized so many legitimate API keys behind one NAT egress (a
// dedicated-server fleet, dashboard SSR fan-out) fit comfortably,
// while one source rotating fabricated credentials is still bounded.
export const SOURCE_BUCKET_SCALE = 20;

// Extracts the API-key prefix from an Authorization header when one is
// present and parseable; a cheap string op, no verification.
export function parseBearerPrefix(authorizationHeader: string | null): string | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const raw = authorizationHeader.slice("Bearer ".length).trim();
  return parseApiKey(raw)?.prefix ?? null;
}

// Resolves the address the limiter treats as "the source".
//
// trustProxy=true: takes the RIGHTMOST x-forwarded-for hop, the one
// value appended by the closest proxy that the client cannot forge
// (leftmost hops are client-supplied and must never be used for
// limiting). Correct for Railway and any standard appending LB.
//
// trustProxy=false (default): ignores x-forwarded-for entirely, since
// with no trusted proxy the whole header is client-controlled, and
// uses the socket address the caller passes in.
export function resolveClientIp(
  forwardedFor: string | null,
  trustProxy: boolean,
  socketAddress: string | null,
): string {
  if (trustProxy && forwardedFor) {
    const hops = forwardedFor.split(",");
    const rightmost = hops[hops.length - 1]?.trim();
    if (rightmost) return rightmost;
  }
  return socketAddress?.trim() || "direct";
}

// Returns null when rate limiting is disabled. `rateLimitMiddleware`
// short-circuits to a no-op when its limiter is null.
export function buildRateLimiter(
  config: { perMinute?: number; burst?: number } | null | undefined,
): RateLimiter | null {
  if (!config) return null;
  const perMinute = config.perMinute ?? 0;
  const burst = config.burst ?? 0;
  if (perMinute <= 0 || burst <= 0) return null;
  return new RateLimiter({ perMinute, burst });
}

export interface RateLimitMiddlewareOptions {
  // Whether a trusted proxy fronts this deployment and appends the
  // client address to x-forwarded-for. Wired from TRUST_PROXY.
  trustProxy?: boolean;
  // Socket-address extractor, injectable for tests. Defaults to the
  // node-server conninfo; returns null in environments with no socket
  // (app.request in tests).
  socketAddress?: (c: Parameters<MiddlewareHandler>[0]) => string | null;
}

function defaultSocketAddress(c: Parameters<MiddlewareHandler>[0]): string | null {
  try {
    return getConnInfo(c).remote.address ?? null;
  } catch {
    return null;
  }
}

// Every request drains the shared per-source bucket (scaled capacity),
// so junk traffic cannot mint fresh budgets by rotating fabricated
// Bearer prefixes or spoofed forwarded headers. Requests carrying a
// parseable API key ALSO drain that prefix's bucket: per-key fairness,
// enforced before the scrypt verify cost, exactly as before.
export function rateLimitMiddleware(
  limiter: RateLimiter | null,
  opts: RateLimitMiddlewareOptions = {},
): MiddlewareHandler {
  const trustProxy = opts.trustProxy ?? false;
  const socketAddress = opts.socketAddress ?? defaultSocketAddress;
  return async (c, next) => {
    if (!limiter) {
      await next();
      return;
    }
    const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? null;
    const forwardedFor = c.req.header("x-forwarded-for") ?? null;
    const ip = resolveClientIp(forwardedFor, trustProxy, socketAddress(c));

    const sourceResult = limiter.consume(`ip:${ip}`, SOURCE_BUCKET_SCALE);
    const prefix = parseBearerPrefix(auth);
    const prefixResult = prefix ? limiter.consume(prefix) : { allowed: true as const };

    if (!sourceResult.allowed || !prefixResult.allowed) {
      const retryAfter = Math.max(
        sourceResult.allowed ? 0 : (sourceResult.retryAfterSeconds ?? 1),
        prefixResult.allowed ? 0 : (prefixResult.retryAfterSeconds ?? 1),
        1,
      );
      c.header("Retry-After", String(retryAfter));
      throw Errors.rateLimitExceeded(`rate limit exceeded; retry after ${retryAfter}s`);
    }
    await next();
  };
}
