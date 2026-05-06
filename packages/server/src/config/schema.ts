import { FRIENDS_LIST_VISIBILITY_VALUES } from "@junjo/shared";
import { z } from "zod";

// Validates a PATCH /v1/admin/games/:gameId/config payload. Every leaf
// is optional (the merge layer fills in unspecified branches from the
// existing stored config); but each leaf that IS present must be
// well-formed.
//
// The cross-field invariant that `friends.visibility.default` must be
// in `friends.visibility.allowed` is enforced by `resolveGameConfig`
// rather than here, because the resolver knows the existing stored
// state and can compute the post-merge `allowed` set; Zod cannot.
export const friendsListVisibilitySchema = z.enum(FRIENDS_LIST_VISIBILITY_VALUES);

const friendsTagsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxPerUser: z.number().int().min(1).max(1000).optional(),
  })
  .strict();

const friendsDiscoveryPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    minMutuals: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const friendsVisibilityPatchSchema = z
  .object({
    allowed: z.array(friendsListVisibilitySchema).min(1).optional(),
    default: friendsListVisibilitySchema.optional(),
  })
  .strict();

const friendsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    scope: z.enum(["per-game", "network"]).optional(),
    requestsRequired: z.boolean().optional(),
    // Practical caps that prevent operator typos from creating
    // pathological values; the resolved defaults sit comfortably inside.
    maxFriends: z.number().int().min(1).max(100_000).optional(),
    maxPendingRequests: z.number().int().min(1).max(10_000).optional(),
    tags: friendsTagsPatchSchema.optional(),
    discovery: friendsDiscoveryPatchSchema.optional(),
    visibility: friendsVisibilityPatchSchema.optional(),
  })
  .strict();

const blocksPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .strict();

export const gameConfigPatchSchema = z
  .object({
    friends: friendsPatchSchema.optional(),
    blocks: blocksPatchSchema.optional(),
  })
  .strict();

// PATCH /v1/admin/games/:gameId/config also accepts a top-level
// `networkId` field. It is stored on the Game row, not inside the
// JSON config, but the dashboard surfaces it on the same form.
//   - undefined: no change.
//   - null:      clears the networkId (game leaves any shared network).
//   - non-empty string: sets the networkId.
export const adminUpdateGameConfigBody = z
  .object({
    config: gameConfigPatchSchema.optional(),
    networkId: z.union([z.string().min(1).max(128), z.null()]).optional(),
  })
  .strict();

export type AdminUpdateGameConfigBody = z.infer<typeof adminUpdateGameConfigBody>;
