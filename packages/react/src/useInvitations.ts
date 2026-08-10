import type { ListInvitationsOptions } from "@junjo.io/sdk";
import type { GroupId, Invitation, JunjoEvent } from "@junjo.io/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { JunjoStreamClosedError, useSubscriptionHub } from "./subscriptionHub.js";
import { useJunjo } from "./useJunjo.js";

/**
 * The three concrete statuses partition invitations disjointly:
 * "pending" is unused and unexpired, "used" is any redeemed invitation
 * (even one whose expiry has since passed), and "expired" is unused
 * but past its expiresAt.
 */
export type UseInvitationsStatus = "pending" | "used" | "expired" | "all";

export interface UseInvitationsOptions {
  status?: UseInvitationsStatus;
  limit?: number;
}

export type InvitationUpdater = (prev: Invitation[]) => Invitation[];

export interface UseInvitationsResult {
  invitations: Invitation[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
  applyOptimistic: (updater: InvitationUpdater) => () => void;
}

interface State {
  invitations: Invitation[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
}

type InvitationMatcher = (inv: Invitation) => boolean;

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; invitations: Invitation[]; hasMore: boolean }
  | { type: "fetch_error"; error: Error }
  | { type: "fetch_more_start" }
  | { type: "fetch_more_success"; invitations: Invitation[]; hasMore: boolean }
  | { type: "fetch_more_error"; error: Error }
  | { type: "stream_error"; error: Error }
  | { type: "event"; event: JunjoEvent; matches: InvitationMatcher }
  | { type: "optimistic_apply"; updater: InvitationUpdater }
  | { type: "optimistic_rollback"; snapshot: Invitation[] };

const INITIAL_STATE: State = {
  invitations: [],
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
        invitations: action.invitations,
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
      const seen = new Set(state.invitations.map((i) => i.id));
      const additions = action.invitations.filter((i) => !seen.has(i.id));
      return {
        ...state,
        invitations: [...state.invitations, ...additions],
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
      const next = action.updater(state.invitations);
      if (next === state.invitations) return state;
      return { ...state, invitations: next };
    }
    case "optimistic_rollback":
      if (action.snapshot === state.invitations) return state;
      return { ...state, invitations: action.snapshot };
  }
}

function applyEvent(state: State, event: JunjoEvent, matches: InvitationMatcher): State {
  switch (event.type) {
    case "member.invited": {
      const inv = event.invitation;
      if (!matches(inv)) return state;
      const idx = state.invitations.findIndex((i) => i.id === inv.id);
      if (idx >= 0) {
        const next = state.invitations.slice();
        next[idx] = inv;
        return { ...state, invitations: next };
      }
      return { ...state, invitations: [...state.invitations, inv] };
    }
    case "member.joined": {
      let touched = false;
      const next: Invitation[] = [];
      for (const inv of state.invitations) {
        if (inv.targetUserId === event.userId && inv.usedAt === null) {
          touched = true;
          const updated: Invitation = {
            ...inv,
            usedAt: event.occurredAt,
            usedBy: event.userId,
          };
          if (matches(updated)) next.push(updated);
        } else {
          next.push(inv);
        }
      }
      if (!touched) return state;
      return { ...state, invitations: next };
    }
    default:
      return state;
  }
}

/**
 * Server-side portion of the status filter. The list endpoint exposes
 * two additive flags, includeExpired and includeUsed, which lift the
 * server's default exclusion of expired and used rows; there is no way
 * to exclusively select one partition, so the request fetches the
 * narrowest superset and matchInvitation narrows it client-side.
 */
function listOptionsForStatus(status: UseInvitationsStatus): {
  includeExpired?: boolean;
  includeUsed?: boolean;
} {
  switch (status) {
    case "pending":
      // The server's default exclusions already express "pending".
      return {};
    case "used":
      // includeUsed alone is not enough: a used invitation whose
      // expiresAt has since passed is still dropped by the expired-row
      // exclusion, so both flags must be lifted to receive every used
      // row.
      return { includeExpired: true, includeUsed: true };
    case "expired":
      return { includeExpired: true };
    case "all":
      return { includeExpired: true, includeUsed: true };
  }
}

/**
 * Client-side narrowing for what the server cannot express: the
 * include flags above are supersets, and pending-vs-expired is a
 * partition of unused rows by expiresAt against the clock. `now` is
 * supplied fresh on every invocation of the `matches` callback, so
 * each refetch, fetchMore, and SSE application re-evaluates expiry
 * against the current time; an already-rendered list is only
 * re-partitioned by the next fetch or event.
 */
function matchInvitation(inv: Invitation, status: UseInvitationsStatus, now: Date): boolean {
  const used = inv.usedAt !== null;
  const expired = inv.expiresAt !== null && inv.expiresAt.getTime() <= now.getTime();
  switch (status) {
    case "all":
      return true;
    case "pending":
      return !used && !expired;
    case "used":
      return used;
    case "expired":
      return !used && expired;
  }
}

export function useInvitations(
  groupId: GroupId,
  opts?: UseInvitationsOptions,
): UseInvitationsResult {
  const junjo = useJunjo();
  const hub = useSubscriptionHub();
  const status: UseInvitationsStatus = opts?.status ?? "pending";
  const limit = opts?.limit;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  // Holds the generation that owns the in-flight page request, or null
  // when none is in flight. Generation-aware so a stale request's
  // finally cannot clear a flag a newer generation owns (which would
  // let a duplicate page request slip through).
  const inflightMoreRef = useRef<number | null>(null);

  const matches = useCallback<InvitationMatcher>(
    (inv) => matchInvitation(inv, status, new Date()),
    [status],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;

  const invitationsRef = useRef(state.invitations);
  invitationsRef.current = state.invitations;

  const applyOptimistic = useCallback((updater: InvitationUpdater): (() => void) => {
    const snapshot = invitationsRef.current;
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
      const listOpts: ListInvitationsOptions = { ...listOptionsForStatus(status) };
      if (limit !== undefined) listOpts.limit = limit;
      const page = await junjo.invitations.list(groupId, listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        invitations: page.items.filter(matches),
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, groupId, status, limit, matches]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current === null) return;
    if (inflightMoreRef.current !== null) return;
    const generation = generationRef.current;
    inflightMoreRef.current = generation;
    dispatch({ type: "fetch_more_start" });
    try {
      const listOpts: ListInvitationsOptions = {
        ...listOptionsForStatus(status),
        cursor: cursorRef.current,
      };
      if (limit !== undefined) listOpts.limit = limit;
      const page = await junjo.invitations.list(groupId, listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_more_success",
        invitations: page.items.filter(matches),
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
  }, [junjo, groupId, status, limit, matches]);

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
    invitations: state.invitations,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    error: state.error,
    refetch,
    fetchMore,
    applyOptimistic,
  };
}
