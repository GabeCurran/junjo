import type { GroupId, PermissionKey, UserId } from "@junjo-io/shared";
import { useEffect, useSyncExternalStore } from "react";
import { makeCacheKey, usePermissionCache } from "./permissionCache.js";
import { useJunjo } from "./useJunjo.js";

export function useCan(
  userId: UserId,
  groupId: GroupId,
  permission: PermissionKey,
): boolean | undefined {
  const junjo = useJunjo();
  const cache = usePermissionCache();
  const key = makeCacheKey(userId, groupId, permission);

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
    void cache.prefetch(key, () => junjo.can(userId, groupId, permission));
  }, [cache, junjo, key, userId, groupId, permission, allowed]);

  return allowed;
}
