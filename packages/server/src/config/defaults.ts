import type {
  FriendsListVisibility,
  GameConfig,
  GameConfigFriendsVisibility,
  PartialGameConfig,
} from "@junjo.io/shared";
import { FRIENDS_LIST_VISIBILITY_VALUES } from "@junjo.io/shared";

// Single source of truth for the default GameConfig. New games persist
// `{}` to the `Game.config` column and the resolver fills the rest at
// read time, so adding a future toggle here does not require a data
// migration on existing rows.
export const DEFAULT_GAME_CONFIG: GameConfig = {
  friends: {
    enabled: true,
    scope: "per-game",
    requestsRequired: true,
    maxFriends: 1000,
    maxPendingRequests: 100,
    tags: {
      enabled: true,
      maxPerUser: 20,
    },
    discovery: {
      enabled: true,
      minMutuals: 2,
    },
    visibility: {
      allowed: ["private", "friends-only"],
      default: "private",
    },
  },
  blocks: {
    enabled: true,
  },
};

// Resolves a partial config against `DEFAULT_GAME_CONFIG`. Pure function;
// safe to call on both stored values (which are always partial) and on
// PATCH payloads (also partial). The result is a fully-populated tree
// that route handlers can read without optional-chaining.
//
// Visibility invariants enforced here, not at the Zod layer, because
// they depend on cross-field state (`default` must be in `allowed`):
//
//   - `allowed` is de-duped and sorted to a canonical order so equality
//     checks are stable.
//   - If `default` is not in the resolved `allowed` set, it falls back
//     to the first value of `allowed` (or `"private"` if `allowed` is
//     empty, though Zod rejects empty `allowed`).
export function resolveGameConfig(partial: PartialGameConfig | null | undefined): GameConfig {
  const f = partial?.friends;
  const b = partial?.blocks;
  const dF = DEFAULT_GAME_CONFIG.friends;
  const dB = DEFAULT_GAME_CONFIG.blocks;

  const visibilityAllowed = canonicalVisibility(f?.visibility?.allowed ?? dF.visibility.allowed);
  const visibilityDefault: FriendsListVisibility =
    f?.visibility?.default && visibilityAllowed.includes(f.visibility.default)
      ? f.visibility.default
      : visibilityAllowed.includes(dF.visibility.default)
        ? dF.visibility.default
        : (visibilityAllowed[0] ?? "private");

  const visibility: GameConfigFriendsVisibility = {
    allowed: visibilityAllowed,
    default: visibilityDefault,
  };

  return {
    friends: {
      enabled: f?.enabled ?? dF.enabled,
      scope: f?.scope ?? dF.scope,
      requestsRequired: f?.requestsRequired ?? dF.requestsRequired,
      maxFriends: f?.maxFriends ?? dF.maxFriends,
      maxPendingRequests: f?.maxPendingRequests ?? dF.maxPendingRequests,
      tags: {
        enabled: f?.tags?.enabled ?? dF.tags.enabled,
        maxPerUser: f?.tags?.maxPerUser ?? dF.tags.maxPerUser,
      },
      discovery: {
        enabled: f?.discovery?.enabled ?? dF.discovery.enabled,
        minMutuals: f?.discovery?.minMutuals ?? dF.discovery.minMutuals,
      },
      visibility,
    },
    blocks: {
      enabled: b?.enabled ?? dB.enabled,
    },
  };
}

function canonicalVisibility(values: readonly FriendsListVisibility[]): FriendsListVisibility[] {
  const seen = new Set<FriendsListVisibility>();
  for (const v of values) seen.add(v);
  return FRIENDS_LIST_VISIBILITY_VALUES.filter((v) => seen.has(v));
}

// Deep-merges a PATCH payload into the existing stored config. Returns a
// `PartialGameConfig` (NOT a fully-resolved one) suitable for writing
// back to the `Game.config` column. The route layer runs this, persists
// the result, and then re-resolves for the response so callers always
// see what the next read would see.
export function mergeGameConfig(
  existing: PartialGameConfig | null | undefined,
  patch: PartialGameConfig,
): PartialGameConfig {
  const merged: PartialGameConfig = { ...(existing ?? {}) };

  if (patch.friends) {
    const existingFriends = existing?.friends ?? {};
    merged.friends = {
      ...existingFriends,
      ...patch.friends,
      tags: patch.friends.tags
        ? { ...(existingFriends.tags ?? {}), ...patch.friends.tags }
        : existingFriends.tags,
      discovery: patch.friends.discovery
        ? { ...(existingFriends.discovery ?? {}), ...patch.friends.discovery }
        : existingFriends.discovery,
      visibility: patch.friends.visibility
        ? { ...(existingFriends.visibility ?? {}), ...patch.friends.visibility }
        : existingFriends.visibility,
    };
  }

  if (patch.blocks) {
    merged.blocks = { ...(existing?.blocks ?? {}), ...patch.blocks };
  }

  return merged;
}
