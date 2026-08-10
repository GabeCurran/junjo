import type { GroupId, JunjoEvent, Role } from "@junjo.io/shared";
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

// Live application covers the events that alter role DEFINITIONS:
// role.created (upsert), role.deleted (remove), and permission.granted /
// permission.revoked (patch the role's permissions array, which is how
// roles gain and lose permissions, never at creation time).
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
      if (role.permissions.includes(event.permission)) return state;
      const next = state.roles.slice();
      next[idx] = { ...role, permissions: [...role.permissions, event.permission] };
      return { ...state, roles: next };
    }
    case "permission.revoked": {
      const idx = state.roles.findIndex((r) => r.id === event.roleId);
      const role = state.roles[idx];
      if (role === undefined) return state;
      if (!role.permissions.includes(event.permission)) return state;
      const next = state.roles.slice();
      next[idx] = {
        ...role,
        permissions: role.permissions.filter((p) => p !== event.permission),
      };
      return { ...state, roles: next };
    }
    default:
      return state;
  }
}

/**
 * The group's role definitions, kept live from the group's shared SSE
 * stream: role.created / role.deleted update the list and
 * permission.granted / permission.revoked patch the affected role's
 * permissions in place. Streaming failures surface on `error` without
 * clearing the loaded snapshot; recover by remounting or changing
 * `groupId`, or call `refetch` for a fresh fetch over the same stream.
 */
export function useRoles(groupId: GroupId): UseRolesResult {
  const junjo = useJunjo();
  const hub = useSubscriptionHub();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    dispatch({ type: "fetch_start" });
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
  }, [junjo, groupId]);

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
