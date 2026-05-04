// @license All Rights Reserved (see apps/dashboard/LICENSE)

// Client-safe wire shapes and constants for the admin API.
//
// `lib/admin.ts` imports `server-only` (and via `./junjo` the SDK + env
// loader). Client Components only need the type / interface / constant
// declarations that mirror the server's wire shapes; importing them from
// `lib/admin.ts` would drag the server-only chain into the client bundle
// and fail the Next.js build with "you're importing a component that
// needs server-only".
//
// The split is purely organisational: every name here is re-exported from
// `lib/admin.ts` so server-side callers keep importing from `./admin`
// unchanged. Client Components must import directly from this file.

// Wire shapes mirror `WireAdminStats` and `WireAdminAuditEntry` from
// `packages/server/src/routes/admin.ts`.

export interface AdminStats {
  totalGames: number;
  totalGroups: number;
  totalActiveMembers: number;
  totalAuditEntriesLast24h: number;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  gameId: string;
  gameName: string;
  groupId: string;
  groupName: string;
  groupSoftDeleted: boolean;
  actorUserId: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AdminAuditPage {
  items: AdminAuditEntry[];
}

export interface AdminGame {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  groupCount: number;
  activeMemberCount: number;
  apiKeyCount: number;
}

export interface AdminGameList {
  items: AdminGame[];
}

export interface AdminApiKey {
  id: string;
  gameId: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface AdminApiKeyList {
  items: AdminApiKey[];
}

// `key` carries the dev-facing `prefix.secret` form and only exists on
// the create response.
export interface AdminApiKeyCreated extends AdminApiKey {
  key: string;
}

export type AdminGroupVisibility = "public" | "invite-only" | "secret";
export type AdminGroupSort = "createdAt" | "name" | "memberCount";
export type AdminGroupOrder = "asc" | "desc";

export const ADMIN_GROUP_VISIBILITIES: readonly AdminGroupVisibility[] = [
  "public",
  "invite-only",
  "secret",
];
export const ADMIN_GROUP_SORTS: readonly AdminGroupSort[] = ["createdAt", "name", "memberCount"];
export const ADMIN_GROUP_ORDERS: readonly AdminGroupOrder[] = ["asc", "desc"];
export const ADMIN_GROUPS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];
export const ADMIN_GROUPS_DEFAULT_PAGE_SIZE = 50;

export interface AdminGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AdminGroupList {
  items: AdminGroup[];
  total: number;
  hasMore: boolean;
}

export interface FetchAdminGroupsParams {
  limit?: number;
  offset?: number;
  q?: string;
  kind?: string;
  visibility?: AdminGroupVisibility;
  sort?: AdminGroupSort;
  order?: AdminGroupOrder;
}

export type AdminMemberStatus = "active" | "left" | "kicked" | "invited";
export type AdminMemberStatusFilter = AdminMemberStatus | "all";

export const ADMIN_MEMBER_STATUSES: readonly AdminMemberStatus[] = [
  "active",
  "left",
  "kicked",
  "invited",
];
export const ADMIN_MEMBER_STATUS_FILTERS: readonly AdminMemberStatusFilter[] = [
  "active",
  "left",
  "kicked",
  "invited",
  "all",
];
export const ADMIN_MEMBERS_PAGE_SIZE_OPTIONS: readonly number[] = [10, 25, 50, 100];
export const ADMIN_MEMBERS_DEFAULT_PAGE_SIZE = 50;

export interface AdminMemberRole {
  id: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
}

export interface AdminGroupMember {
  id: string;
  groupId: string;
  externalUserId: string;
  junjoUserId: string;
  status: string;
  metadata: Record<string, unknown>;
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: string;
  leftAt: string | null;
  roles: AdminMemberRole[];
}

export interface AdminGroupMemberList {
  items: AdminGroupMember[];
  total: number;
  hasMore: boolean;
}

export interface FetchAdminGroupMembersParams {
  limit?: number;
  offset?: number;
  status?: AdminMemberStatusFilter;
  q?: string;
}

export interface AdminMemberPermissionOverride {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  setAt: string;
  setBy: string | null;
}

export const ADMIN_MEMBER_NOTES_MAX_LENGTH = 5000;
export const ADMIN_MEMBER_KICK_REASON_MAX_LENGTH = 500;
export const ADMIN_PERMISSION_KEY_MAX_LENGTH = 128;

export interface KickAdminGroupMemberInput {
  reason?: string | null;
}

export interface UpdateAdminGroupMemberInput {
  metadata?: Record<string, unknown>;
  notesPublic?: string | null;
  notesPrivate?: string | null;
}

export interface SetAdminMemberPermissionOverrideInput {
  grant: boolean;
}

export interface AdminInvitation {
  id: string;
  groupId: string;
  code: string;
  roleId: string | null;
  targetUserId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedBy: string | null;
}

export const ADMIN_INVITATION_USER_ID_MAX_LENGTH = 255;
export const ADMIN_INVITATION_ROLE_ID_MAX_LENGTH = 255;
export const ADMIN_INVITATION_EXPIRES_IN_PATTERN = /^\d+[smhd]$/;

export interface CreateAdminGroupInvitationInput {
  targetUserId?: string;
  roleId?: string;
  expiresIn?: string;
}

export interface AdminRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  createdAt: string;
}

