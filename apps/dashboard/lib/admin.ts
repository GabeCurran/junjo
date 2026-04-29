// @license All Rights Reserved (see apps/dashboard/LICENSE)
import "server-only";

import { getAdminToken, getJunjoBaseUrl } from "./junjo.js";

// Wire shapes mirror `WireAdminStats` and `WireAdminAuditEntry` from
// `packages/server/src/routes/admin.ts`. The admin endpoints are
// deliberately not in the per-game SDK, so the dashboard owns its own
// typed view of them.

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

// `AdminDisabledError` is what callers branch on to distinguish "operator
// has not set `JUNJO_ADMIN_TOKEN`" from "the request to the server failed".
// The home page renders a separate empty state for the disabled case so an
// operator who only ever runs one game (and intentionally leaves the admin
// token unset) sees a hint instead of a generic error.
export class AdminDisabledError extends Error {
  constructor() {
    super("admin endpoints are disabled (JUNJO_ADMIN_TOKEN unset)");
    this.name = "AdminDisabledError";
  }
}

interface FetchOptions {
  // Next.js revalidate window in seconds. Defaults to 60s; overridable so a
  // future "force refresh" action can pass `revalidate: 0`.
  revalidate?: number;
  // Init-time signal forwarded to the platform fetch. Optional.
  signal?: AbortSignal;
}

async function adminFetch<T>(path: string, opts: FetchOptions = {}): Promise<T> {
  const token = getAdminToken();
  if (!token) throw new AdminDisabledError();
  const baseUrl = getJunjoBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    next: { revalidate: opts.revalidate ?? 60 },
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
    const detail = body?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`admin request failed: ${detail}`);
  }
  return (await res.json()) as T;
}

export function fetchAdminStats(opts?: FetchOptions): Promise<AdminStats> {
  return adminFetch<AdminStats>("/v1/admin/stats", opts);
}

export function fetchRecentAudit(limit = 20, opts?: FetchOptions): Promise<AdminAuditPage> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  return adminFetch<AdminAuditPage>(`/v1/admin/audit?limit=${safeLimit}`, opts);
}

// Phase 11.3a wire shapes mirrored byte-for-byte from
// `packages/server/src/routes/admin.ts`. The dashboard's games list and
// game detail pages drive every admin operation through these helpers; the
// per-game `@junjo/sdk` does not carry cross-tenant queries.

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

// `key` carries the dev-facing `prefix.secret` form and only exists on the
// create response. List and revoke responses return `AdminApiKey` (no key,
// no secret); the secret is stored only as a scrypt hash and is
// unrecoverable thereafter.
export interface AdminApiKeyCreated extends AdminApiKey {
  key: string;
}

interface MutationOptions {
  signal?: AbortSignal;
}

async function adminMutate<TBody, TResult>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body: TBody | null,
  opts: MutationOptions = {},
): Promise<TResult> {
  const token = getAdminToken();
  if (!token) throw new AdminDisabledError();
  const baseUrl = getJunjoBaseUrl();
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  let serialized: string | undefined;
  if (body !== null) {
    headers["content-type"] = "application/json";
    serialized = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: serialized,
    cache: "no-store",
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    const detail = errBody?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`admin request failed: ${detail}`);
  }
  return (await res.json()) as TResult;
}

// DELETE has its own helper because it returns 204 (no body) on success and
// the type-narrowing is cleaner with a separate function than a union return
// type. Also the consumer never wants to call `.json()` on a 204.
async function adminDelete(path: string, opts: MutationOptions = {}): Promise<void> {
  const token = getAdminToken();
  if (!token) throw new AdminDisabledError();
  const baseUrl = getJunjoBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as {
      code?: string;
      message?: string;
    } | null;
    const detail = errBody?.message ?? `${res.status} ${res.statusText}`;
    throw new Error(`admin request failed: ${detail}`);
  }
}

export function fetchAdminGames(opts?: FetchOptions): Promise<AdminGameList> {
  return adminFetch<AdminGameList>("/v1/admin/games", opts);
}

