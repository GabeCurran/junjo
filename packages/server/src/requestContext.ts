import { AsyncLocalStorage } from "node:async_hooks";
import type { GameConfigPermissions, UserIdFormat } from "@junjo.io/shared";

// Per-request state that cross-cutting helpers read without every
// handler threading it through: the acting API key (stamped onto audit
// entries), its namespace preference (applied when rendering user ids),
// the declared id formats of games the request touched, and the
// resolved permission config of the key's game.
//
// Absent outside an HTTP request (workers, seeds, direct helper calls in
// tests). Readers must treat absence as "no key, no preference" and load
// anything else they need themselves.
export interface RequestContext {
  apiKeyId: string | null;
  preferredNamespaces: readonly string[];
  // gameId -> declared formats. Filled by the API key middleware for the
  // key's own game, and lazily by `idFormatsFor` for any other game.
  idFormats: Map<string, Readonly<Record<string, UserIdFormat>>>;
  // gameId -> resolved `permissions` config, read with the key row by
  // the API key middleware so permission checks need no second read.
  permissionConfigs: Map<string, GameConfigPermissions>;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestContext(): RequestContext {
  return {
    apiKeyId: null,
    preferredNamespaces: [],
    idFormats: new Map(),
    permissionConfigs: new Map(),
  };
}

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

// The namespace preference that applies to the current request; empty
// outside a request or for callers without one.
export function currentPreferredNamespaces(): readonly string[] {
  return storage.getStore()?.preferredNamespaces ?? [];
}
