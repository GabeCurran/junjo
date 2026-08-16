import { z } from "zod";
import { pageLimit } from "./page.schema.js";

const VISIBILITY = ["public", "invite-only", "secret"] as const;

// Group metadata is a free-form JSON object; cap its serialized size so it
// cannot become a large covert data store carried on every group read.
// 16 KB fits generous structured metadata (flags, cosmetic ids, small
// nested config) while staying well under the 1 MB global body cap.
// Measured on JSON.stringify length (UTF-16 code units), which is the
// documented cap unit rather than exact byte count.
export const GROUP_METADATA_MAX_SERIALIZED = 16 * 1024;
const groupMetadata = z
  .record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= GROUP_METADATA_MAX_SERIALIZED, {
    message: `metadata exceeds ${GROUP_METADATA_MAX_SERIALIZED} serialized characters`,
  });

// Passcode bounds. 4 chars is low enough to allow short numeric PINs
// (room codes, "1234"-style); 128 is generous enough to fit a phrase
// without becoming a covert long-form data field.
export const PASSCODE_MIN_LENGTH = 4;
export const PASSCODE_MAX_LENGTH = 128;
const passcodeString = z.string().min(PASSCODE_MIN_LENGTH).max(PASSCODE_MAX_LENGTH);

export const createGroupBody = z
  .object({
    kind: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    visibility: z.enum(VISIBILITY).optional(),
    metadata: groupMetadata.optional(),
    defaultRoleId: z.string().min(1).optional(),
    // Same external-userId validation as joinGroupBody.
    creatorUserId: z.string().min(1).optional(),
    // Optional shared-secret join gate. Omitted = no passcode; a string
    // hashes + stores. `null` is rejected on create (use omit instead);
    // null is only meaningful on update for clearing.
    passcode: passcodeString.optional(),
  })
  .strict();

export type CreateGroupBody = z.infer<typeof createGroupBody>;

// `kind` filters on exact match, bounded by the same length the create
// body allows so an over-long value is a 400 rather than a guaranteed
// empty page. An unknown kind is a valid query that matches nothing.
export const listGroupsQuery = z.object({
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
  gameId: z.string().min(1).optional(),
  viewer: z.string().min(1).optional(),
  kind: z.string().min(1).max(64).optional(),
});

export type ListGroupsQuery = z.infer<typeof listGroupsQuery>;

// `viewer` is the user the caller wants visibility evaluated against.
// Omitting it (server-to-server / admin) bypasses the secret-group filter.
export const viewerQuery = z.object({
  viewer: z.string().min(1).optional(),
});

export type ViewerQuery = z.infer<typeof viewerQuery>;

export const joinGroupBody = z.object({
  userId: z.string().min(1),
  // Required when the target group has a passcode set; ignored
  // otherwise. The validator only checks shape (length); the
  // join handler verifies against the stored hash.
  passcode: passcodeString.optional(),
});

export type JoinGroupBody = z.infer<typeof joinGroupBody>;

export const updateGroupBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    visibility: z.enum(VISIBILITY).optional(),
    metadata: groupMetadata.optional(),
    defaultRoleId: z.string().min(1).nullable().optional(),
    // String = set new passcode (replaces any prior); null = clear.
    // Omit to leave the existing passcode (if any) untouched.
    passcode: passcodeString.nullable().optional(),
  })
  .strict()
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export type UpdateGroupBody = z.infer<typeof updateGroupBody>;

// Server-to-server member creation. Unlike `join` this ignores
// `visibility`, so provisioning does not have to make internal
// authorization groups publicly joinable to populate them. Bans are
// still enforced: a ban is state the game set deliberately, and
// silently overriding one during a bulk provision would be wrong.
export const addMemberBody = z
  .object({
    userId: z.string().min(1),
    // Assigned in the same transaction as the membership, so a
    // provisioner does not need a second call and cannot leave a
    // member role-less if the second call fails.
    roleId: z.string().min(1).optional(),
    // Attributes the audit entry to a moderator. Mirrors the ban /
    // unban / role-assign actor pattern.
    actorUserId: z.string().min(1).optional(),
  })
  .strict();