export function fetchAdminGame(gameId: string, opts?: FetchOptions): Promise<AdminGame> {
  return adminFetch<AdminGame>(`/v1/admin/games/${encodeURIComponent(gameId)}`, opts);
}

export function fetchAdminApiKeys(gameId: string, opts?: FetchOptions): Promise<AdminApiKeyList> {
  return adminFetch<AdminApiKeyList>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/api-keys`,
    opts,
  );
}

export function createAdminGame(name: string, opts?: MutationOptions): Promise<AdminGame> {
  return adminMutate<{ name: string }, AdminGame>("POST", "/v1/admin/games", { name }, opts);
}

export function createAdminApiKey(
  gameId: string,
  opts?: MutationOptions,
): Promise<AdminApiKeyCreated> {
  return adminMutate<null, AdminApiKeyCreated>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/api-keys`,
    null,
    opts,
  );
}

export function revokeAdminApiKey(
  gameId: string,
  keyId: string,
  opts?: MutationOptions,
): Promise<AdminApiKey> {
  return adminMutate<null, AdminApiKey>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/api-keys/${encodeURIComponent(keyId)}/revoke`,
    null,
    opts,
  );
}

// Phase 11.4a wire shapes mirrored byte-for-byte from
// `packages/server/src/routes/admin.ts:WireAdminGroup` and `WireAdminGroupList`.
// The dashboard's group browser drives every fetch through these helpers.

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
// The route caps `limit` at 100; the dashboard never asks for more than this
// even on its largest page-size selector. The cap mirrors the server-side
// `listAdminGroupsQuery` schema.
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

// `q`, `kind`, and `visibility` are dropped from the wire request when
// undefined or empty so the server schema (which rejects empty strings) does
// not 400 on a stale URL. Other params forward verbatim.
export function fetchAdminGroupsForGame(
  gameId: string,
  params: FetchAdminGroupsParams = {},
  opts?: FetchOptions,
): Promise<AdminGroupList> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.q !== undefined && params.q.length > 0) qs.set("q", params.q);
  if (params.kind !== undefined && params.kind.length > 0) qs.set("kind", params.kind);
  if (params.visibility !== undefined) qs.set("visibility", params.visibility);
  if (params.sort !== undefined) qs.set("sort", params.sort);
  if (params.order !== undefined) qs.set("order", params.order);
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/groups`;
  const search = qs.toString();
  return adminFetch<AdminGroupList>(search ? `${path}?${search}` : path, opts);
}

// Phase 11.5a wire shapes mirrored byte-for-byte from
// `packages/server/src/routes/admin.ts:WireAdminMemberRole`,
// `WireAdminGroupMember`, and `WireAdminGroupMemberList`. The dashboard's
// group detail page (members tab) consumes the single-group fetch
// (`fetchAdminGroup`, reusing `AdminGroup`) plus the paginated members
// fetch (`fetchAdminGroupMembers`).

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
// The route caps `limit` at 100; the dashboard never asks for more than this
// even on its largest page-size selector.
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

export function fetchAdminGroup(
  gameId: string,
  groupId: string,
  opts?: FetchOptions,
): Promise<AdminGroup> {
  return adminFetch<AdminGroup>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}`,
    opts,
  );
}

export interface FetchAdminGroupMembersParams {
  limit?: number;
  offset?: number;
  status?: AdminMemberStatusFilter;
  q?: string;
}

// `q` is dropped from the wire request when empty so the server schema
// (which rejects empty strings) does not 400 on a stale URL. `status`
// forwards verbatim including the `all` wildcard.
export function fetchAdminGroupMembers(
  gameId: string,
  groupId: string,
  params: FetchAdminGroupMembersParams = {},
  opts?: FetchOptions,
): Promise<AdminGroupMemberList> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.status !== undefined) qs.set("status", params.status);
  if (params.q !== undefined && params.q.length > 0) qs.set("q", params.q);
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/members`;
  const search = qs.toString();
  return adminFetch<AdminGroupMemberList>(search ? `${path}?${search}` : path, opts);
}

