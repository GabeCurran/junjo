import type { GroupId, PermissionKey, UserId } from "@junjo/shared";
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

  useEffect(() => {
    void cache.prefetch(key, () => junjo.can(userId, groupId, permission));
  }, [cache, junjo, key, userId, groupId, permission]);

  return useSyncExternalStore(
    (listener) => cache.subscribe(key, listener),
    () => cache.get(key),
    () => undefined,
  );
}