export interface AdminPermissionDef {
  key: string;
  description: string | null;
  createdAt: string;
}

export const ADMIN_ROLE_NAME_MAX_LENGTH = 64;
export const ADMIN_ROLE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export interface CreateAdminRoleInput {
  name: string;
  priority: number;
  color?: string;
  isDefault?: boolean;
}

export interface UpdateAdminRoleInput {
  name?: string;
  priority?: number;
  color?: string | null;
  isDefault?: boolean;
}

export interface AdminGroupAuditEntry {
  id: string;
  groupId: string;
  actorUserId: string | null;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AdminGroupAuditPage {
  items: AdminGroupAuditEntry[];
  nextCursor: string | null;
}

export const ADMIN_AUDIT_ACTIONS: readonly string[] = [
  "group.created",
  "group.updated",
  "group.deleted",
  "group.restored",
  "group.relationship.set",
  "group.relationship.cleared",
  "group.parent.set",
  "group.parent.cleared",
  "member.invited",
  "member.joined",
  "member.left",
  "member.kicked",
  "member.metadata.updated",
  "member.notes.updated",
  "role.created",
  "role.updated",
  "role.deleted",
  "role.assigned",
  "role.unassigned",
  "permission.granted",
  "permission.revoked",
  "permission.override.set",
  "permission.override.cleared",
];

export const ADMIN_AUDIT_PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100];
export const ADMIN_AUDIT_DEFAULT_PAGE_SIZE = 50;

export interface FetchAdminGroupAuditParams {
  limit?: number;
  before?: string;
  actions?: string[];
}

export interface AdminGroupRelationship {
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setBy: string | null;
}

export const ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH = 64;

export interface SetAdminGroupRelationshipInput {
  type: string;
  mutual?: boolean;
}

export interface AdminGameAuditPage {
  items: AdminAuditEntry[];
  nextCursor: string | null;
}

export const ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH = 255;
export const ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH = 255;
export const ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100];
export const ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE = 50;

export interface FetchAdminGameAuditParams {
  limit?: number;
  before?: string;
  since?: string;
  actions?: string[];
  actorUserId?: string;
  targetId?: string;
}

export interface SetAdminGroupParentInput {
  parentGroupId: string | null;
}

export interface AdminGroupChurnBin {
  label: string;
  minMs: number | null;
  maxMs: number | null;
  count: number;
}

export interface AdminGroupChurn {
  from: string | null;
  to: string | null;
  totalGroupsInWindow: number;
  totalDeparturesInWindow: number;
  bins: AdminGroupChurnBin[];
}

export interface FetchAdminGroupChurnParams {
  from?: string;
  to?: string;
}

export interface AdminGroupGrowthSeries {
  key: string;
  name: string;
  groupId: string | null;
  data: number[];
}

export interface AdminGroupGrowth {
  from: string;
  to: string;
  bucketSizeMs: number;
  buckets: string[];
  series: AdminGroupGrowthSeries[];
}

export const ADMIN_GROUP_GROWTH_TOP_N_DEFAULT = 5;
export const ADMIN_GROUP_GROWTH_TOP_N_MIN = 1;
export const ADMIN_GROUP_GROWTH_TOP_N_MAX = 10;

export interface FetchAdminGroupGrowthParams {
  from?: string;
  to?: string;
  topN?: number;
}

export interface AdminMemberActivity {
  from: string | null;
  to: string | null;
  totalEvents: number;
  cells: number[][];
}

export interface FetchAdminMemberActivityParams {
  from?: string;
  to?: string;
}

export type AdminPermissionSource = "none" | "default" | "role" | "override";

export interface AdminPermissionCheckResult {
  allowed: boolean;
  source: AdminPermissionSource;
  viaRoleId?: string;
}

export interface AdminRoleSlice {
  name: string;
  count: number;
}

export interface AdminRoleDistribution {
  totalAssignments: number;
  uniqueRoleNames: number;
  topRoles: AdminRoleSlice[];
  otherCount: number;
}

export interface AdminPermissionUsageItem {
  permission: string;
  roleGrants: number;
  memberOverrides: number;
  total: number;
}

export interface AdminPermissionUsage {
  totalCount: number;
  uniqueKeys: number;
  items: AdminPermissionUsageItem[];
  otherCount: number;
}

export interface FetchAdminPermissionCheckParams {
  userId: string;
  groupId: string;
  permission: string;
}
