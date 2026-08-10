import type { GameId, Group, UserId } from "@junjo.io/shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useJunjo } from "./useJunjo.js";

export interface UseGroupsOptions {
  /** Filter to one game. Omit to list across the API key's scope. */
  gameId?: GameId;
  /**
   * External userId to scope visibility to: secret groups the viewer is
   * not a member of are excluded. Omit for the admin/server-side view.
   */
  viewer?: UserId;
  limit?: number;
}

export interface UseGroupsResult {
  /** Groups accumulated so far, in server page order. */
  groups: Group[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
}

interface State {
  groups: Group[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
}

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; groups: Group[]; hasMore: boolean }
  | { type: "fetch_error"; error: Error }
  | { type: "fetch_more_start" }
  | { type: "fetch_more_success"; groups: Group[]; hasMore: boolean }
  | { type: "fetch_more_error"; error: Error };

const INITIAL_STATE: State = {
  groups: [],
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
        groups: action.groups,
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
      const seen = new Set(state.groups.map((g) => g.id));
      const additions = action.groups.filter((g) => !seen.has(g.id));
      return {
        ...state,
        groups: [...state.groups, ...additions],
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
 * The group directory (`groups.list`), cursor-paginated: the first page
 * loads on mount, `fetchMore` appends pages while `hasMore` is true.
 * No SSE here on purpose: event streams are per-group, so there is no
 * channel that could announce list-level changes (a group created or
 * deleted elsewhere); refetch after mutations or on operator-triggered
 * refresh. For one group kept live, use `useGroup`.
 */
export function useGroups(opts?: UseGroupsOptions): UseGroupsResult {
  const junjo = useJunjo();
  const gameId = opts?.gameId;
  const viewer = opts?.viewer;
  const limit = opts?.limit;
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  // Holds the generation that owns the in-flight page request, or null
  // when none is in flight. Generation-aware so a stale request's
  // finally cannot clear a flag a newer generation owns (which would
  // let a duplicate page request slip through).
  const inflightMoreRef = useRef<number | null>(null);

  const buildListOpts = useCallback(
    (cursor?: string) => {
      const out: { limit?: number; cursor?: string; gameId?: GameId; viewer?: UserId } = {};
      if (limit !== undefined) out.limit = limit;
      if (cursor !== undefined) out.cursor = cursor;
      if (gameId !== undefined) out.gameId = gameId;
      if (viewer !== undefined) out.viewer = viewer;
      return out;
    },
    [limit, gameId, viewer],
  );

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    cursorRef.current = null;
    inflightMoreRef.current = null;
    dispatch({ type: "fetch_start" });
    try {
      const page = await junjo.groups.list(buildListOpts());
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        groups: page.items,
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, buildListOpts]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current === null) return;
    if (inflightMoreRef.current !== null) return;
    const generation = generationRef.current;
    inflightMoreRef.current = generation;
    dispatch({ type: "fetch_more_start" });
    try {
      const page = await junjo.groups.list(buildListOpts(cursorRef.current));
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_more_success",
        groups: page.items,
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
  }, [junjo, buildListOpts]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    groups: state.groups,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    error: state.error,
    refetch,
    fetchMore,
  };
}
