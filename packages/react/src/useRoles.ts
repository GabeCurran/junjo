import type { GroupId, JunjoEvent, PermissionEntry, PermissionKey, Role } from "@junjo.io/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { JunjoStreamClosedError, useSubscriptionHub } from "./subscriptionHub.js";
import { useJunjo } from "./useJunjo.js";

export interface UseRolesResult {
  /** The group's role definitions, in server list order. */
  roles: Role[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

interface State {
  roles: Role[];
  loading: boolean;
  error: Error | null;
}

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; roles: Role[] }
  | { type: "fetch_error"; error: Error }
  | { type: "stream_error"; error: Error }
  | { type: "event"; event: JunjoEvent };

const INITIAL_STATE: State = {
  roles: [],
  loading: true,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "fetch_start":
      return { ...state, loading: true, error: null };
    case "fetch_success":
      return { roles: action.roles, loading: false, error: null };
    case "fetch_error":
      return { ...state, loading: false, error: action.error };
    case "stream_error":
      return { ...state, error: action.error };
    case "event":
      return applyEvent(state, action.event);
  }
}

// permission.granted and permission.revoked describe a key's global
// entry only; an entry with a context for the same key is a separate
// entry and is left alone.
function isGlobalEntryFor(e: PermissionEntry, permission: PermissionKey): boolean {
  return (
    e.permission === permission && (e.context === undefined || Object.keys(e.context).length === 0)
  );
}

// Sets the global entry for `permission` to a grant, inserting it when
// absent ahead of the key's contextual entries, so `entries` stays
// sorted the way the server returns it: by key, global entry first.
function withGrantEntry(entries: PermissionEntry[], permission: PermissionKey): PermissionEntry[] {
  const idx = entries.findIndex((e) => isGlobalEntryFor(e, permission));
  if (idx >= 0) {
    if (entries[idx]?.value === true) return entries;
    const next = entries.slice();
    next[idx] = { permission, value: true };
    return next;
  }
  const at = entries.findIndex((e) => e.permission >= permission);
  const next = entries.slice();
  next.splice(at < 0 ? next.length : at, 0, { permission, value: true });
  return next;
}

// Live application covers the events that alter role DEFINITIONS and
// carry the new state: role.created (upsert), role.deleted (remove),
// and permission.granted / permission.revoked (patch the role's
// `permissions` and the matching `entries` item together so the two
// stay consistent). role.updated carries only the changed field names,
// so the hook refetches the list for it instead of patching here.
// role.changed is deliberately NOT applied: it describes a role
// ASSIGNMENT to a member (userId/added/removed) and carries no role
// definition data, so it cannot change this list.
function applyEvent(state: State, event: JunjoEvent): State {
  switch (event.type) {
    case "role.created": {
      const idx = state.roles.findIndex((r) => r.id === event.role.id);
      if (idx >= 0) {
        const next = state.roles.slice();
        next[idx] = event.role;
        return { ...state, roles: next };
      }
      return { ...state, roles: [...state.roles, event.role] };
    }
    case "role.deleted": {
      const idx = state.roles.findIndex((r) => r.id === event.roleId);
      if (idx < 0) return state;
      return { ...state, roles: state.roles.filter((r) => r.id !== event.roleId) };
    }
    case "permission.granted": {
      const idx = state.roles.findIndex((r) => r.id === event.roleId);
      const role = state.roles[idx];
      if (role === undefined) return state;
      const entries = withGrantEntry(role.entries, event.permission);
      const hasPermission = role.permissions.includes(event.permission);
      if (hasPermission && entries === role.entries) return state;
      const next = state.roles.slice();
      next[idx] = {
        ...role,
        permissions: hasPermission ? role.permissions : [...role.permissions, event.permission],
        entries,
      };
      return { ...state, roles: next };
    }
    case "permission.revoked": {
      const idx = state.roles.findIndex((r) => r.id === event.roleId);
      const role = state.roles[idx];
      if (role === undefined) return state;
      const hasPermission = role.permissions.includes(event.permission);
      const hasEntry = role.entries.some((e) => isGlobalEntryFor(e, event.permission));
      if (!hasPermission && !hasEntry) return state;
      const next = state.roles.slice();
      next[idx] = {
        ...role,
        permissions: role.permissions.filter((p) => p !== event.permission),
        entries: role.entries.filter((e) => !isGlobalEntryFor(e, event.permission)),
      };
      return { ...state, roles: next };
    }
    default:
      return state;
  }
}

/**
 * The group's role definitions, kept live from the group's shared SSE
 * stream: role.created / role.deleted update the list,
 * permission.granted / permission.revoked patch the affected role's
 * permissions and entries in place, and role.updated triggers a
 * background refetch that keeps the current list visible (`loading`
 * stays false) until the fresh one lands. Streaming failures surface on `error` without
 * clearing the loaded snapshot; recover by remounting or changing
 * `groupId`, or call `refetch` for a fresh fetch over the same stream.
 */
export function useRoles(groupId: GroupId): UseRolesResult {
  const junjo = useJunjo();
  const hub = useSubscriptionHub();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);

  // `background` skips fetch_start so an event-driven reload does not
  // flip `loading` or clear `error`. The generation counter is shared
  // between both kinds, so only the newest load commits.
  const load = useCallback(
    async (background: boolean): Promise<void> => {
      const generation = ++generationRef.current;
      if (!background) dispatch({ type: "fetch_start" });
      try {
        const roles = await junjo.roles.list(groupId);
        if (generation !== generationRef.current) return;
        dispatch({ type: "fetch_success", roles });
      } catch (err) {
        if (generation !== generationRef.current) return;
        dispatch({
          type: "fetch_error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    },
    [junjo, groupId],
  );

  const refetch = useCallback((): Promise<void> => load(false), [load]);

  // Read through a ref by the stream listener so a client swap does not
  // resubscribe the stream just to pick up the new loader.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Streaming failures (handshake rejection, mid-stream drop, server
  // close) all surface as stream_error via the hub's listener
  // callbacks; the hub tears down its shared stream and this hook
  // recovers on remount / groupId change, like the other group hooks.
  useEffect(() => {
    return hub.subscribe(groupId, {
      onEvent: (event) => {
        if (event.type === "role.updated") {
          void loadRef.current(true);
          return;
        }
        dispatch({ type: "event", event });
      },
      onError: (err) => {
        dispatch({ type: "stream_error", error: err });
      },
      onClose: () => {
        dispatch({ type: "stream_error", error: new JunjoStreamClosedError() });
      },
    });
  }, [hub, groupId]);

  return {
    roles: state.roles,
    loading: state.loading,
    error: state.error,
    refetch,
  };
}
