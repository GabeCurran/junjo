// @cloud-only
//
// Schemas for the admin-token-gated endpoints in `routes/admin.ts`.

import { z } from "zod";
import { AUDIT_ACTIONS } from "./audit.schema.js";
import { pageLimit } from "./page.schema.js";

export const GAME_NAME_MAX_LENGTH = 200;

export const listRecentAuditQuery = z.object({
  limit: pageLimit(20),
});

export const listAdminGamesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createGameBody = z.object({
  name: z.string().min(1).max(GAME_NAME_MAX_LENGTH),
});

// Caps mirror the per-game `Group` schema (`name` 1-120, `kind` 1-64).
export const ADMIN_GROUP_NAME_SEARCH_MAX_LENGTH = 120;
export const ADMIN_GROUP_KIND_MAX_LENGTH = 64;
export const ADMIN_GROUP_VISIBILITIES = ["public", "invite-only", "secret"] as const;
export const ADMIN_GROUP_SORT_FIELDS = ["createdAt", "name", "memberCount"] as const;
export const ADMIN_GROUP_SORT_ORDERS = ["asc", "desc"] as const;
// Cap the matching set when sort=memberCount: the handler fetches every
// matching row, batches member counts, sorts in memory, and slices.
// Past the cap the route 400s with a "narrow your filter" hint rather
// than silently truncating.
export const ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS = 500;

export const listAdminGroupsQuery = z.object({
  limit: pageLimit(50),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().min(1).max(ADMIN_GROUP_NAME_SEARCH_MAX_LENGTH).optional(),
  kind: z.string().min(1).max(ADMIN_GROUP_KIND_MAX_LENGTH).optional(),
  visibility: z.enum(ADMIN_GROUP_VISIBILITIES).optional(),
  sort: z.enum(ADMIN_GROUP_SORT_FIELDS).default("createdAt"),
  order: z.enum(ADMIN_GROUP_SORT_ORDERS).default("desc"),
});

export const ADMIN_MEMBER_STATUSES = ["active", "left", "kicked", "invited", "all"] as const;

export const listAdminGroupMembersQuery = z.object({
  limit: pageLimit(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(ADMIN_MEMBER_STATUSES).default("active"),
  q: z.string().min(1).max(255).optional(),
});

// Mirrors the per-game member-action bodies so admin and per-game routes
// accept identical payloads.
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

// Mirrors the per-game `createInvitationBody`; same `expiresIn` regex,
// same `parseDurationMs` post-validation arithmetic in the handler.
const adminExpiresInPattern = /^\d+[smhd]$/;

export const ADMIN_INVITATION_USER_ID_MAX_LENGTH = 255;
export const ADMIN_INVITATION_ROLE_ID_MAX_LENGTH = 255;

// Empty `{}` produces an open-code invitation with no role and no expiry.
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

// Caps mirror the per-game `Role` schema. Structural duplicates of
// `createRoleBody` / `updateRoleBody` so admin handlers do not import
// across the cloud-only boundary.
export const ADMIN_ROLE_NAME_MAX_LENGTH = 64;
const ADMIN_HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const ADMIN_HEX_COLOR_MESSAGE = "must be a 7-character hex color (e.g. #ff5050)";

export const adminCreateRoleBody = z.object({
  name: z.string().min(1).max(ADMIN_ROLE_NAME_MAX_LENGTH),
  priority: z.number().int(),
  color: z.string().regex(ADMIN_HEX_COLOR_PATTERN, ADMIN_HEX_COLOR_MESSAGE).optional(),
  isDefault: z.boolean().optional(),
});

export const adminUpdateRoleBody = z
  .object({
    name: z.string().min(1).max(ADMIN_ROLE_NAME_MAX_LENGTH).optional(),
    priority: z.number().int().optional(),
    color: z.string().regex(ADMIN_HEX_COLOR_PATTERN, ADMIN_HEX_COLOR_MESSAGE).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

// Mirrors the per-game `grantPermissionBody`.
export const adminGrantPermissionBody = z.object({
  permission: z.string().min(1).max(ADMIN_PERMISSION_KEY_MAX_LENGTH),
});

// Mirrors the per-game `setRelationshipBody` / `clearRelationshipQuery`;
// `type` cap matches the per-game `RELATIONSHIP_TYPE_MAX_LENGTH`.
export const ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH = 64;

export const adminSetRelationshipBody = z.object({
  type: z.string().min(1).max(ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH),
  mutual: z.boolean().optional(),
});

// Strict "true" / "false" enum matches `listInvitationsQuery`'s
// `includeExpired` / `includeUsed` flags; the dashboard controls the URL.
export const adminClearRelationshipQuery = z.object({
  mutual: z.enum(["true", "false"]).optional(),
});

// `parentGroupId` is required (omitting is rejected) so caller intent
// is explicit; `null` clears the parent.
export const adminSetParentBody = z.object({
  parentGroupId: z.string().min(1).nullable(),
});

// Mirrors the per-game `MAX_PARENT_DEPTH`.
export const ADMIN_MAX_PARENT_DEPTH = 100;

// Extends the per-group `listAuditQuery` with `since` (lower bound),
// `actorUserId` (exact match against the internal `JunjoUser.id`), and
// `targetId` (exact match against whatever the writing route stored).
export const ADMIN_AUDIT_ACTOR_ID_MAX_LENGTH = 255;
export const ADMIN_AUDIT_TARGET_ID_MAX_LENGTH = 255;

export const listAdminGameAuditQuery = z.object({
  limit: pageLimit(50),
  before: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "before must be an ISO 8601 date" })
    .optional(),
  since: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "since must be an ISO 8601 date" })
    .optional(),
  actions: z.array(z.enum(AUDIT_ACTIONS)).optional(),
  actorUserId: z.string().min(1).max(ADMIN_AUDIT_ACTOR_ID_MAX_LENGTH).optional(),
  targetId: z.string().min(1).max(ADMIN_AUDIT_TARGET_ID_MAX_LENGTH).optional(),
});