export type AddMemberBody = z.infer<typeof addMemberBody>;

export const leaveGroupBody = z.object({
  userId: z.string().min(1),
});

export type LeaveGroupBody = z.infer<typeof leaveGroupBody>;

export const kickMemberBody = z
  .object({
    reason: z.string().max(500).nullable().optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export type KickMemberBody = z.infer<typeof kickMemberBody>;

// Per-group ban. Mirrors `kickMemberBody` for `reason`; adds optional
// `expiresAt` for time-bounded bans (omit / null = permanent). The
// validator rejects past timestamps to catch typos client-side; lazy
// expiry on read still treats already-elapsed values as not-banned for
// rows that pre-date this validation. Optional `actorUserId` attributes
// the action to a specific moderator (mirrors `createGameBanBody`).
export const banMemberBody = z
  .object({
    reason: z.string().max(500).nullable().optional(),
    expiresAt: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "expiresAt must be an ISO 8601 date",
      })
      .nullable()
      .optional(),
    actorUserId: z.string().min(1).optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export type BanMemberBody = z.infer<typeof banMemberBody>;

// Per-group unban. Body is genuinely optional (no actor = null actor).
export const unbanMemberBody = z
  .object({
    actorUserId: z.string().min(1).optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export type UnbanMemberBody = z.infer<typeof unbanMemberBody>;

// Role assign / unassign. Body is fully optional; supplying
// `actorUserId` attributes the action in audit + the role.changed
// event. Mirrors the ban / unban actor pattern.
export const roleAssignBody = z
  .object({
    actorUserId: z.string().min(1).optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export type RoleAssignBody = z.infer<typeof roleAssignBody>;

// Opt-in page envelope for the group role list. The route historically
// answers with a bare array, and a published client deserializes it as
// one, so the envelope cannot become the default without breaking those
// callers against an upgraded server. `nextCursor` is always null: the
// route returns every role in the group, it does not paginate.
export const listRolesQuery = z.object({
  paged: z
    .enum(["true", "false"])
    .optional()
    .transform((s) => s === "true"),
});

export type ListRolesQuery = z.infer<typeof listRolesQuery>;

export const bulkInviteQuery = z.object({
  roleId: z.string().min(1).optional(),
});

export type BulkInviteQuery = z.infer<typeof bulkInviteQuery>;

// Relationship `type` is dev-defined (the schema stores it as a free
// string). Capped at 64 chars to match `Role.name` (the other open string
// devs commonly hand the API).
export const RELATIONSHIP_TYPE_MAX_LENGTH = 64;

export const setRelationshipBody = z.object({
  type: z.string().min(1).max(RELATIONSHIP_TYPE_MAX_LENGTH),
  mutual: z.boolean().optional(),
});

export type SetRelationshipBody = z.infer<typeof setRelationshipBody>;

// Strict "true" / "false" matches the precedent set by the
// `includeExpired` / `includeUsed` flags on `listInvitationsQuery`.
export const clearRelationshipQuery = z.object({
  mutual: z.enum(["true", "false"]).optional(),
});

export type ClearRelationshipQuery = z.infer<typeof clearRelationshipQuery>;

// Sub-group / alliance parent. `parentGroupId: null` clears the parent;
// a non-null value sets it. The body must always carry the field
// (omitting it is rejected) so the call's intent is explicit.
export const setParentBody = z.object({
  parentGroupId: z.string().min(1).nullable(),
});

export type SetParentBody = z.infer<typeof setParentBody>;

// Hard upper bound on how deep the cycle-detection walk goes when
// resolving a candidate ancestor chain. Practical hierarchies are a
// handful of levels deep; the cap is a defensive guard against a
// corrupted state with unbounded recursion.
export const MAX_PARENT_DEPTH = 100;
