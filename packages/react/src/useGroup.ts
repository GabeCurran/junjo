import type { Group, GroupId, JunjoEvent, Member } from "@junjo.io/shared";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { upsertJoined, withRoleChange } from "./memberRows.js";
import { PendingEvents } from "./pendingEvents.js";
import { JunjoStreamClosedError, useSubscriptionHub } from "./subscriptionHub.js";
import { useJunjo } from "./useJunjo.js";

export interface GroupSnapshot {
  group: Group | null;
  members: Member[];
}

export type GroupUpdater = (prev: GroupSnapshot) => GroupSnapshot;

export interface UseGroupResult {
  group: Group | null;
  /**
   * Active members accumulated so far. May be a partial roster: only
   * the first page is loaded on mount, so check membersHasMore and
   * call fetchMoreMembers until it turns false to exhaust the roster.
   */
  members: Member[];
  loading: boolean;
  error: Error | null;
  /** True while more member pages exist beyond those already loaded. */
  membersHasMore: boolean;
  refetch: () => Promise<void>;
  /** Loads the next page of active members and appends it to `members`. */
  fetchMoreMembers: () => Promise<void>;
  applyOptimistic: (updater: GroupUpdater) => () => void;
}

interface State {
  group: Group | null;
  members: Member[];
  loading: boolean;
  membersHasMore: boolean;
  error: Error | null;
}

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; group: Group | null; members: Member[]; membersHasMore: boolean }
  | { type: "fetch_error"; error: Error }
  | { type: "members_more_success"; members: Member[]; membersHasMore: boolean }
  | { type: "members_more_error"; error: Error }
  | { type: "stream_error"; error: Error }
  | { type: "event"; event: JunjoEvent }
  | { type: "optimistic_apply"; updater: GroupUpdater }
  | { type: "optimistic_rollback"; snapshot: GroupSnapshot };

const INITIAL_STATE: State = {
  group: null,
  members: [],
  loading: true,
  membersHasMore: false,
  error: null,
};

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "fetch_start":
      return { ...state, loading: true, error: null };
    case "fetch_success":
      return {
        group: action.group,
        members: action.members,
        loading: false,
        membersHasMore: action.membersHasMore,
        error: null,
      };
    case "fetch_error":
      return { ...state, loading: false, error: action.error };
    case "members_more_success": {
      const seen = new Set(state.members.map((m) => m.userId));
      const additions = action.members.filter((m) => !seen.has(m.userId));
      return {
        ...state,
        members: [...state.members, ...additions],
        membersHasMore: action.membersHasMore,
        error: null,
      };
    }
    case "members_more_error":
      return { ...state, error: action.error };
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
    case "member.joined":
      return { ...state, members: upsertJoined(state.members, event.member) };
    case "member.left":
      return { ...state, members: state.members.filter((m) => m.userId !== event.userId) };
    case "role.changed": {
      const idx = state.members.findIndex((m) => m.userId === event.userId);
      const member = state.members[idx];
      if (member === undefined) return state;
      const next = state.members.slice();
      next[idx] = withRoleChange(member, event);
      return { ...state, members: next };
    }
    case "member.banned":
    case "member.unbanned":
      // This roster is active-only (see the status filter in refetch).
      // A ban flips the row to "banned" and an unban to "left" (the
      // server's unban handler sets status "left", not "active");
      // neither is active, so a present row drops out. Rows not
      // present cannot be inserted: the events carry no member
      // snapshot.
      return { ...state, members: state.members.filter((m) => m.userId !== event.userId) };
    case "group.updated":
      return { ...state, group: event.group };
    case "group.deleted":
      return { ...state, group: null, members: [], membersHasMore: false };
    default:
      return state;
  }
}

export function useGroup(groupId: GroupId): UseGroupResult {
  const junjo = useJunjo();
  const hub = useSubscriptionHub();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const membersCursorRef = useRef<string | null>(null);
  // Holds the generation that owns the in-flight page request, or null
  // when none is in flight. Generation-aware so a stale request's
  // finally cannot clear a flag a newer generation owns (which would
  // let a duplicate page request slip through).
  const inflightMoreRef = useRef<number | null>(null);
  const [pending] = useState(() => new PendingEvents());

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

  // The reducer empties the roster and clears membersHasMore on
  // group.deleted; the pagination cursor must die with them or a
  // programmatic fetchMoreMembers afterwards would fire with a dead
  // cursor.
  const applyEvent = useCallback((event: JunjoEvent) => {
    if (event.type === "group.deleted") membersCursorRef.current = null;
    dispatch({ type: "event", event });
  }, []);

  // Applies what the stream delivered during a fetch, in arrival
  // order, on top of whatever the fetch left in state.
  const replayHeld = useCallback(() => {
    const held = pending.drain();
    for (const event of held.events) applyEvent(event);
    if (held.failure !== null) dispatch({ type: "stream_error", error: held.failure });
  }, [pending, applyEvent]);

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    membersCursorRef.current = null;
    inflightMoreRef.current = null;
    pending.begin();
    dispatch({ type: "fetch_start" });
    try {
      const [group, page] = await Promise.all([
        junjo.groups.get(groupId),
        // The active-status filter runs server-side so the cursor and
        // membersHasMore describe the active-member stream (a client-
        // side filter would let a page of non-active rows read as a
        // truncated roster with a live "load more").
        junjo.members.list(groupId, { status: ["active"] }),
      ]);
      if (generation !== generationRef.current) return;
      membersCursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        group,
        members: page.items,
        membersHasMore: page.nextCursor !== null,
      });
      replayHeld();
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
      replayHeld();
    }
  }, [junjo, groupId, pending, replayHeld]);

  const fetchMoreMembers = useCallback(async (): Promise<void> => {
    if (membersCursorRef.current === null) return;
    if (inflightMoreRef.current !== null) return;
    const generation = generationRef.current;
    inflightMoreRef.current = generation;
    try {
      const page = await junjo.members.list(groupId, {
        status: ["active"],
        cursor: membersCursorRef.current,
      });
      if (generation !== generationRef.current) return;
      membersCursorRef.current = page.nextCursor;
      dispatch({
        type: "members_more_success",
        members: page.items,
        membersHasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "members_more_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      if (inflightMoreRef.current === generation) inflightMoreRef.current = null;
    }
  }, [junjo, groupId]);

  useEffect(() => {
    // Subscribe-then-fetch: the stream opens alongside the fetch rather
    // than after it. Events that land before the snapshot are held and
    // replayed on top of it (see PendingEvents), so none is lost or
    // overwritten by the snapshot. Streaming failures (handshake
    // rejection, mid-stream drop, server close) all surface as
    // stream_error via the hub's listener callbacks; the hub tears down
    // its shared stream and this hook recovers on remount / groupId
    // change as before.
    const unsubscribe = hub.subscribe(groupId, {
      onEvent: (event) => {
        if (!pending.hold(event)) applyEvent(event);
      },
      onError: (err) => {
        if (!pending.holdFailure(err)) dispatch({ type: "stream_error", error: err });
      },
      onClose: () => {
        const err = new JunjoStreamClosedError();
        if (!pending.holdFailure(err)) dispatch({ type: "stream_error", error: err });
      },
    });
    void refetch();

    return () => {
      unsubscribe();
      pending.clear();
    };
  }, [hub, groupId, refetch, pending, applyEvent]);

  return {
    group: state.group,
    members: state.members,
    loading: state.loading,
    membersHasMore: state.membersHasMore,
    error: state.error,
    refetch,
    fetchMoreMembers,
    applyOptimistic,
  };
}
