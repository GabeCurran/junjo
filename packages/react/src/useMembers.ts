import type { ListMembersOptions } from "@junjo.io/sdk";
import type { GroupId, JunjoEvent, Member, MemberStatus } from "@junjo.io/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { JunjoStreamClosedError, useSubscriptionHub } from "./subscriptionHub.js";
import { useJunjo } from "./useJunjo.js";

export type UseMembersStatus = MemberStatus | "all";

export interface UseMembersOptions {
  status?: UseMembersStatus;
  limit?: number;
}

export type MemberUpdater = (prev: Member[]) => Member[];

export interface UseMembersResult {
  members: Member[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
  applyOptimistic: (updater: MemberUpdater) => () => void;
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
  | { type: "event"; event: JunjoEvent; matches: MemberMatcher }
  | { type: "optimistic_apply"; updater: MemberUpdater }
  | { type: "optimistic_rollback"; snapshot: Member[] };

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
    case "optimistic_apply": {
      const next = action.updater(state.members);
      if (next === state.members) return state;
      return { ...state, members: next };
    }
    case "optimistic_rollback":
      if (action.snapshot === state.members) return state;
      return { ...state, members: action.snapshot };
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
    // Ban events update rows already present, then the status filter
    // decides keep/remove. Rows not present cannot be inserted: unlike
    // member.joined, these events carry no member snapshot, so a
    // banned-filtered list learns about newly banned members it never
    // loaded only on refetch.
    case "member.banned": {
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      if (idx < 0) return state;
      const member = state.members[idx];
      if (member === undefined) return state;
      const updated: Member = { ...member, status: "banned", bannedUntil: event.bannedUntil };
      if (!matches(updated)) {
        return { ...state, members: state.members.filter((m) => m.userId !== event.userId) };
      }
      const next = state.members.slice();
      next[idx] = updated;
      return { ...state, members: next };
    }
    case "member.unbanned": {
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      if (idx < 0) return state;
      const member = state.members[idx];
      if (member === undefined) return state;
      // The server's unban handler sets status "left" (not "active"):
      // an unbanned member has to rejoin. Mirror that here.
      const updated: Member = { ...member, status: "left", bannedUntil: null };
      if (!matches(updated)) {
        return { ...state, members: state.members.filter((m) => m.userId !== event.userId) };
      }
      const next = state.members.slice();
      next[idx] = updated;
      return { ...state, members: next };
    }
    default:
      return state;
  }
}

export function useMembers(groupId: GroupId, opts?: UseMembersOptions): UseMembersResult {
  const junjo = useJunjo();
  const hub = useSubscriptionHub();
  const status: UseMembersStatus = opts?.status ?? "active";
  const limit = opts?.limit;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  // Holds the generation that owns the in-flight page request, or null
  // when none is in flight. Generation-aware so a stale request's
  // finally cannot clear a flag a newer generation owns (which would
  // let a duplicate page request slip through).
  const inflightMoreRef = useRef<number | null>(null);

  // The fetch path filters by status server-side (see refetch and
  // fetchMore), so pages, cursor, and hasMore all describe the filtered
  // stream. This matcher exists for the SSE path only: live events carry
  // members of any status, so incoming updates must still respect the
  // active filter client-side.
  const matches = useCallback<MemberMatcher>(
    (m) => status === "all" || m.status === status,
    [status],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const membersRef = useRef(state.members);
  membersRef.current = state.members;

  const applyOptimistic = useCallback((updater: MemberUpdater): (() => void) => {
    const snapshot = membersRef.current;
    dispatch({ type: "optimistic_apply", updater });
    return () => {
      dispatch({ type: "optimistic_rollback", snapshot });
    };
  }, []);

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    cursorRef.current = null;
    inflightMoreRef.current = null;
    dispatch({ type: "fetch_start" });
    try {
      const listOpts: ListMembersOptions = {};
      if (limit !== undefined) listOpts.limit = limit;
      if (status !== "all") listOpts.status = [status];
      const page = await junjo.members.list(groupId, listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        members: page.items,
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, groupId, limit, status]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current === null) return;
    if (inflightMoreRef.current !== null) return;
    const generation = generationRef.current;
    inflightMoreRef.current = generation;
    dispatch({ type: "fetch_more_start" });
    try {
      const listOpts: ListMembersOptions = { cursor: cursorRef.current };
      if (limit !== undefined) listOpts.limit = limit;
      if (status !== "all") listOpts.status = [status];
      const page = await junjo.members.list(groupId, listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_more_success",
        members: page.items,
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_more_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      if (inflightMoreRef.current === generation) inflightMoreRef.current = null;
    }
  }, [junjo, groupId, limit, status]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Streaming failures (handshake rejection, mid-stream drop, server
  // close) all surface as stream_error via the hub's listener
  // callbacks; the hub tears down its shared stream and this hook
  // recovers on remount / groupId change as before.
  useEffect(() => {
    return hub.subscribe(groupId, {
      onEvent: (event) => {
        dispatch({ type: "event", event, matches: matchesRef.current });
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
    members: state.members,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    error: state.error,
    refetch,
    fetchMore,
    applyOptimistic,
  };
}