// Phase 11.5c-i wire shape mirroring `WireAdminMemberPermissionOverride`
// from `packages/server/src/routes/admin.ts`. Same six fields exposed on
// the per-game `routes/members.ts` shape; duplicated here so the dashboard
// does not import across the cloud-only boundary. `setBy` is null today
// because the server's admin handlers always set `actorUserId: null` (no
// auth-adapter actor wired); reserved for a future iteration that threads
// an admin actor identifier through `adminAuthMiddleware`.
export interface AdminMemberPermissionOverride {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  setAt: string;
  setBy: string | null;
}

// Mirrors the server-side caps in `routes/admin.schema.ts` so the dashboard
// can enforce the same limits client-side via input maxLength attributes
// without a round-trip to learn what the server accepts.
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

export function kickAdminGroupMember(
  gameId: string,
  groupId: string,
  userId: string,
  input: KickAdminGroupMemberInput = {},
  opts?: MutationOptions,
): Promise<AdminGroupMember> {
  return adminMutate<KickAdminGroupMemberInput, AdminGroupMember>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/kick`,
    input,
    opts,
  );
}

export function updateAdminGroupMember(
  gameId: string,
  groupId: string,
  userId: string,
  input: UpdateAdminGroupMemberInput,
  opts?: MutationOptions,
): Promise<AdminGroupMember> {
  return adminMutate<UpdateAdminGroupMemberInput, AdminGroupMember>(
    "PATCH",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
    input,
    opts,
  );
}

export function setAdminMemberPermissionOverride(
  gameId: string,
  groupId: string,
  userId: string,
  permission: string,
  input: SetAdminMemberPermissionOverrideInput,
  opts?: MutationOptions,
): Promise<AdminMemberPermissionOverride> {
  return adminMutate<SetAdminMemberPermissionOverrideInput, AdminMemberPermissionOverride>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
    input,
    opts,
  );
}

export function clearAdminMemberPermissionOverride(
  gameId: string,
  groupId: string,
  userId: string,
  permission: string,
  opts?: MutationOptions,
): Promise<void> {
  return adminDelete(
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
    opts,
  );
}

// Operators expect fresh state when opening the "view overrides" dialog, so
// this helper forces `revalidate: 0`. Caller can still override.
export function listAdminMemberPermissionOverrides(
  gameId: string,
  groupId: string,
  userId: string,
  opts?: FetchOptions,
): Promise<AdminMemberPermissionOverride[]> {
  return adminFetch<AdminMemberPermissionOverride[]>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions`,
    { ...opts, revalidate: opts?.revalidate ?? 0 },
  );
}

// Phase 11.5d-i wire shape mirroring `WireInvitation` from
// `packages/server/src/routes/invitations.ts`. Same ten fields exposed by
// the per-game and admin invitation endpoints; duplicated here so the
// dashboard does not import across the cloud-only boundary. The admin
// endpoint adds a `payload.source: "admin"` discriminator on its audit
// entry, but the wire shape itself is byte-identical to the per-game
// route.
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

// Mirrors the server-side caps in `routes/admin.schema.ts:adminCreateInvitationBody`
// so the dashboard's invite-member dialog can enforce the same limits via
// input maxLength attributes without a round trip to learn what the server
// accepts.
export const ADMIN_INVITATION_USER_ID_MAX_LENGTH = 255;
export const ADMIN_INVITATION_ROLE_ID_MAX_LENGTH = 255;
// expiresIn is matched against the server's regex; surfacing it client-side
// lets a typo like "7days" return a clear error message instead of
// bouncing off the server with a generic 400.
export const ADMIN_INVITATION_EXPIRES_IN_PATTERN = /^\d+[smhd]$/;

