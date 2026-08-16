import type { GroupId, PermissionKey, UserId } from "@junjo.io/shared";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { makeCacheKey, usePermissionCache } from "./permissionCache.js";
import { useJunjo } from "./useJunjo.js";

/** Options shared by {@link useCan} and {@link useCanMany}. */
export interface UseCanOptions {
  /**
   * Resolve against the group's parents too, nearest first, stopping at
   * the first group that decides. Off by default. Inherited answers are
   * cached separately from direct ones.
   */
  inherit?: boolean;
}

/**
 * Whether a user holds a permission in a group, or `undefined` while
 * the answer is still loading.
 */
export function useCan(
  userId: UserId,
  groupId: GroupId,
  permission: PermissionKey,
  opts?: UseCanOptions,
): boolean | undefined {
  const junjo = useJunjo();
  const cache = usePermissionCache();
  const inherit = opts?.inherit ?? false;
  const key = makeCacheKey(userId, groupId, permission, inherit);

  const allowed = useSyncExternalStore(
    (listener) => cache.subscribe(key, listener),
    () => cache.get(key),
    () => undefined,
  );

  // allowed is a dep so invalidation (cached value flips back to
  // undefined) triggers a refetch instead of sticking on undefined.
  // Failed fetches do not loop: a rejection leaves the snapshot
  // unchanged, so the effect does not re-fire.
  useEffect(() => {
    if (allowed !== undefined) return;
    void cache.prefetch(key, () =>
      // Called without options unless inheriting, so a direct check
      // reaches the SDK exactly as it always has.
      inherit
        ? junjo.can(userId, groupId, permission, { inherit: true })
        : junjo.can(userId, groupId, permission),
    );
  }, [cache, junjo, key, userId, groupId, permission, inherit, allowed]);

  return allowed;
}

/** One entry of a {@link useCanMany} query. */
export interface CanQuery {
  userId: UserId;
  groupId: GroupId;
  permission: PermissionKey;
}

const EMPTY: readonly undefined[] = [];

/**
 * Answers many permission questions in one round-trip, positionally:
 * `result[i]` answers `checks[i]`, `undefined` while it loads.
 *
 * Gating a nav bar or filtering a list with {@link useCan} costs one
 * request per key; this resolves the whole set through the batch route
 * instead. Answers share the cache {@link useCan} uses, so a key
 * already resolved by either hook is not re-fetched and invalidation
 * reaches both.
 *
 * `checks` is read by value: a new array literal each render is fine.
 */
export function useCanMany(
  checks: CanQuery[],
  opts?: UseCanOptions,
): readonly (boolean | undefined)[] {
  const junjo = useJunjo();
  const cache = usePermissionCache();
  const inherit = opts?.inherit ?? false;

  // The effect needs the original tuples to build its request, but
  // reading them through a ref keeps the array identity, which changes
  // every render, out of the dependency lists below.
  const checksRef = useRef(checks);
  checksRef.current = checks;

  // A fresh array of the same tuples must not read as a change, so the
  // memo keys off the tuple content. JSON.stringify rather than a
  // joined string: ids are caller-supplied and may contain anything,
  // and a delimiter one of them happens to hold would make two
  // different inputs compare equal.
  const checksKey = JSON.stringify(checks.map((c) => [c.userId, c.groupId, c.permission]));
  // biome-ignore lint/correctness/useExhaustiveDependencies: checksKey is the change signal for checksRef, which is intentionally not a dependency
  const keys = useMemo(
    () => checksRef.current.map((c) => makeCacheKey(c.userId, c.groupId, c.permission, inherit)),
    [checksKey, inherit],
  );

  // useSyncExternalStore re-renders whenever getSnapshot returns a new
  // reference, so the array has to be reused until a value actually
  // changes.
  const snapshotRef = useRef<readonly (boolean | undefined)[]>(EMPTY);
  const getSnapshot = useCallback(() => {
    const previous = snapshotRef.current;
    const next = keys.map((k) => cache.get(k));
    if (previous.length === next.length && previous.every((v, i) => v === next[i])) {
      return previous;
    }
    snapshotRef.current = next;
    return next;
  }, [cache, keys]);

  const serverSnapshot = useMemo<readonly (boolean | undefined)[]>(
    () => (keys.length === 0 ? EMPTY : keys.map(() => undefined)),
    [keys],
  );

  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = keys.map((k) => cache.subscribe(k, listener));
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
      };
    },
    [cache, keys],
  );

  const allowed = useSyncExternalStore(subscribe, getSnapshot, () => serverSnapshot);

  useEffect(() => {
    // Skip keys another fetch already owns; prefetch would discard this
    // request's answer for them anyway.
    // Filtering on `allowed` rather than re-reading the cache is what
    // makes this effect re-run after an invalidation: entries flip back
    // to undefined, the snapshot changes, and the missing ones refetch.
    const missing = keys
      .map((key, index) => ({ key, index }))
      .filter(({ key, index }) => allowed[index] === undefined && !cache.isInflight(key));
    if (missing.length === 0) return;

    const queries = missing.map(({ index }) => checksRef.current[index] as CanQuery);
    const shared = inherit
      ? junjo.checkBatch(queries, { inherit: true })
      : junjo.checkBatch(queries);
    missing.forEach(({ key }, position) => {
      void cache.prefetch(key, async () => {
        const results = await shared;
        return results[position]?.allowed ?? false;
      });
    });
  }, [cache, junjo, keys, inherit, allowed]);

  return allowed;
}
