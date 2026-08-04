import type { Subscription } from "@junjo-io/sdk";
import type { Group, GroupId, JunjoEvent, Member } from "@junjo-io/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useJunjo } from "./useJunjo.js";

export interface GroupSnapshot {
  group: Group | null;
  members: Member[];
}

export type GroupUpdater = (prev: GroupSnapshot) => GroupSnapshot;

export interface UseGroupResult {
  group: Group | null;
  members: Member[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  applyOptimistic: (updater: GroupUpdater) => () => void;
}

interface State {
  group: Group | null;
  members: Member[];
  loading: boolean;
  error: Error | null;
}

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; group: Group | null; members: Member[] }
  | { type: "fetch_error"; error: Error }
  | { type: "stream_error"; error: Error }
  | { type: "event"; event: JunjoEvent }
  | { type: "optimistic_apply"; updater: GroupUpdater }
  | { type: "optimistic_rollback"; snapshot: GroupSnapshot };

const INITIAL_STATE: State = {
  group: null,
  members: [],
  loading: true,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "fetch_start":
      return { ...state, loading: true, error: null };
    case "fetch_success":
      return { group: action.group, members: action.members, loading: false, error: null };
    case "fetch_error":
      return { ...state, loading: false, error: action.error };
    case "stream_error":
      return { ...state, error: action.error };
    case "event":
      return applyEvent(state, action.event);
    case "optimistic_apply": {
      const next = action.updater({ group: state.group, members: state.members });
      if (next.group === state.group && next.members === state.members) return state;
      return { ...state, group: next.group, members: next.members };
    }
    case "optimistic_rollback":
      if (action.snapshot.group === state.group && action.snapshot.members === state.members) {
        return state;
      }
      return { ...state, group: action.snapshot.group, members: action.snapshot.members };
  }
}

function applyEvent(state: State, event: JunjoEvent): State {
  switch (event.type) {
    case "member.joined": {
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      if (idx >= 0) {
        const next = state.members.slice();
        next[idx] = event.member;
        return { ...state, members: next };
      }
      return { ...state, members: [...state.members, event.member] };
    }
    case "member.left":
      return { ...state, members: state.members.filter((m) => m.userId !== event.userId) };
    case "role.changed": {
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      if (idx < 0) return state;
      const member = state.members[idx];
      if (member === undefined) return state;
      const removedSet = new Set<string>(event.removed);
      const remaining = member.roles.filter((r) => !removedSet.has(r));
      const additions = event.added.filter((r) => !remaining.includes(r));
      const next = state.members.slice();
      next[idx] = { ...member, roles: [...remaining, ...additions] };
      return { ...state, members: next };
    }
    case "group.updated":
      return { ...state, group: event.group };
    case "group.deleted":
      return { ...state, group: null, members: [] };
    default:
      return state;
  }
}

export function useGroup(groupId: GroupId): UseGroupResult {
  const junjo = useJunjo();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);

  const groupRef = useRef(state.group);
  groupRef.current = state.group;
  const membersRef = useRef(state.members);
  membersRef.current = state.members;

  const applyOptimistic = useCallback((updater: GroupUpdater): (() => void) => {
    const snapshot: GroupSnapshot = {
      group: groupRef.current,
      members: membersRef.current,
    };
    dispatch({ type: "optimistic_apply", updater });
    return () => {
      dispatch({ type: "optimistic_rollback", snapshot });
    };
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    dispatch({ type: "fetch_start" });
    try {
      const [group, page] = await Promise.all([
        junjo.groups.get(groupId),
        junjo.members.list(groupId),
      ]);
      if (generation !== generationRef.current) return;
      const activeMembers = page.items.filter((m) => m.status === "active");
      dispatch({ type: "fetch_success", group, members: activeMembers });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, groupId]);

  useEffect(() => {
    let cancelled = false;
    let subscription: Subscription | null = null;

    void (async () => {
      await refetch();
      if (cancelled) return;
      try {
        const sub = await junjo.groups.subscribe(
          groupId,
          (event) => {
            if (cancelled) return;
            dispatch({ type: "event", event });
          },
          {
            onError: (err) => {
              if (cancelled) return;
              dispatch({ type: "stream_error", error: err });
            },
          },
        );
        if (cancelled) {
          sub.close();
          return;
        }
        subscription = sub;
      } catch (err) {
        if (cancelled) return;
        dispatch({
          type: "stream_error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();

    return () => {
      cancelled = true;
      subscription?.close();
    };
  }, [junjo, groupId, refetch]);

  return {
    group: state.group,
    members: state.members,
    loading: state.loading,
    error: state.error,
    refetch,
    applyOptimistic,
  };
}