export interface CreateAdminGroupInvitationInput {
  // When set, the invitation is direct - only this user can accept. When
  // omitted, the invitation is open-code (anyone with the code can
  // accept). Mirrors the per-game route's body shape exactly.
  targetUserId?: string;
  // Forwarded verbatim; not validated against `Role` server-side. An
  // invalid roleId surfaces at accept time when the dev's flow tries to
  // assign it.
  roleId?: string;
  // `<positive integer><unit>` where unit is `s|m|h|d`. The server stamps
  // `expiresAt = now() + expiresIn` post-validation; non-positive
  // durations like `0d` return 400. Omitted = no expiry.
  expiresIn?: string;
}

// Undefined fields are dropped from the wire body so the server's
// non-empty-string constraints do not reject. An empty body `{}` is valid
// and produces an open-code invitation with no role and no expiry.
export function createAdminGroupInvitation(
  gameId: string,
  groupId: string,
  input: CreateAdminGroupInvitationInput = {},
  opts?: MutationOptions,
): Promise<AdminInvitation> {
  const body: Record<string, string> = {};
  if (input.targetUserId !== undefined) body.targetUserId = input.targetUserId;
  if (input.roleId !== undefined) body.roleId = input.roleId;
  if (input.expiresIn !== undefined) body.expiresIn = input.expiresIn;
  return adminMutate<Record<string, string>, AdminInvitation>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/invitations`,
    body,
    opts,
  );
}

// Phase 11.6a-i / 11.6a-ii wire shapes mirroring `WireAdminRole` and
// `WireAdminPermissionDef` from `packages/server/src/routes/admin.ts`. The
// dashboard's group detail Roles tab (Phase 11.6b) renders an `AdminRole[]`
// and drives create / update / delete through these helpers; the
// Permissions matrix tab (Phase 11.6c) will additionally consume the
// per-game catalog endpoint plus the role-permission grant / revoke
// helpers below.

export interface AdminRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  // Always present on the wire; an empty array means the role has no
  // permission grants. Populated from a single batched query server-side
  // so a list of N roles costs one extra round trip regardless of N.
  permissions: string[];
  createdAt: string;
}

export interface AdminPermissionDef {
  key: string;
  // Reserved for a future write path; today every server response sets
  // this to `null` because no V1 endpoint populates it. Surfacing it on
  // the wire avoids a coordinated wire-shape addition later.
  description: string | null;
  createdAt: string;
}

// Mirrors the server-side caps in `routes/admin.schema.ts:adminCreateRoleBody`
// so the dashboard's Add / Edit role dialogs can enforce the same limits
// via input maxLength attributes without a round trip to learn what the
// server accepts. Color regex matches the same case-insensitive hex pattern.
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
  // `null` clears the color (matches the server schema). Omit the field
  // entirely to leave the stored value alone.
  color?: string | null;
  isDefault?: boolean;
}

export function fetchAdminGroupRoles(
  gameId: string,
  groupId: string,
  opts?: FetchOptions,
): Promise<AdminRole[]> {
  return adminFetch<AdminRole[]>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/roles`,
    opts,
  );
}

