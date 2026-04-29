// @cloud-only
//
// Schemas for admin-token-gated endpoints (Phase 11.2a, 11.3a). Co-located
// with `routes/admin.ts` per the existing route-module convention.

import { z } from "zod";

export const GAME_NAME_MAX_LENGTH = 200;

export const listRecentAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const listAdminGamesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createGameBody = z.object({
  name: z.string().min(1).max(GAME_NAME_MAX_LENGTH),
});

// Phase 11.4a: cross-game group browser. Caps mirror the per-game `Group`
// schema (`name` 1-120, `kind` 1-64) plus the `GroupVisibility` union.
export const ADMIN_GROUP_NAME_SEARCH_MAX_LENGTH = 120;
export const ADMIN_GROUP_KIND_MAX_LENGTH = 64;
export const ADMIN_GROUP_VISIBILITIES = ["public", "invite-only", "secret"] as const;
export const ADMIN_GROUP_SORT_FIELDS = ["createdAt", "name", "memberCount"] as const;
export const ADMIN_GROUP_SORT_ORDERS = ["asc", "desc"] as const;
// Hard upper bound on the matching set when sort=memberCount. The handler
// fetches every matching row, batches member counts, sorts in memory, and
// slices to the requested page; pulling unbounded rows for an in-memory
// sort would defeat the dashboard's bounded-work expectations. If a game
// genuinely has more than this many groups, the operator must narrow with
// the q / kind / visibility filters before sorting by memberCount; the
// route returns 400 with that hint rather than silently truncating.
export const ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS = 500;

export const listAdminGroupsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().min(1).max(ADMIN_GROUP_NAME_SEARCH_MAX_LENGTH).optional(),
  kind: z.string().min(1).max(ADMIN_GROUP_KIND_MAX_LENGTH).optional(),
  visibility: z.enum(ADMIN_GROUP_VISIBILITIES).optional(),
  sort: z.enum(ADMIN_GROUP_SORT_FIELDS).default("createdAt"),
  order: z.enum(ADMIN_GROUP_SORT_ORDERS).default("desc"),
});

// Phase 11.5a: cross-game group detail + member listing for the dashboard's
// group detail page (members tab). The status filter mirrors the four
// `GroupMember.status` values plus the "all" wildcard.
export const ADMIN_MEMBER_STATUSES = ["active", "left", "kicked", "invited", "all"] as const;

export const listAdminGroupMembersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(ADMIN_MEMBER_STATUSES).default("active"),
  q: z.string().min(1).max(255).optional(),
});

// Phase 11.5c-i: member row-action bodies. Re-exported from the per-game
// schemas verbatim so the admin and per-game routes accept identical
// payloads. The admin endpoints add the `gameId` path scope; everything
// else is shared.
export const ADMIN_MEMBER_NOTES_MAX_LENGTH = 5000;
export const ADMIN_MEMBER_KICK_REASON_MAX_LENGTH = 500;
export const ADMIN_PERMISSION_KEY_MAX_LENGTH = 128;

export const adminKickMemberBody = z
  .object({
    reason: z.string().max(ADMIN_MEMBER_KICK_REASON_MAX_LENGTH).nullable().optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export const adminUpdateMemberBody = z
  .object({
    metadata: z.record(z.unknown()).optional(),
    notesPublic: z.string().max(ADMIN_MEMBER_NOTES_MAX_LENGTH).nullable().optional(),
    notesPrivate: z.string().max(ADMIN_MEMBER_NOTES_MAX_LENGTH).nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export const adminOverridePermissionBody = z.object({
  grant: z.boolean(),
});

// Phase 11.5d-i: cross-game invitation creation. Mirrors the per-game
// `createInvitationBody` shape exactly so a dashboard caller can ship the
// same JSON payload either through the admin endpoint or, eventually, a
// per-game-key path. The expiresIn regex matches the per-game schema; the
// route handler runs the same `parseDurationMs` post-validation arithmetic.
const adminExpiresInPattern = /^\d+[smhd]$/;

export const ADMIN_INVITATION_USER_ID_MAX_LENGTH = 255;
export const ADMIN_INVITATION_ROLE_ID_MAX_LENGTH = 255;

// The body is required (the route handler rejects a malformed/missing
// JSON body with 400); inside the body every field is optional so an
// empty `{}` produces an open-code invitation with no role and no
// expiry. Same shape as the per-game `createInvitationBody`.
export const adminCreateInvitationBody = z.object({
  targetUserId: z.string().min(1).max(ADMIN_INVITATION_USER_ID_MAX_LENGTH).optional(),
  roleId: z.string().min(1).max(ADMIN_INVITATION_ROLE_ID_MAX_LENGTH).optional(),
  expiresIn: z
    .string()
    .regex(
      adminExpiresInPattern,
      "expiresIn must match <positive integer><unit> where unit is s|m|h|d",
    )
    .optional(),
});

export type ListRecentAuditQuery = z.infer<typeof listRecentAuditQuery>;
export type ListAdminGamesQuery = z.infer<typeof listAdminGamesQuery>;
export type CreateGameBody = z.infer<typeof createGameBody>;
export type ListAdminGroupsQuery = z.infer<typeof listAdminGroupsQuery>;
export type ListAdminGroupMembersQuery = z.infer<typeof listAdminGroupMembersQuery>;
export type AdminGroupSortField = (typeof ADMIN_GROUP_SORT_FIELDS)[number];
export type AdminGroupSortOrder = (typeof ADMIN_GROUP_SORT_ORDERS)[number];
export type AdminGroupVisibility = (typeof ADMIN_GROUP_VISIBILITIES)[number];
export type AdminMemberStatusFilter = (typeof ADMIN_MEMBER_STATUSES)[number];
export type AdminKickMemberBody = z.infer<typeof adminKickMemberBody>;
export type AdminUpdateMemberBody = z.infer<typeof adminUpdateMemberBody>;
export type AdminOverridePermissionBody = z.infer<typeof adminOverridePermissionBody>;
export type AdminCreateInvitationBody = z.infer<typeof adminCreateInvitationBody>;
