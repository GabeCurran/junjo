import { z } from "zod";
import { pageLimit } from "./page.schema.js";

const VISIBILITY = ["public", "invite-only", "secret"] as const;

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
    metadata: z.record(z.unknown()).optional(),
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

export const listGroupsQuery = z.object({
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
  gameId: z.string().min(1).optional(),
  viewer: z.string().min(1).optional(),
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
    metadata: z.record(z.unknown()).optional(),
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
// handful of levels deep (faction -> guild -> sub-guild); the cap is
// a defensive guard against a corrupted state with unbounded recursion.
export const MAX_PARENT_DEPTH = 100;