// Undefined fields are dropped so a stale form posting `color=undefined`
// does not collide with the server's optional-but-non-empty constraint.
// The server's `adminCreateRoleBody` defaults `color: null` and
// `isDefault: false` when omitted; we forward only what the caller sets.
export function createAdminGroupRole(
  gameId: string,
  groupId: string,
  input: CreateAdminRoleInput,
  opts?: MutationOptions,
): Promise<AdminRole> {
  const body: Record<string, unknown> = {
    name: input.name,
    priority: input.priority,
  };
  if (input.color !== undefined) body.color = input.color;
  if (input.isDefault !== undefined) body.isDefault = input.isDefault;
  return adminMutate<Record<string, unknown>, AdminRole>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/roles`,
    body,
    opts,
  );
}

// PATCH semantics: only fields whose value differs from the stored row
// land in the audit payload server-side; the same wire body that sets a
// value also clears it via `color: null`. Caller must supply at least one
// field (the server returns 400 on an empty body).
export function updateAdminRole(
  gameId: string,
  roleId: string,
  input: UpdateAdminRoleInput,
  opts?: MutationOptions,
): Promise<AdminRole> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.priority !== undefined) body.priority = input.priority;
  // `color` is the one field that round-trips `null` verbatim - the
  // server treats `null` as "clear the color" and `undefined` as "leave
  // alone". `Object.hasOwn` lets a caller supply `null` without us
  // dropping it via the truthy check.
  if (Object.hasOwn(input, "color")) body.color = input.color;
  if (input.isDefault !== undefined) body.isDefault = input.isDefault;
  return adminMutate<Record<string, unknown>, AdminRole>(
    "PATCH",
    `/v1/admin/games/${encodeURIComponent(gameId)}/roles/${encodeURIComponent(roleId)}`,
    body,
    opts,
  );
}

export function deleteAdminRole(
  gameId: string,
  roleId: string,
  opts?: MutationOptions,
): Promise<void> {
  return adminDelete(
    `/v1/admin/games/${encodeURIComponent(gameId)}/roles/${encodeURIComponent(roleId)}`,
    opts,
  );
}

// Phase 11.6a-ii catalog endpoint + role-permission grant / revoke
// helpers. Phase 11.6c (Permissions matrix tab) consumes the catalog
// endpoint for column ordering and the grant / revoke helpers for per-cell
// state changes; this iteration ships them alongside the role CRUD because
// they share the same Server Action surface (the operator may want to
// remove a permission from a role without leaving the Roles tab).

export function fetchAdminGamePermissions(
  gameId: string,
  opts?: FetchOptions,
): Promise<AdminPermissionDef[]> {
  return adminFetch<AdminPermissionDef[]>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/permissions`,
    opts,
  );
}

export function grantAdminRolePermission(
  gameId: string,
  roleId: string,
  permission: string,
  opts?: MutationOptions,
): Promise<AdminRole> {
  return adminMutate<{ permission: string }, AdminRole>(
    "POST",
    `/v1/admin/games/${encodeURIComponent(gameId)}/roles/${encodeURIComponent(roleId)}/permissions`,
    { permission },
    opts,
  );
}

// The server's revoke endpoint is `DELETE` (the per-game route shape;
// the admin handler mirrors it byte-for-byte) yet returns a 200 with the
// post-state role JSON, not 204. The `adminMutate` helper with method
// "DELETE" and `body: null` reads the response body just like the other
// mutations; the dedicated `adminDelete` helper above is only used for
// endpoints that return 204 (the role-itself delete and the override
// clear).
export function revokeAdminRolePermission(
  gameId: string,
  roleId: string,
  permission: string,
  opts?: MutationOptions,
): Promise<AdminRole> {
  return adminMutate<null, AdminRole>(
    "DELETE",
    `/v1/admin/games/${encodeURIComponent(gameId)}/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permission)}`,
    null,
    opts,
  );
}

// Phase 11.7a-i wire shape mirroring `WireAuditEntry` from
// `packages/server/src/routes/audit.ts` (which the admin handler reuses
// verbatim per the iter-070 invitation precedent). Distinct from
// `AdminAuditEntry` above (the cross-game recent-audit feed shape that
// pivots `gameName` / `groupName` / `groupSoftDeleted` for the home page);
// the per-group endpoint does not need those columns because the
// dashboard already has gameId + groupId from URL context.

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
  // ISO `createdAt` of the last item in the page when more rows exist;
  // caller pages by passing this value back as `before` on the next call.
  // Null on the final page.
  nextCursor: string | null;
}

// Mirrors the `AuditAction` union in `@junjo/shared` and the server's
// `AUDIT_ACTIONS` const list in `routes/audit.schema.ts`. Surfaced here so
// the action filter dropdown can render every value without a round-trip.
// New audit actions land in three places (the server schema, the shared
// type, and this list) - all three must stay in lockstep.
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

// The server caps `limit` at 100; the dashboard never asks for more than
// the largest page-size selector value. Defaults to 50 (matching the
// server's `listAuditQuery` default).
export const ADMIN_AUDIT_PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100];
export const ADMIN_AUDIT_DEFAULT_PAGE_SIZE = 50;

