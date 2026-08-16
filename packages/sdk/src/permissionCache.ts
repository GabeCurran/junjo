import type { PermissionCheckResult } from "@junjo.io/shared";

/**
 * Default time a permission answer is reused, in milliseconds. Short
 * enough that a revoked grant stops working almost immediately, long
 * enough to collapse the burst of identical checks a realtime app
 * issues when many subscribers reconnect at once.
 */
export const DEFAULT_PERMISSION_CACHE_TTL_MS = 5000;

/** Default number of distinct answers retained before eviction. */
export const DEFAULT_PERMISSION_CACHE_MAX_ENTRIES = 5000;

/** Options for the client-side permission cache. */
export interface PermissionCacheOptions {
  /** Set false to resolve every check against the server. */
  enabled?: boolean;
  /** Overrides {@link DEFAULT_PERMISSION_CACHE_TTL_MS}. */
  ttlMs?: number;
  /** Overrides {@link DEFAULT_PERMISSION_CACHE_MAX_ENTRIES}. */
  maxEntries?: number;
  /**
   * Keep serving an expired answer when the server answers 429. A
   * rate-limited check would otherwise surface as a denial, which reads
   * as an authorization bug rather than a throttling one. Entries are
   * served stale for at most {@link staleWhileRateLimitedMs} past their
   * TTL. Set false to let the 429 propagate.
   */
  serveStaleOnRateLimit?: boolean;
  /** How far past the TTL a stale answer may still be served. */
  staleWhileRateLimitedMs?: number;
  /** Injectable clock. */
  now?: () => number;
}

interface CacheEntry {
  result: PermissionCheckResult;
  expiresAt: number;
  staleUntil: number;
}

export const DEFAULT_STALE_WHILE_RATE_LIMITED_MS = 60_000;

/**
 * Bounded TTL cache over permission answers, keyed by the exact tuple
 * that produced them.
 *
 * Insertion-ordered eviction rather than true LRU: `Map` preserves
 * insertion order, so the oldest key is the first one iteration yields.
 * A hit does not reorder, which keeps reads allocation-free at the cost
 * of evicting a hot-but-old key occasionally. Entries expire on a short
 * TTL regardless, so the imprecision is bounded.
 */
export class PermissionCache {
  private readonly entries = new Map<string, CacheEntry>();
  readonly enabled: boolean;
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly serveStaleOnRateLimit: boolean;
  readonly staleWhileRateLimitedMs: number;
  private readonly now: () => number;

  constructor(opts: PermissionCacheOptions = {}) {
    this.enabled = opts.enabled ?? true;
    this.ttlMs = opts.ttlMs ?? DEFAULT_PERMISSION_CACHE_TTL_MS;
    this.maxEntries = opts.maxEntries ?? DEFAULT_PERMISSION_CACHE_MAX_ENTRIES;
    this.serveStaleOnRateLimit = opts.serveStaleOnRateLimit ?? true;
    this.staleWhileRateLimitedMs =
      opts.staleWhileRateLimitedMs ?? DEFAULT_STALE_WHILE_RATE_LIMITED_MS;
    this.now = opts.now ?? Date.now;
  }

  // Length-prefixed: userId and permission are caller-supplied strings
  // that may contain any character, so a delimiter-joined key lets one
  // tuple encode to another tuple's key and answer with the wrong
  // verdict.
  key(userId: string, groupId: string, permission: string, inherit: boolean): string {
    let out = inherit ? "i" : "d";
    for (const part of [userId, groupId, permission]) out += `|${part.length}:${part}`;
    return out;
  }

  /** Fresh answer, or null. */
  get(key: string): PermissionCheckResult | null {
    if (!this.enabled) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) return null;
    return entry.result;
  }

  /**
   * Expired-but-recent answer, used only to ride out a 429. Returns
   * null once the entry is past its stale window too.
   */
  getStale(key: string): PermissionCheckResult | null {
    if (!this.enabled || !this.serveStaleOnRateLimit) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.staleUntil <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.result;
  }

  set(key: string, result: PermissionCheckResult): void {
    if (!this.enabled) return;
    // Re-inserting moves the key to the end of the iteration order, so
    // a refreshed entry is no longer the next eviction candidate.
    this.entries.delete(key);
    const at = this.now();
    this.entries.set(key, {
      result,
      expiresAt: at + this.ttlMs,
      staleUntil: at + this.ttlMs + this.staleWhileRateLimitedMs,
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Drops every cached answer. */
  clear(): void {
    this.entries.clear();
  }

  size(): number {
    return this.entries.size;
  }
}
