import type { Junjo } from "@junjo.io/sdk";
import { type ReactNode, useRef } from "react";
import { JunjoContext } from "./context.js";
import { GameEventsHub, GameEventsHubContext } from "./gameEventsHub.js";
import { PermissionCache, PermissionCacheContext } from "./permissionCache.js";
import { SubscriptionHub, SubscriptionHubContext } from "./subscriptionHub.js";

export interface JunjoProviderProps {
  client: Junjo;
  children: ReactNode;
}

export function JunjoProvider({ client, children }: JunjoProviderProps) {
  // The cache and both hubs share the client's lifecycle: one of each
  // per client, rebuilt together when the client instance is swapped.
  const perClientRef = useRef<{
    client: Junjo;
    cache: PermissionCache;
    hub: SubscriptionHub;
    gameHub: GameEventsHub;
  } | null>(null);
  if (perClientRef.current === null || perClientRef.current.client !== client) {
    perClientRef.current = {
      client,
      cache: new PermissionCache(),
      hub: new SubscriptionHub(client),
      gameHub: new GameEventsHub(client),
    };
  }
  const { cache: permissionCache, hub: subscriptionHub, gameHub } = perClientRef.current;
  return (
    <JunjoContext.Provider value={client}>
      <PermissionCacheContext.Provider value={permissionCache}>
        <SubscriptionHubContext.Provider value={subscriptionHub}>
          <GameEventsHubContext.Provider value={gameHub}>{children}</GameEventsHubContext.Provider>
        </SubscriptionHubContext.Provider>
      </PermissionCacheContext.Provider>
    </JunjoContext.Provider>
  );
}