export interface FetchAdminGroupAuditParams {
  limit?: number;
  // ISO 8601 timestamp; entries with `createdAt < before` are returned.
  // Pass back the previous page's `nextCursor` to walk the feed.
  before?: string;
  actions?: string[];
}

// `actions` repeats per filter value (`?actions=foo&actions=bar`). Empty
// arrays and zero-length strings are dropped from the wire request so the
// server's enum / non-empty validation does not 400 on a stale URL.
export function fetchAdminGroupAudit(
  gameId: string,
  groupId: string,
  params: FetchAdminGroupAuditParams = {},
  opts?: FetchOptions,
): Promise<AdminGroupAuditPage> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.before !== undefined && params.before.length > 0) qs.set("before", params.before);
  if (params.actions !== undefined && params.actions.length > 0) {
    for (const action of params.actions) {
      if (action.length > 0) qs.append("actions", action);
    }
  }
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/audit`;
  const search = qs.toString();
  return adminFetch<AdminGroupAuditPage>(search ? `${path}?${search}` : path, opts);
}

// Phase 11.7b-i wire shape mirroring `WireGroupRelationship` from
// `packages/server/src/routes/relationships.ts` (which the admin handlers
// reuse verbatim per the iter-070 / iter-076 precedent of cross-importing
// pure helpers from per-game route modules). Five fields total; the
// directed pair `(groupAId, groupBId)` is the unique key in the schema and
// the `since` timestamp bumps on every type change. `setBy` is null today
// because the admin handlers always pass `null` for `setByUserId` (no
// auth-adapter actor wired); reserved for a future iteration that threads
// an admin actor identifier through `adminAuthMiddleware`.
export interface AdminGroupRelationship {
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setBy: string | null;
}

// Mirrors the server-side cap in `routes/admin.schema.ts:adminSetRelationshipBody`
// so the dashboard's set-relationship dialog can enforce the same limit
// via input maxLength attributes without a round trip to learn what the
// server accepts. Surfaced here so consumers can hand-edit URLs / forms
// without bouncing off the server with a generic 400.
export const ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH = 64;

export interface SetAdminGroupRelationshipInput {
  type: string;
  // When true, writes both A->B and B->A directions in one call. Each
  // direction is independent at the audit / event layer (the server emits
  // up to two `group.relationship.changed` events and up to two audit
  // entries per call). Default false (one-way only).
  mutual?: boolean;
}

export function fetchAdminGroupRelationships(
  gameId: string,
  groupId: string,
  opts?: FetchOptions,
): Promise<AdminGroupRelationship[]> {
  return adminFetch<AdminGroupRelationship[]>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/relationships`,
    opts,
  );
}

