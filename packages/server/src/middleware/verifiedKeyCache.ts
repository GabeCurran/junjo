import { createHash, timingSafeEqual } from "node:crypto";

// Remembers API keys whose secret already passed the slow hash check, so
// a repeat request with the same key skips it. An entry holds the
// SHA-256 of the secret (never the secret) together with the stored hash
// it was checked against. A hit requires both to match the current
// request and the current stored row, so a changed stored hash makes
// the entry useless at once. Revocation is still read from the row on
// every request; this cache only replaces the hash computation.
//
// Bounded by entry count with least-recently-used eviction, and every
// entry expires after `ttlMs`.

export const VERIFIED_KEY_CACHE_MAX_ENTRIES = 10_000;
export const VERIFIED_KEY_CACHE_TTL_MS = 5 * 60 * 1000;

interface Entry {
  secretDigest: Buffer;
  hashedSecret: string;
  expiresAt: number;
}

export interface VerifiedKeyCacheOptions {
  maxEntries?: number;
  ttlMs?: number;
  now?: () => number;
}

export function secretDigest(secret: string): Buffer {
  return createHash("sha256").update(secret, "utf8").digest();
}

export class VerifiedKeyCache {
  private readonly entries = new Map<string, Entry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: VerifiedKeyCacheOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? VERIFIED_KEY_CACHE_MAX_ENTRIES);
    this.ttlMs = opts.ttlMs ?? VERIFIED_KEY_CACHE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  // True when `digest` was verified for `prefix` against exactly
  // `hashedSecret` and the entry has not expired.
  matches(prefix: string, digest: Buffer, hashedSecret: string): boolean {
    const entry = this.entries.get(prefix);
    if (!entry) return false;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(prefix);
      return false;
    }
    if (entry.hashedSecret !== hashedSecret) return false;
    if (entry.secretDigest.length !== digest.length) return false;
    if (!timingSafeEqual(entry.secretDigest, digest)) return false;
    // Re-inserting moves the key to the most recently used end.
    this.entries.delete(prefix);
    this.entries.set(prefix, entry);
    return true;
  }

  remember(prefix: string, digest: Buffer, hashedSecret: string): void {
    this.entries.delete(prefix);
    this.entries.set(prefix, {
      secretDigest: digest,
      hashedSecret,
      expiresAt: this.now() + this.ttlMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  forget(prefix: string): void {
    this.entries.delete(prefix);
  }

  size(): number {
    return this.entries.size;
  }
}
