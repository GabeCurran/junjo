import {
  FRIENDS_LIST_VISIBILITY_VALUES,
  MAX_DECLARED_ID_FORMATS,
  MAX_GROUP_KINDS,
  MAX_PREFERRED_NAMESPACES,
  PERMISSION_MODES,
  USER_ID_FORMATS,
  USER_ID_NAMESPACE_PATTERN,
} from "@junjo.io/shared";
import { z } from "zod";
import { normalizeContextInheritance } from "../permissionContext.js";

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

// Changing `mode` is refused while stored keys would change meaning
// under the new mode; that check needs the database, so the route runs
// it rather than this schema.
//
// `contexts` is stated in full and replaces the stored map, like
// `identity.formats`. It is validated and stored folded; see
// `normalizeContextInheritance` for what is refused.
const contextInheritanceSchema = z
  .record(z.string(), z.object({ inherit: z.record(z.string(), z.array(z.string())) }).strict())
  .transform((raw, ctx) => {
    const result = normalizeContextInheritance(raw);
    if ("error" in result) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: result.error });
      return z.NEVER;
    }
    return result.contexts;
  });

const permissionsPatchSchema = z
  .object({
    mode: z.enum(PERMISSION_MODES).optional(),
    contexts: contextInheritanceSchema.optional(),
  })
  .strict();

export const NAMESPACE_FORMAT_MESSAGE =
  "namespace must be 1 to 32 lowercase letters, digits, underscores or hyphens";

export const userIdNamespaceSchema = z
  .string()
  .regex(new RegExp(USER_ID_NAMESPACE_PATTERN), NAMESPACE_FORMAT_MESSAGE);

// An ordered namespace preference, as stored on API keys and webhook
// endpoints. Empty means no preference.
export const preferredNamespacesSchema = z
  .array(userIdNamespaceSchema)
  .max(MAX_PREFERRED_NAMESPACES)
  .refine((list) => new Set(list).size === list.length, "namespaces must not repeat");

// Declaring a format is refused while stored ids in that namespace do
// not match it; that check needs the database, so the route runs it.
const identityPatchSchema = z
  .object({
    formats: z
      .record(z.string(), z.enum(USER_ID_FORMATS))
      .superRefine((formats, ctx) => {
        const keys = Object.keys(formats);
        if (keys.length > MAX_DECLARED_ID_FORMATS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `at most ${MAX_DECLARED_ID_FORMATS} namespaces may declare a format`,
          });
        }
        for (const key of keys) {
          if (!userIdNamespaceSchema.safeParse(key).success) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: NAMESPACE_FORMAT_MESSAGE,
            });
          }
        }
      })
      .optional(),
  })
  .strict();

// Group kinds are open strings bounded like the create route's `kind`.
export const GROUP_KIND_MAX_LENGTH = 64;

const groupKindLimitsSchema = z
  .object({
    maxMembers: z.number().int().min(1).max(100_000).optional(),
    maxPerUser: z.number().int().min(1).max(1000).optional(),
    deleteWhenEmpty: z.boolean().optional(),
    idleDeleteHours: z.number().int().min(1).max(8760).optional(),
  })
  .strict();

// `kinds` is stated in full and replaces the stored map, like
// `identity.formats`; a kind left out loses its limits.
const groupsPatchSchema = z
  .object({
    kinds: z
      .record(z.string(), groupKindLimitsSchema)
      .superRefine((kinds, ctx) => {
        const keys = Object.keys(kinds);
        if (keys.length > MAX_GROUP_KINDS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `at most ${MAX_GROUP_KINDS} group kinds may set limits`,
          });
        }
        for (const key of keys) {
          if (key.length < 1 || key.length > GROUP_KIND_MAX_LENGTH) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [key],
              message: `group kind must be 1-${GROUP_KIND_MAX_LENGTH} characters`,
            });
          }
        }
      })
      .optional(),
  })
  .strict();

export const gameConfigPatchSchema = z
  .object({
    friends: friendsPatchSchema.optional(),
    blocks: blocksPatchSchema.optional(),
    permissions: permissionsPatchSchema.optional(),
    identity: identityPatchSchema.optional(),
    groups: groupsPatchSchema.optional(),
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
