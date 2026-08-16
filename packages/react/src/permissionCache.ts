import type { GroupId, PermissionKey, UserId } from "@junjo.io/shared";
import { createContext, useContext, useMemo } from "react";

export type PermissionCacheKey = string;

// Ids cannot contain NUL, so this delimiter never collides; a space
// would let ("u", "g x") and ("u g", "x") share one key. The escape
// is deliberate: a raw NUL byte in source is invisible in editors.
const KEY_DELIMITER = "\u0000";

// `inherit` is the last segment so the userId / groupId segment
// positions that invalidateSegment indexes stay put. Inherited and
// direct answers must not share a key: the same triple can resolve
// differently with and without the parent walk.
export function makeCacheKey(
  userId: UserId,
  groupId: GroupId,
  permission: PermissionKey,
  inherit = false,
): PermissionCacheKey {
  const mode = inherit ? "i" : "d";
  return `${userId}${KEY_DELIMITER}${groupId}${KEY_DELIMITER}${permission}${KEY_DELIMITER}${mode}`;
}

// Long sessions touching many (user, group, permission) triples would
// otherwise grow the cache without bound. Enforced on insert, oldest
// entries evicted first (Map preserves insertion order). Evicted keys
// are not notified; they just become refetchable on next use.
export const MAX_ENTRIES = 500;

type Listener = () => void;

export class PermissionCache {
  private readonly entries = new Map<PermissionCacheKey, boolean>();
  private readonly inflight = new Map<PermissionCacheKey, Promise<boolean | undefined>>();
  private readonly listeners = new Map<PermissionCacheKey, Set<Listener>>();

  get(key: PermissionCacheKey): boolean | undefined {
    return this.entries.get(key);
  }

  has(key: PermissionCacheKey): boolean {
    return this.entries.has(key);
  }

  // Lets a batching caller skip keys another fetch already owns, so it
  // does not issue a request whose results `prefetch` would discard.
  isInflight(key: PermissionCacheKey): boolean {
    return this.inflight.has(key);
  }

  subscribe(key: PermissionCacheKey, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
    return () => {
      const current = this.listeners.get(key);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) this.listeners.delete(key);
    };
  }

  prefetch(key: PermissionCacheKey, fetcher: () => Promise<boolean>): Promise<boolean | undefined> {
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    if (this.entries.has(key)) {
      return Promise.resolve(this.entries.get(key));
    }
    const promise: Promise<boolean | undefined> = fetcher().then(
      (allowed) => {
        // Apply only while this fetch is still the live one for the key.
        // An invalidate() between start and settle clears the inflight
        // slot (and a newer fetch may have claimed it); a stale result
        // must neither overwrite the cache nor evict the new fetch.
        if (this.inflight.get(key) === promise) {
          this.entries.set(key, allowed);
          while (this.entries.size > MAX_ENTRIES) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
          }
          this.inflight.delete(key);
          this.notify(key);
        }
        return allowed;
      },
      () => {
        if (this.inflight.get(key) === promise) {
          this.inflight.delete(key);
          this.notify(key);
        }
        return undefined;
      },
    );
    this.inflight.set(key, promise);
    return promise;
  }

  invalidate(key?: PermissionCacheKey): void {
    if (key === undefined) {
      const allKeys = new Set<PermissionCacheKey>([
        ...this.entries.keys(),
        ...this.listeners.keys(),
      ]);
      this.entries.clear();
      this.inflight.clear();
      for (const k of allKeys) this.notify(k);
      return;
    }
    this.entries.delete(key);
    this.inflight.delete(key);
    this.notify(key);
  }

  invalidateUser(userId: UserId): void {
    this.invalidateSegment(0, userId);
  }

  invalidateGroup(groupId: GroupId): void {
    this.invalidateSegment(1, groupId);
  }

  // Sweeps every key whose userId (segment 0) or groupId (segment 1)
  // matches. Listener keys are included so subscribed consumers get
  // notified even when their entry has not resolved yet.
  private invalidateSegment(segment: 0 | 1, value: string): void {
    const candidates = new Set<PermissionCacheKey>([
      ...this.entries.keys(),
      ...this.inflight.keys(),
      ...this.listeners.keys(),
    ]);
    for (const key of candidates) {
      if (key.split(KEY_DELIMITER)[segment] !== value) continue;
      this.entries.delete(key);
      this.inflight.delete(key);
      this.notify(key);
    }
  }

  private notify(key: PermissionCacheKey): void {
    const set = this.listeners.get(key);
    if (set === undefined) return;
    for (const listener of set) listener();
  }
}

export const PermissionCacheContext = createContext<PermissionCache | null>(null);

export function usePermissionCache(): PermissionCache {
  const cache = useContext(PermissionCacheContext);
  if (cache === null) {
    throw new Error("Permission cache missing; useCan must be used inside a <JunjoProvider>");
  }
  return cache;
}

export interface UseInvalidatePermissionsResult {
  /**
   * Drops one answer. Pass `inherit` to target the inherited variant;
   * the two are cached separately, so a call without it leaves an
   * inherited answer for the same triple in place.
   */
  invalidate: (
    userId: UserId,
    groupId: GroupId,
    permission: PermissionKey,
    inherit?: boolean,
  ) => void;
  invalidateUser: (userId: UserId) => void;
  invalidateGroup: (groupId: GroupId) => void;
  invalidateAll: () => void;
}

// Imperative invalidation surface for mutation callbacks. Function
// identities are stable for the lifetime of the provider's cache, so
// they are safe to list in effect deps.
export function useInvalidatePermissions(): UseInvalidatePermissionsResult {
  const cache = usePermissionCache();
  return useMemo<UseInvalidatePermissionsResult>(
    () => ({
      invalidate: (userId, groupId, permission, inherit = false) => {
        cache.invalidate(makeCacheKey(userId, groupId, permission, inherit));
      },
      invalidateUser: (userId) => {
        cache.invalidateUser(userId);
      },
      invalidateGroup: (groupId) => {
        cache.invalidateGroup(groupId);
      },
      invalidateAll: () => {
        cache.invalidate();
      },
    }),
    [cache],
  );
}
