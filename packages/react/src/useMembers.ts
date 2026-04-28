import type { Subscription } from "@junjo/sdk";
import type { GroupId, JunjoEvent, Member, MemberStatus, PageOptions } from "@junjo/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useJunjo } from "./useJunjo.js";

export type UseMembersStatus = MemberStatus | "all";

export interface UseMembersOptions {
  status?: UseMembersStatus;
  limit?: number;
}

export interface UseMembersResult {
  members: Member[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
}

interface State {
  members: Member[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
}

type MemberMatcher = (member: Member) => boolean;

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; members: Member[]; hasMore: boolean }
  | { type: "fetch_error"; error: Error }
  | { type: "fetch_more_start" }
  | { type: "fetch_more_success"; members: Member[]; hasMore: boolean }
  | { type: "fetch_more_error"; error: Error }
  | { type: "stream_error"; error: Error }
  | { type: "event"; event: JunjoEvent; matches: MemberMatcher };

const INITIAL_STATE: State = {
  members: [],
  loading: true,
  loadingMore: false,
  hasMore: false,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "fetch_start":
      return { ...INITIAL_STATE, loading: true };
    case "fetch_success":
      return {
        members: action.members,
        loading: false,
        loadingMore: false,
        hasMore: action.hasMore,
        error: null,
      };
    case "fetch_error":
      return { ...state, loading: false, loadingMore: false, error: action.error };
    case "fetch_more_start":
      return { ...state, loadingMore: true, error: null };
    case "fetch_more_success": {
      const seen = new Set(state.members.map((m) => m.userId));
      const additions = action.members.filter((m) => !seen.has(m.userId));
      return {
        ...state,
        members: [...state.members, ...additions],
        loadingMore: false,
        hasMore: action.hasMore,
        error: null,
      };
    }
    case "fetch_more_error":
      return { ...state, loadingMore: false, error: action.error };
    case "stream_error":
      return { ...state, error: action.error };
    case "event":
      return applyEvent(state, action.event, action.matches);
  }
}

function applyEvent(state: State, event: JunjoEvent, matches: MemberMatcher): State {
  switch (event.type) {
    case "member.joined": {
      if (!matches(event.member)) return state;
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      if (idx >= 0) {
        const next = state.members.slice();
        next[idx] = event.member;
        return { ...state, members: next };
      }
      return { ...state, members: [...state.members, event.member] };
    }
    case "member.left": {
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      if (idx < 0) return state;
      return { ...state, members: state.members.filter((m) => m.userId !== event.userId) };
    }
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
    default:
      return state;
  }
}

export function useMembers(groupId: GroupId, opts?: UseMembersOptions): UseMembersResult {
  const junjo = useJunjo();
  const status: UseMembersStatus = opts?.status ?? "active";
  const limit = opts?.limit;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const inflightMoreRef = useRef(false);

  const matches = useCallback<MemberMatcher>(
    (m) => status === "all" || m.status === status,
    [status],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    cursorRef.current = null;
    inflightMoreRef.current = false;
    dispatch({ type: "fetch_start" });
    try {
      const listOpts: PageOptions | undefined = limit !== undefined ? { limit } : undefined;
      const page = await junjo.members.list(groupId, listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        members: page.items.filter(matches),
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, groupId, limit, matches]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current === null) return;
    if (inflightMoreRef.current) return;
    inflightMoreRef.current = true;
    const generation = generationRef.current;
    dispatch({ type: "fetch_more_start" });
    try {
      const listOpts: PageOptions = { cursor: cursorRef.current };
      if (limit !== undefined) listOpts.limit = limit;
      const page = await junjo.members.list(groupId, listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_more_success",
        members: page.items.filter(matches),
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_more_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      inflightMoreRef.current = false;
    }
  }, [junjo, groupId, limit, matches]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  useEffect(() => {
    let cancelled = false;
    let subscription: Subscription | null = null;

    void (async () => {
      try {
        const sub = await junjo.groups.subscribe(
          groupId,
          (event) => {
            if (cancelled) return;
            dispatch({ type: "event", event, matches: matchesRef.current });
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
  }, [junjo, groupId]);

  return {
    members: state.members,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    error: state.error,
    refetch,
    fetchMore,
  };
}
