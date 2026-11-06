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
  // Null for game-scoped actions (bans, identity links); groupName is
  // then null too.
  groupId: string | null;
  groupName: string | null;
  groupSoftDeleted: boolean;
  actorUserId: string | null;
  // The API key whose request wrote the entry; null for dashboard and
  // system writes.
  apiKey: AdminAuditApiKey | null;
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
  // Operator-facing label, shown on audit entries the key wrote.
  name: string | null;
  // Ordered namespace preference for user ids read through this key.
  preferredNamespaces: string[];
  // Whether the key may read the game export.
  canExport: boolean;
  createdAt: string;
  revokedAt: string | null;
}

// Mirrors the server's API key limits (packages/server routes/admin.schema.ts
// and @junjo.io/shared MAX_PREFERRED_NAMESPACES).
export const ADMIN_API_KEY_NAME_MAX_LENGTH = 64;
export const ADMIN_API_KEY_MAX_PREFERRED_NAMESPACES = 8;

export interface AdminApiKeyInput {
  name?: string | null;
  preferredNamespaces?: string[];
  canExport?: boolean;
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
  hasPasscode: boolean;
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

export type AdminMemberStatus = "active" | "left" | "kicked" | "invited" | "banned";
export type AdminMemberStatusFilter = AdminMemberStatus | "all";

export const ADMIN_MEMBER_STATUSES: readonly AdminMemberStatus[] = [
  "active",
  "left",
  "kicked",
  "invited",
  "banned",
];
export const ADMIN_MEMBER_STATUS_FILTERS: readonly AdminMemberStatusFilter[] = [
  "active",
  "left",
  "kicked",
  "invited",
  "banned",
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
  // Absent for a global override.
  context?: AdminPermissionContext;
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

// Conditions under which an entry applies, key to folded value. Absent
// on a global entry.
export type AdminPermissionContext = Record<string, string>;

export interface AdminPermissionEntry {
  permission: string;
  // true grants the key, false denies it.
  value: boolean;
  context?: AdminPermissionContext;
}

export function isContextual(entry: { context?: AdminPermissionContext }): boolean {
  return entry.context !== undefined && Object.keys(entry.context).length > 0;
}

// Display form of a context: "key: value" pairs sorted by key.
export function formatPermissionContext(context: AdminPermissionContext | undefined): string {
  if (!context) return "";
  return Object.keys(context)
    .sort()
    .map((k) => `${k}: ${context[k]}`)
    .join(", ");
}

// A stable identity for an entry or override within one role or member:
// its key plus its context.
export function permissionEntryId(entry: {
  permission: string;
  context?: AdminPermissionContext;
}): string {
  return `${entry.permission}|${formatPermissionContext(entry.context)}`;
}

export interface AdminRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  // Globally granted keys only. Denies and contextual entries are listed
  // in `entries`.
  permissions: string[];
  // Every entry stored on the role, grants and denies. Older servers
  // omit it; readers fall back to `permissions` as all-grant entries.
  entries?: AdminPermissionEntry[];
  // Ids of roles this role inherits from, in the same group.
  parents?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type RoleEntryState = "grant" | "deny" | "none";

export function roleEntries(role: AdminRole): AdminPermissionEntry[] {
  return role.entries ?? role.permissions.map((permission) => ({ permission, value: true }));
}

// The state of the role's global entry for `permission`. Contextual
// entries for the same key are reported by `roleContextEntries`.
export function roleEntryState(role: AdminRole, permission: string): RoleEntryState {
  const entry = roleEntries(role).find((e) => e.permission === permission && !isContextual(e));
  if (!entry) return "none";
  return entry.value ? "grant" : "deny";
}

export function roleContextEntries(role: AdminRole, permission: string): AdminPermissionEntry[] {
  return roleEntries(role).filter((e) => e.permission === permission && isContextual(e));
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
  metadata?: Record<string, unknown>;
}

export interface UpdateAdminRoleInput {
  name?: string;
  priority?: number;
  color?: string | null;
  isDefault?: boolean;
  // Replaces the stored metadata as a whole.
  metadata?: Record<string, unknown>;
}

// Role metadata keys for display text a game shows around a member's
// name, stored verbatim as strings.
export const ROLE_AFFIX_KEYS = ["prefix", "suffix"] as const;
export type RoleAffixKey = (typeof ROLE_AFFIX_KEYS)[number];
export const ADMIN_ROLE_AFFIX_MAX_LENGTH = 256;

export function roleAffix(role: Pick<AdminRole, "metadata">, key: RoleAffixKey): string {
  const value = role.metadata?.[key];
  return typeof value === "string" ? value : "";
}

export interface AdminAuditApiKey {
  id: string;
  name: string | null;
  prefix: string;
}

export interface AdminGroupAuditEntry {
  id: string;
  groupId: string;
  actorUserId: string | null;
  apiKey: AdminAuditApiKey | null;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AdminGroupAuditPage {
  items: AdminGroupAuditEntry[];
  nextCursor: string | null;
}

// Mirrors `AUDIT_ACTIONS` in `packages/server/src/routes/audit.schema.ts`,
// in the same order; the server refuses an `actions` filter outside it.
export const ADMIN_AUDIT_ACTIONS: readonly string[] = [
  "group.created",
  "group.updated",
  "group.deleted",
  "group.restored",
  "group.relationship.set",
  "group.relationship.cleared",
  "group.parent.set",
  "group.parent.cleared",
  "group.passcode.set",
  "group.passcode.cleared",
  "member.invited",
  "member.joined",
  "member.left",
  "member.kicked",
  "member.banned",
  "member.unbanned",
  "member.metadata.updated",
  "member.notes.updated",
  "game.user.banned",
  "game.user.unbanned",
  "game.user.sanctioned",
  "game.user.unsanctioned",
  "game.permissions.mode.set",
  "role.created",
  "role.updated",
  "role.deleted",
  "role.assigned",
  "role.unassigned",
  "role.entries.changed",
  "role.parents.set",
  "permission.granted",
  "permission.revoked",
  "permission.override.set",
  "permission.override.cleared",
  "identity.linked",
  "identity.unlinked",
];

// Plain-word names for the action filter. The filter still sends the
// action string itself.
export const ADMIN_AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "group.created": "Group created",
  "group.updated": "Group edited",
  "group.deleted": "Group deleted",
  "group.restored": "Group restored",
  "group.relationship.set": "Relationship set",
  "group.relationship.cleared": "Relationship cleared",
  "group.parent.set": "Parent group set",
  "group.parent.cleared": "Parent group cleared",
  "group.passcode.set": "Passcode set",
  "group.passcode.cleared": "Passcode cleared",
  "member.invited": "Member invited",
  "member.joined": "Member joined",
  "member.left": "Member left",
  "member.kicked": "Member kicked",
  "member.banned": "Member banned from a group",
  "member.unbanned": "Member unbanned from a group",
  "member.metadata.updated": "Member metadata changed",
  "member.notes.updated": "Member notes changed",
  "game.user.banned": "User banned from the game",
  "game.user.unbanned": "User unbanned from the game",
  "game.user.sanctioned": "Sanction added",
  "game.user.unsanctioned": "Sanction lifted",
  "game.permissions.mode.set": "Permission mode changed",
  "role.created": "Role created",
  "role.updated": "Role edited",
  "role.deleted": "Role deleted",
  "role.assigned": "Role given",
  "role.unassigned": "Role taken away",
  "role.entries.changed": "Role permissions changed",
  "role.parents.set": "Role inheritance changed",
  "permission.granted": "Permission granted",
  "permission.revoked": "Permission revoked",
  "permission.override.set": "Override set",
  "permission.override.cleared": "Override cleared",
  "identity.linked": "Identity linked",
  "identity.unlinked": "Identity unlinked",
};

export function adminAuditActionLabel(action: string): string {
  return ADMIN_AUDIT_ACTION_LABELS[action] ?? action;
}

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
  // The deciding entry's context; absent when a global entry decided.
  context?: AdminPermissionContext;
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
  // Absent or empty checks only global entries.
  context?: AdminPermissionContext;
}

// Game config shapes the settings page edits. Mirrors GameConfig in
// `packages/shared/src/types.ts`.
export type AdminPermissionMode = "exact" | "nodes";
export const ADMIN_PERMISSION_MODES: readonly AdminPermissionMode[] = ["exact", "nodes"];

// Context key to value inheritance: each value lists the values whose
// entries it also sees, nearest first.
export type AdminContextInheritance = Record<string, { inherit: Record<string, string[]> }>;
export const ADMIN_CONTEXT_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export type AdminUserIdFormat = "uuid";
export const ADMIN_USER_ID_FORMATS: readonly AdminUserIdFormat[] = ["uuid"];
export const ADMIN_USER_ID_NAMESPACE_PATTERN = /^[a-z0-9_-]{1,32}$/;

export interface AdminGroupKindLimits {
  maxMembers?: number;
  maxPerUser?: number;
  deleteWhenEmpty?: boolean;
  idleDeleteHours?: number;
}
export const ADMIN_GROUP_KIND_MAX_LENGTH = 64;

// GET /v1/admin/games/:gameId/players.
export interface AdminPlayerId {
  userId: string;
  namespace: string | null;
  displayName: string | null;
  linkedAt: string;
}

export interface AdminPlayer {
  personId: string;
  userIds: AdminPlayerId[];
  displayName: string | null;
  firstSeenAt: string;
  lastActivityAt: string | null;
  activeGroupCount: number;
  ban: { reason: string | null; expiresAt: string | null } | null;
  sanctions: { type: string; expiresAt: string | null }[];
}

export interface AdminPlayerList {
  items: AdminPlayer[];
  total: number;
  limit: number;
  offset: number;
}

export type AdminPlayerSort = "firstSeen" | "lastActivity" | "name";
export type AdminPlayerStanding = "banned" | "sanctioned";
export const ADMIN_PLAYERS_PAGE_SIZE = 50;

export interface FetchAdminPlayersParams {
  q?: string;
  namespace?: string;
  standing?: AdminPlayerStanding;
  sort?: AdminPlayerSort;
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}