// PUT semantics: idempotent on each direction (already-matching `type` ->
// no DB write, no audit, no `since` bump). Always returns the A->B row;
// `mutual: true` writes both directions but the caller still gets the
// directed primary back. Server returns 200 with the post-state row.
export function setAdminGroupRelationship(
  gameId: string,
  groupAId: string,
  groupBId: string,
  input: SetAdminGroupRelationshipInput,
  opts?: MutationOptions,
): Promise<AdminGroupRelationship> {
  const body: Record<string, unknown> = { type: input.type };
  if (input.mutual !== undefined) body.mutual = input.mutual;
  return adminMutate<Record<string, unknown>, AdminGroupRelationship>(
    "PUT",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`,
    body,
    opts,
  );
}

// Idempotent on missing rows (no audit, no event, server returns 204
// regardless). When `mutual: true`, clears both A->B and B->A
// independently; each direction emits its own audit + event when actually
// cleared. Default false (one-way only).
export function clearAdminGroupRelationship(
  gameId: string,
  groupAId: string,
  groupBId: string,
  mutual: boolean,
  opts?: MutationOptions,
): Promise<void> {
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`;
  const search = mutual ? "?mutual=true" : "";
  return adminDelete(`${path}${search}`, opts);
}

// Phase 11.8a wire shape for the game-wide audit feed (Phase 11.8b
// dashboard page). Reuses `AdminAuditEntry` from iter-059 for the row
// shape (identical fields: gameId / gameName / groupId / groupName /
// groupSoftDeleted / actorUserId / targetId / payload / createdAt /
// action / id) and wraps it in a paginated envelope: `nextCursor` is
// the ISO `createdAt` of the last item when more pages exist (the
// per-game endpoint is timestamp-paginated; the cross-game home feed
// from iter-059 is not).
export interface AdminGameAuditPage {
  items: AdminAuditEntry[];
  nextCursor: string | null;
}

// Mirrors the server-side caps in `routes/admin.schema.ts:listAdminGameAuditQuery`
// so the dashboard's actor / target inputs can enforce the same limits
// via maxLength attributes without bouncing off the server with a generic
// 400. Both 255 chars to match the existing `Invitation` user-id shape.
export const ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH = 255;
export const ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH = 255;

// The server caps `limit` at 100; the dashboard never asks for more than
// the largest page-size selector value. Defaults to 50 (matching the
// server's `listAdminGameAuditQuery` default).
export const ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS: readonly number[] = [25, 50, 100];
export const ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE = 50;

export interface FetchAdminGameAuditParams {
  limit?: number;
  // ISO 8601 timestamp; entries with `createdAt < before` are returned.
  // Doubles as the pagination cursor (pass back the previous page's
  // `nextCursor`) and the user-supplied date-range upper bound. The
  // server filters with strict `<`, so the same value works for both
  // intents without clobbering boundary entries.
  before?: string;
  // ISO 8601 timestamp; entries with `createdAt >= since` are returned.
  // Inclusive lower bound (asymmetric with `before` on purpose: `since`
  // is a date-range filter, `before` is the pagination cursor).
  since?: string;
  actions?: string[];
  // Exact match on the stored `AuditEntry.actorUserId` (the internal
  // `JunjoUser.id` for routes that resolved an actor; null for routes
  // that wrote `actorUserId: null`). The dashboard surfaces the value
  // from a prior row in the feed; future iterations could add an
  // external-id resolver.
  actorUserId?: string;
  // Exact match on the stored `AuditEntry.targetId`. The stored value
  // varies by route (sometimes external user id, sometimes member id,
  // sometimes role id) so a single resolution rule would be wrong half
  // the time. Operators copy the value from a prior row.
  targetId?: string;
}

// `actions` repeats per filter value (`?actions=foo&actions=bar`). Empty
// arrays and zero-length strings are dropped from the wire request so the
// server's enum / non-empty validation does not 400 on a stale URL.
// `actorUserId` and `targetId` are dropped when empty for the same reason.
export function fetchAdminGameAudit(
  gameId: string,
  params: FetchAdminGameAuditParams = {},
  opts?: FetchOptions,
): Promise<AdminGameAuditPage> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.before !== undefined && params.before.length > 0) qs.set("before", params.before);
  if (params.since !== undefined && params.since.length > 0) qs.set("since", params.since);
  if (params.actions !== undefined && params.actions.length > 0) {
    for (const action of params.actions) {
      if (action.length > 0) qs.append("actions", action);
    }
  }
  if (params.actorUserId !== undefined && params.actorUserId.length > 0) {
    qs.set("actorUserId", params.actorUserId);
  }
  if (params.targetId !== undefined && params.targetId.length > 0) {
    qs.set("targetId", params.targetId);
  }
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/audit`;
  const search = qs.toString();
  return adminFetch<AdminGameAuditPage>(search ? `${path}?${search}` : path, opts);
}

// Phase 11.7c-i wire helpers backing the dashboard's group detail Sub-
// groups tab in 11.7c-ii. The two endpoints mirror the per-game `PUT
// /v1/groups/:id/parent` and `GET /v1/groups/:id/children` semantics
// byte-for-byte; the children list reuses `AdminGroup` (the per-row shape
// is identical to what the groups browser already renders, so the
// dashboard can lean on the same column conventions).

