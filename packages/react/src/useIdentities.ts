import type { LinkedIdentity, UserId } from "@junjo.io/sdk";
import { useAsync } from "./useAsync.js";
import { useJunjo } from "./useJunjo.js";

export interface UseIdentitiesResult {
  /** Every id of the person `userId` belongs to, earliest-linked first. */
  identities: LinkedIdentity[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * The linked ids of one person (`identities.list`). The endpoint
 * returns the full set in one response, so there is no pagination
 * state. Identity events are delivered by webhook only, so refetch
 * after a link or unlink. An id the game has never seen yields an
 * empty list.
 */
export function useIdentities(userId: UserId): UseIdentitiesResult {
  const junjo = useJunjo();
  const state = useAsync(junjo, () => junjo.identities.list(userId), `identities|${userId}`);
  return {
    identities: state.data ?? [],
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}
