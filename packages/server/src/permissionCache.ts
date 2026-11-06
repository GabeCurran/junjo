import type { PermissionCheckResult } from "@junjo.io/shared";

// Per-process; horizontal scale-out gets eventual consistency across
// instances bounded by the TTL.
//
// TTL alone is insufficient: a freshly granted permission needs to flip
// stale "no" answers to "yes" before the TTL expires. Mutation routes
// call `invalidateGroup(groupId)` after committing for that reason;
// per-group is coarse enough to be cheap (a guild has at most a few
// hundred members) and safe.
//
// An inherited answer is derived from every group on the walked chain,
// not just the queried one, so it is filed under all of them through
// `dependsOn`. A grant change at any ancestor then drops it.

export const PERMISSION_CACHE_TTL_MS = 60 * 1000;
// Entry cap. Past it the least recently used entry is evicted. The
// process sets it from PERMISSION_CACHE_MAX_ENTRIES at boot.
export const PERMISSION_CACHE_MAX_ENTRIES = 100_000;
export const PERMISSION_CACHE_SWEEP_INTERVAL_MS = 60 * 1000;

interface CacheEntry {
  result: PermissionCheckResult;
  expiresAt: number;
  // Every group whose index set holds this key, so invalidating one of
  // them can prune the key from the others instead of leaving dangling
  // references behind in their sets.
  indexGroups: string[];
}

export interface PermissionCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface PermissionCacheKeyOptions {
  // Inherited answers occupy a separate keyspace: the same triple can
  // resolve differently with and without the parent walk.
  inherit?: boolean;
  // The check's canonical context key ("" or absent for global). Each
  // context occupies its own keyspace for the same reason.
  context?: string;
}

export interface PermissionCacheSetOptions extends PermissionCacheKeyOptions {
  // Groups this answer depends on. Defaults to the queried group alone.
  dependsOn?: string[];
}

export class PermissionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly groupIndex = new Map<string, Set<string>>();
  private readonly ttlMs: number;
  private maxEntries: number;
  private readonly now: () => number;

  constructor(opts: PermissionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? PERMISSION_CACHE_TTL_MS;
    this.maxEntries = Math.max(1, opts.maxEntries ?? PERMISSION_CACHE_MAX_ENTRIES);
    this.now = opts.now ?? Date.now;
  }

  setMaxEntries(maxEntries: number): void {
    this.maxEntries = Math.max(1, maxEntries);
    this.evictOverflow();
  }

  // Map iteration order is insertion order and a hit re-inserts its key,
  // so the first key is the least recently used one.
  private evictOverflow(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      const entry = this.entries.get(oldest);
      if (entry) this.evict(oldest, entry);
      else this.entries.delete(oldest);
    }
  }

  // Length-prefixed rather than delimiter-joined. `userId` and
  // `permission` are caller-supplied strings that may contain any
  // character, so a plain separator lets one tuple encode to another
  // tuple's key and answer a check with the wrong verdict.
  private key(
    gameId: string,
    groupId: string,
    userId: string,
    permission: string,
    opts: PermissionCacheKeyOptions,
  ): string {
    const inherit = opts.inherit ?? false;
    const parts = [gameId, groupId, userId, permission, opts.context ?? ""];
    let out = inherit ? "i" : "d";
    for (const p of parts) out += `|${p.length}:${p}`;
    return out;
  }

  private evict(k: string, entry: CacheEntry): void {
    this.entries.delete(k);
    for (const g of entry.indexGroups) {
      const idx = this.groupIndex.get(g);
      if (!idx) continue;
      idx.delete(k);
      if (idx.size === 0) this.groupIndex.delete(g);
    }
  }

  get(
    gameId: string,
    groupId: string,
    userId: string,
    permission: string,
    opts: PermissionCacheKeyOptions = {},
  ): PermissionCheckResult | null {
    const k = this.key(gameId, groupId, userId, permission, opts);
    const entry = this.entries.get(k);
    if (!entry) return null;
    if (entry.expiresAt <= this.now()) {
      this.evict(k, entry);
      return null;
    }
    this.entries.delete(k);
    this.entries.set(k, entry);
    return entry.result;
  }

  set(
    gameId: string,
    groupId: string,
    userId: string,
    permission: string,
    result: PermissionCheckResult,
    opts: PermissionCacheSetOptions = {},
  ): void {
    const k = this.key(gameId, groupId, userId, permission, opts);
    const previous = this.entries.get(k);
    if (previous) this.evict(k, previous);

    const dependsOn = opts.dependsOn?.length ? opts.dependsOn : [groupId];
    const indexGroups = [...new Set(dependsOn)];
    this.entries.set(k, { result, expiresAt: this.now() + this.ttlMs, indexGroups });
    for (const g of indexGroups) {
      let idx = this.groupIndex.get(g);
      if (!idx) {
        idx = new Set();
        this.groupIndex.set(g, idx);
      }
      idx.add(k);
    }
    this.evictOverflow();
  }

  // Drops every expired entry. Returns the number removed.
  sweepExpired(): number {
    const at = this.now();
    let removed = 0;
    for (const [k, entry] of this.entries) {
      if (entry.expiresAt <= at) {
        this.evict(k, entry);
        removed++;
      }
    }
    return removed;
  }

  invalidateGroup(groupId: string): void {
    const idx = this.groupIndex.get(groupId);
    if (!idx) return;
    for (const k of [...idx]) {
      const entry = this.entries.get(k);
      if (entry) this.evict(k, entry);
    }
    this.groupIndex.delete(groupId);
  }

  clear(): void {
    this.entries.clear();
    this.groupIndex.clear();
  }

  size(): number {
    return this.entries.size;
  }
}

export const permissionCache = new PermissionCache();

export function startPermissionCacheSweeper(
  cache: PermissionCache = permissionCache,
  opts: { intervalMs?: number } = {},
): { stop(): void } {
  const handle = setInterval(
    () => cache.sweepExpired(),
    opts.intervalMs ?? PERMISSION_CACHE_SWEEP_INTERVAL_MS,
  );
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
