import type { Junjo } from "@junjo-io/sdk";
import { type ReactNode, useRef } from "react";
import { JunjoContext } from "./context.js";
import { PermissionCache, PermissionCacheContext } from "./permissionCache.js";

export interface JunjoProviderProps {
  client: Junjo;
  children: ReactNode;
}

export function JunjoProvider({ client, children }: JunjoProviderProps) {
  const cacheRef = useRef<{ client: Junjo; cache: PermissionCache } | null>(null);
  if (cacheRef.current === null || cacheRef.current.client !== client) {
    cacheRef.current = { client, cache: new PermissionCache() };
  }
  const permissionCache = cacheRef.current.cache;
  return (
    <JunjoContext.Provider value={client}>
      <PermissionCacheContext.Provider value={permissionCache}>
        {children}
      </PermissionCacheContext.Provider>
    </JunjoContext.Provider>
  );
}
