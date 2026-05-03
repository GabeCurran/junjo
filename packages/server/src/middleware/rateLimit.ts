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
}

export interface ConsumeResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, BucketState>();
  private readonly tokensPerMs: number;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokensPerMs = config.perMinute / 60_000;
  }

  consume(key: string): ConsumeResult {
    const nowMs = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, { tokens: this.config.burst - 1, lastRefillMs: nowMs });
      return { allowed: true };
    }
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    const refilled = Math.min(this.config.burst, bucket.tokens + elapsedMs * this.tokensPerMs);
    if (refilled < 1) {
      // Ceil so a sub-second wait still surfaces as `Retry-After: 1`.
      const msToNextToken = (1 - refilled) / this.tokensPerMs;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil(msToNextToken / 1000)),
      };
    }
    bucket.tokens = refilled - 1;
    bucket.lastRefillMs = nowMs;
    return { allowed: true };
  }

  size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
  }
}

// Buckets on the API key prefix (cheap string op) so noisy keys are
// limited before paying the scrypt-verify cost. Unparseable headers share
// one "anon" bucket so junk traffic cannot blow up the map.
export function resolveBucketKey(authorizationHeader: string | null): string {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) return "anon";
  const raw = authorizationHeader.slice("Bearer ".length).trim();
  const parsed = parseApiKey(raw);
  if (!parsed) return "anon";
  return parsed.prefix;
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

export function rateLimitMiddleware(limiter: RateLimiter | null): MiddlewareHandler {
  return async (c, next) => {
    if (!limiter) {
      await next();
      return;
    }
    const auth = c.req.header("authorization") ?? c.req.header("Authorization") ?? null;
    const key = resolveBucketKey(auth);
    const result = limiter.consume(key);
    if (!result.allowed) {
      c.header("Retry-After", String(result.retryAfterSeconds ?? 1));
      throw Errors.rateLimitExceeded(
        `rate limit exceeded; retry after ${result.retryAfterSeconds ?? 1}s`,
      );
    }
    await next();
  };
}