// Mirrors the per-game `checkPermissionQuery`.
export const adminCheckPermissionQuery = z.object({
  userId: z.string().min(1),
  groupId: z.string().min(1),
  permission: z.string().min(1).max(ADMIN_PERMISSION_KEY_MAX_LENGTH),
});

// Both `from` and `to` are optional; the handler treats omitted as
// "no bound on that side".
export const groupChurnQuery = z.object({
  from: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "from must be an ISO 8601 date" })
    .optional(),
  to: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "to must be an ISO 8601 date" })
    .optional(),
});

// Half-open `[minMs, maxMs)` bins; `null` on either side means
// unbounded. Labels are wire-stable copy the chart renders verbatim.
export interface GroupChurnBinDef {
  label: string;
  minMs: number | null;
  maxMs: number | null;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

export const ANALYTICS_GROUP_CHURN_BINS: readonly GroupChurnBinDef[] = [
  { label: "< 1h", minMs: null, maxMs: ONE_HOUR_MS },
  { label: "1h - 1d", minMs: ONE_HOUR_MS, maxMs: ONE_DAY_MS },
  { label: "1d - 1w", minMs: ONE_DAY_MS, maxMs: ONE_WEEK_MS },
  { label: "1w - 1mo", minMs: ONE_WEEK_MS, maxMs: ONE_MONTH_MS },
  { label: "1mo+", minMs: ONE_MONTH_MS, maxMs: null },
] as const;

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
export type AdminCreateRoleBody = z.infer<typeof adminCreateRoleBody>;
export type AdminUpdateRoleBody = z.infer<typeof adminUpdateRoleBody>;
export type AdminGrantPermissionBody = z.infer<typeof adminGrantPermissionBody>;
export type AdminSetRelationshipBody = z.infer<typeof adminSetRelationshipBody>;
export type AdminClearRelationshipQuery = z.infer<typeof adminClearRelationshipQuery>;
export type AdminSetParentBody = z.infer<typeof adminSetParentBody>;
export type ListAdminGameAuditQuery = z.infer<typeof listAdminGameAuditQuery>;
export type AdminCheckPermissionQuery = z.infer<typeof adminCheckPermissionQuery>;
export type GroupChurnQuery = z.infer<typeof groupChurnQuery>;

// `topN` is bounded at [1, 10] so the chart stays legible.
export const ADMIN_GROUP_GROWTH_TOP_N_DEFAULT = 5;
export const ADMIN_GROUP_GROWTH_TOP_N_MIN = 1;
export const ADMIN_GROUP_GROWTH_TOP_N_MAX = 10;

export const ADMIN_GROUP_GROWTH_DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// Guards against pathological custom windows (e.g. a 10-year `from` at
// hourly bucketing).
export const ADMIN_GROUP_GROWTH_MAX_BUCKETS = 100;

export const groupGrowthQuery = z.object({
  from: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "from must be an ISO 8601 date" })
    .optional(),
  to: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "to must be an ISO 8601 date" })
    .optional(),
  topN: z.coerce
    .number()
    .int()
    .min(ADMIN_GROUP_GROWTH_TOP_N_MIN)
    .max(ADMIN_GROUP_GROWTH_TOP_N_MAX)
    .default(ADMIN_GROUP_GROWTH_TOP_N_DEFAULT),
});

export type GroupGrowthQuery = z.infer<typeof groupGrowthQuery>;

// Same `[from, to)` shape as `groupChurnQuery`.
export const memberActivityQuery = z.object({
  from: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "from must be an ISO 8601 date" })
    .optional(),
  to: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "to must be an ISO 8601 date" })
    .optional(),
});

export type MemberActivityQuery = z.infer<typeof memberActivityQuery>;

// UTC-bucketed: matches Postgres `EXTRACT(DOW)` (0=Sunday) and
// `EXTRACT(HOUR)` (0-23). The dashboard rotates the day axis client-side
// for Mon-first vs Sun-first.
export const ANALYTICS_MEMBER_ACTIVITY_DAYS = 7;
export const ANALYTICS_MEMBER_ACTIVITY_HOURS = 24;

export const ADMIN_ROLE_DISTRIBUTION_TOP_N = 10;
export const ADMIN_PERMISSION_USAGE_TOP_N = 15;