export interface SetAdminGroupParentInput {
  // The id of the new parent group, or `null` to clear. Required field;
  // the server's body schema rejects an absent key. Self-parent
  // (`parentGroupId === <target group id>`) is rejected with `400
  // parent_cycle`; supplying an ancestor of the target group is also
  // rejected after the server walks up the chain (capped at depth 100).
  parentGroupId: string | null;
}

// PUT semantics: idempotent on matching `parentGroupId` (no DB write, no
// audit, no event); on a value change the server writes a single
// `group.parent.set` or `group.parent.cleared` audit entry and dispatches
// a `group.updated` JunjoEvent (no dedicated `GroupParentChangedEvent`
// in the union, mirroring the per-game route's choice). Always returns
// the post-state group with freshly counted `memberCount`.
export function setAdminGroupParent(
  gameId: string,
  groupId: string,
  input: SetAdminGroupParentInput,
  opts?: MutationOptions,
): Promise<AdminGroup> {
  return adminMutate<SetAdminGroupParentInput, AdminGroup>(
    "PUT",
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/parent`,
    input,
    opts,
  );
}

// Returns direct children only (groups whose `parentGroupId` points at
// this one). Grandchildren are NOT recursed; the operator drills into a
// child's detail page to see its own sub-tree. Soft-deleted children are
// excluded server-side. Sorted by `(createdAt desc, id desc)` to match
// the groups browser's default ordering. Each item is a full `AdminGroup`
// (same shape `fetchAdminGroupsForGame` returns) with a freshly counted
// `memberCount`.
export function fetchAdminGroupChildren(
  gameId: string,
  groupId: string,
  opts?: FetchOptions,
): Promise<AdminGroup[]> {
  return adminFetch<AdminGroup[]>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/groups/${encodeURIComponent(groupId)}/children`,
    opts,
  );
}

// Phase 11.9a-i wire shape mirroring `PermissionCheckResult` from
// `@junjo/shared`. The admin endpoint reuses the per-game check route's
// resolution logic byte-for-byte (same source taxonomy, same viaRoleId
// semantics, same shared singleton cache); the dashboard owns its own
// typed view here so it does not import across the cloud-only boundary.
export type AdminPermissionSource = "none" | "default" | "role" | "override";

export interface AdminPermissionCheckResult {
  allowed: boolean;
  source: AdminPermissionSource;
  // Present only when `source === "role"`; the highest-priority role
  // that granted the permission. The dashboard surfaces it in monospace
  // and the operator cross-references against the Roles tab to find
  // the named role.
  viaRoleId?: string;
}

// Mirrors the server-side caps in `routes/admin.schema.ts:adminCheckPermissionQuery`
// so the dashboard's tester form can enforce the same limit via input
// maxLength attributes. Reuses `ADMIN_PERMISSION_KEY_MAX_LENGTH` (128)
// declared above.

export interface FetchAdminPermissionCheckParams {
  userId: string;
  groupId: string;
  permission: string;
}

// All three params are required; the server validates them with
// `min(1)`. The dashboard's tester rejects empty fields client-side so
// the wire request never reaches the server with empty values, but the
// server-side validation still catches stale URLs / hand-edited forms.
// `revalidate: 0` is forced so the operator's "Run again" always hits
// the server (the underlying singleton permission cache still bounds
// load to one resolver call per (gameId, groupId, userId, permission)
// per 60 seconds; subsequent re-fetches read from the cache without
// invalidating it).
export function fetchAdminPermissionCheck(
  gameId: string,
  params: FetchAdminPermissionCheckParams,
  opts?: FetchOptions,
): Promise<AdminPermissionCheckResult> {
  const qs = new URLSearchParams();
  qs.set("userId", params.userId);
  qs.set("groupId", params.groupId);
  qs.set("permission", params.permission);
  return adminFetch<AdminPermissionCheckResult>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/permissions/check?${qs.toString()}`,
    { ...opts, revalidate: opts?.revalidate ?? 0 },
  );
}
