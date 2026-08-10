import type { ListBansOptions } from "@junjo.io/sdk";
import type { Ban } from "@junjo.io/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useJunjo } from "./useJunjo.js";

export interface UseBansOptions {
  /**
   * Default false. When true, also returns rows whose `expiresAt` is in
   * the past (the runtime ban-check ignores those, but operators may
   * want them in a dashboard).
   */
  includeExpired?: boolean;
  limit?: number;
}

export interface UseBansResult {
  /** Game-level bans accumulated so far, in server page order. */
  bans: Ban[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
}

interface State {
  bans: Ban[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
}

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; bans: Ban[]; hasMore: boolean }
  | { type: "fetch_error"; error: Error }
  | { type: "fetch_more_start" }
  | { type: "fetch_more_success"; bans: Ban[]; hasMore: boolean }
  | { type: "fetch_more_error"; error: Error };

const INITIAL_STATE: State = {
  bans: [],
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
        bans: action.bans,
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
      const seen = new Set(state.bans.map((b) => b.id));
      const additions = action.bans.filter((b) => !seen.has(b.id));
      return {
        ...state,
        bans: [...state.bans, ...additions],
        loadingMore: false,
        hasMore: action.hasMore,
        error: null,
      };
    }
    case "fetch_more_error":
      return { ...state, loadingMore: false, error: action.error };
  }
}

/**
 * The game's ban list (`bans.list`), cursor-paginated: the first page
 * loads on mount, `fetchMore` appends pages while `hasMore` is true.
 * No SSE here on purpose: game-level bans are delivered via webhooks
 * only (SSE channels are per-group, and game.user.banned/unbanned have
 * no group to route through), so refetch after mutations or on
 * operator-triggered refresh. Per-group ban events (member.banned,
 * member.unbanned) arrive on the group's SSE stream, where the roster
 * hooks (`useMembers`, `useGroup`) apply the status change to rows
 * they have already loaded; this hook covers game-wide bans only.
 */
export function useBans(opts?: UseBansOptions): UseBansResult {
  const junjo = useJunjo();
  const includeExpired = opts?.includeExpired;
  const limit = opts?.limit;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  // Holds the generation that owns the in-flight page request, or null
  // when none is in flight. Generation-aware so a stale request's
  // finally cannot clear a flag a newer generation owns (which would
  // let a duplicate page request slip through).
  const inflightMoreRef = useRef<number | null>(null);

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    cursorRef.current = null;
    inflightMoreRef.current = null;
    dispatch({ type: "fetch_start" });
    try {
      const listOpts: ListBansOptions = {};
      if (limit !== undefined) listOpts.limit = limit;
      if (includeExpired !== undefined) listOpts.includeExpired = includeExpired;
      const page = await junjo.bans.list(listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        bans: page.items,
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, includeExpired, limit]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current === null) return;
    if (inflightMoreRef.current !== null) return;
    const generation = generationRef.current;
    inflightMoreRef.current = generation;
    dispatch({ type: "fetch_more_start" });
    try {
      const listOpts: ListBansOptions = { cursor: cursorRef.current };
      if (limit !== undefined) listOpts.limit = limit;
      if (includeExpired !== undefined) listOpts.includeExpired = includeExpired;
      const page = await junjo.bans.list(listOpts);
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_more_success",
        bans: page.items,
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
  }, [junjo, includeExpired, limit]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    bans: state.bans,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    error: state.error,
    refetch,
    fetchMore,
  };
}
