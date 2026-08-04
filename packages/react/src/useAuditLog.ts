import type { AuditAction, AuditEntry, GroupId, ListAuditOptions } from "@junjo.io/shared";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { useJunjo } from "./useJunjo.js";

export interface UseAuditLogOptions {
  actions?: AuditAction[];
  limit?: number;
}

export interface UseAuditLogResult {
  entries: AuditEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
  fetchMore: () => Promise<void>;
}

interface State {
  entries: AuditEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  error: Error | null;
}

type Action =
  | { type: "fetch_start" }
  | { type: "fetch_success"; entries: AuditEntry[]; hasMore: boolean }
  | { type: "fetch_error"; error: Error }
  | { type: "fetch_more_start" }
  | { type: "fetch_more_success"; entries: AuditEntry[]; hasMore: boolean }
  | { type: "fetch_more_error"; error: Error };

const INITIAL_STATE: State = {
  entries: [],
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
        entries: action.entries,
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
      const seen = new Set(state.entries.map((e) => e.id));
      const additions = action.entries.filter((e) => !seen.has(e.id));
      return {
        ...state,
        entries: [...state.entries, ...additions],
        loadingMore: false,
        hasMore: action.hasMore,
        error: null,
      };
    }
    case "fetch_more_error":
      return { ...state, loadingMore: false, error: action.error };
  }
}

export function useAuditLog(groupId: GroupId, opts?: UseAuditLogOptions): UseAuditLogResult {
  const junjo = useJunjo();
  const limit = opts?.limit;
  const actions = opts?.actions;
  const actionsKey = useMemo(
    () => (actions !== undefined ? actions.slice().sort().join("|") : ""),
    [actions],
  );
  const actionsRef = useRef<AuditAction[] | undefined>(actions);
  actionsRef.current = actions;

  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const generationRef = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const inflightMoreRef = useRef(false);

  const buildListOpts = useCallback(
    (before?: Date): ListAuditOptions => {
      // actionsKey detunes refetch on actions-array reference / reordering
      // changes; the actual array passes through actionsRef so only membership
      // changes propagate.
      void actionsKey;
      const out: ListAuditOptions = {};
      if (limit !== undefined) out.limit = limit;
      if (before !== undefined) out.before = before;
      const a = actionsRef.current;
      if (a !== undefined && a.length > 0) out.actions = a;
      return out;
    },
    [limit, actionsKey],
  );

  const refetch = useCallback(async (): Promise<void> => {
    const generation = ++generationRef.current;
    cursorRef.current = null;
    inflightMoreRef.current = false;
    dispatch({ type: "fetch_start" });
    try {
      const page = await junjo.audit.list(groupId, buildListOpts());
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_success",
        entries: page.items,
        hasMore: page.nextCursor !== null,
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      dispatch({
        type: "fetch_error",
        error: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }, [junjo, groupId, buildListOpts]);

  const fetchMore = useCallback(async (): Promise<void> => {
    if (cursorRef.current === null) return;
    if (inflightMoreRef.current) return;
    inflightMoreRef.current = true;
    const generation = generationRef.current;
    dispatch({ type: "fetch_more_start" });
    try {
      const before = new Date(cursorRef.current);
      const page = await junjo.audit.list(groupId, buildListOpts(before));
      if (generation !== generationRef.current) return;
      cursorRef.current = page.nextCursor;
      dispatch({
        type: "fetch_more_success",
        entries: page.items,
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
  }, [junjo, groupId, buildListOpts]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return {
    entries: state.entries,
    loading: state.loading,
    loadingMore: state.loadingMore,
    hasMore: state.hasMore,
    error: state.error,
    refetch,
    fetchMore,
  };
}
