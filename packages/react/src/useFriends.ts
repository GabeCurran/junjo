import type {
  Block,
  FriendRequestList,
  FriendSuggestion,
  FriendTag,
  Friendship,
  Junjo,
  UserId,
  UserVisibilitySettings,
} from "@junjo.io/sdk";
import { useEffect, useRef, useState } from "react";
import { useJunjo } from "./useJunjo.js";

// Shared shape for fetch + refetch hooks. We deliberately avoid SSE-
// driven live updates here: friend events have no per-group SSE channel
// in V1 (they flow through webhooks instead), so consumers refetch on
// mutation completion or operator-triggered refresh.

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

function useAsync<T>(junjo: Junjo, loader: () => Promise<T>, depKey: string): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Latest loader is captured by ref so refetch sees it without
  // listing it in deps (which would create a new identity each render
  // on caller-supplied lambdas).
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const refetch = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loaderRef.current();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  // The client is a dep so a JunjoProvider client swap refetches
  // against the new client instead of serving the old client's data.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch reads via ref; junjo + depKey are the canonical signals that a refetch is needed
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loaderRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [junjo, depKey]);

  return { data, loading, error, refetch };
}

// =====================================================================
// Friends list
// =====================================================================

export interface UseFriendsOptions {
  limit?: number;
  tagId?: string;
  viewer?: UserId;
}

export interface UseFriendsResult {
  friends: Friendship[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Pagination model differs from useMembers/useInvitations on purpose:
 * this hook fetches only the first page (up to `limit` items) and does
 * not expose loadingMore/hasMore or accumulate pages. Pass a larger
 * `limit` or page via the SDK's `friends.list` cursor directly when
 * the full list is needed.
 */
export function useFriends(userId: UserId, opts?: UseFriendsOptions): UseFriendsResult {
  const junjo = useJunjo();
  const limit = opts?.limit;
  const tagId = opts?.tagId;
  const viewer = opts?.viewer;
  const state = useAsync(
    junjo,
    () => junjo.friends.list(userId, { limit, tagId, viewer }).then((p) => p.items),
    `friends|${userId}|${limit ?? ""}|${tagId ?? ""}|${viewer ?? ""}`,
  );
  return {
    friends: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}

// =====================================================================
// Friend requests
// =====================================================================

export interface UseFriendRequestsOptions {
  direction?: "in" | "out" | "both";
}

export interface UseFriendRequestsResult {
  requests: FriendRequestList;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

const EMPTY_REQUESTS: FriendRequestList = { inbound: [], outbound: [] };

/**
 * Unlike useMembers/useInvitations there is no loadingMore/hasMore:
 * the friend-requests endpoint returns the full inbound/outbound set
 * in one response, so no pagination state exists to expose.
 */
export function useFriendRequests(
  userId: UserId,
  opts?: UseFriendRequestsOptions,
): UseFriendRequestsResult {
  const junjo = useJunjo();
  const direction = opts?.direction;
  const state = useAsync(
    junjo,
    () => junjo.friends.requests.list(userId, { direction }),
    `friend-requests|${userId}|${direction ?? ""}`,
  );
  return {
    requests: state.data ?? EMPTY_REQUESTS,
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}

// =====================================================================
// Mutual-friend suggestions
// =====================================================================

export interface UseFriendSuggestionsOptions {
  limit?: number;
}

export interface UseFriendSuggestionsResult {
  suggestions: FriendSuggestion[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useFriendSuggestions(
  userId: UserId,
  opts?: UseFriendSuggestionsOptions,
): UseFriendSuggestionsResult {
  const junjo = useJunjo();
  const limit = opts?.limit;
  const state = useAsync(
    junjo,
    () => junjo.friends.suggestions(userId, { limit }),
    `suggestions|${userId}|${limit ?? ""}`,
  );
  return {
    suggestions: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}

// =====================================================================
// Blocklist
// =====================================================================

export interface UseBlocklistResult {
  blocks: Block[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Unlike useMembers/useInvitations there is no loadingMore/hasMore:
 * the blocks endpoint returns the full set in one response.
 */
export function useBlocklist(userId: UserId): UseBlocklistResult {
  const junjo = useJunjo();
  const state = useAsync(junjo, () => junjo.friends.blocks.list(userId), `blocks|${userId}`);
  return {
    blocks: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}

// =====================================================================
// Friend tags
// =====================================================================

export interface UseFriendTagsResult {
  tags: FriendTag[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * Unlike useMembers/useInvitations there is no loadingMore/hasMore:
 * the friend-tags endpoint returns the full set in one response.
 */
export function useFriendTags(userId: UserId): UseFriendTagsResult {
  const junjo = useJunjo();
  const state = useAsync(junjo, () => junjo.friends.tags.list(userId), `tags|${userId}`);
  return {
    tags: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}

// =====================================================================
// User visibility setting
// =====================================================================

export interface UseUserVisibilityResult {
  visibility: UserVisibilitySettings | null;
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function useUserVisibility(userId: UserId): UseUserVisibilityResult {
  const junjo = useJunjo();
  const state = useAsync(junjo, () => junjo.friends.visibility.get(userId), `visibility|${userId}`);
  return {
    visibility: state.data,
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}
