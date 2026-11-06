import type { Sanction, UserId } from "@junjo.io/sdk";
import { EMPTY_LIST } from "./empty.js";
import { useAsync } from "./useAsync.js";
import { useJunjo } from "./useJunjo.js";

export interface UseSanctionsResult {
  /** The person's active sanctions, newest first. */
  sanctions: Sanction[];
  loading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

/**
 * The active sanctions of one person (`sanctions.forUser`). The endpoint
 * returns the full set in one response, so there is no pagination
 * state. Sanction events carry no group, so no group stream delivers
 * them and this hook does not update on its own: refetch after a write,
 * or on a `game.user.sanctioned` / `game.user.unsanctioned` event from
 * the game stream. Expiry is lazy and emits nothing, so a sanction whose
 * `expiresAt` has passed stays in the list until the next fetch. A user
 * the game has never seen yields an empty list.
 */
export function useSanctions(userId: UserId): UseSanctionsResult {
  const junjo = useJunjo();
  const state = useAsync(junjo, () => junjo.sanctions.forUser(userId), `sanctions|${userId}`);
  return {
    sanctions: state.data ?? EMPTY_LIST,
    loading: state.loading,
    error: state.error,
    refetch: state.refetch,
  };
}
