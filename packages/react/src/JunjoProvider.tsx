import type { Junjo } from "@junjo.io/sdk";
import { type ReactNode, useRef } from "react";
import { JunjoContext } from "./context.js";
import { PermissionCache, PermissionCacheContext } from "./permissionCache.js";
import { SubscriptionHub, SubscriptionHubContext } from "./subscriptionHub.js";

export interface JunjoProviderProps {
  client: Junjo;
  children: ReactNode;
}

export function JunjoProvider({ client, children }: JunjoProviderProps) {
  // The cache and the hub share the client's lifecycle: one of each per
  // client, rebuilt together when the client instance is swapped.
  const perClientRef = useRef<{
    client: Junjo;
    cache: PermissionCache;
    hub: SubscriptionHub;
  } | null>(null);
  if (perClientRef.current === null || perClientRef.current.client !== client) {
    perClientRef.current = {
      client,
      cache: new PermissionCache(),
      hub: new SubscriptionHub(client),
    };
  }
  const { cache: permissionCache, hub: subscriptionHub } = perClientRef.current;
  return (
    <JunjoContext.Provider value={client}>
      <PermissionCacheContext.Provider value={permissionCache}>
        <SubscriptionHubContext.Provider value={subscriptionHub}>
          {children}
        </SubscriptionHubContext.Provider>
      </PermissionCacheContext.Provider>
    </JunjoContext.Provider>
  );
}
