// @license All Rights Reserved (see apps/dashboard/LICENSE)
import "server-only";

import type {
  AdminApiKey,
  AdminApiKeyCreated,
  AdminApiKeyList,
  AdminAuditPage,
  AdminGame,
  AdminGameAuditPage,
  AdminGameList,
  AdminGroup,
  AdminGroupAuditPage,
  AdminGroupChurn,
  AdminGroupGrowth,
  AdminGroupList,
  AdminGroupMember,
  AdminGroupMemberList,
  AdminGroupRelationship,
  AdminInvitation,
  AdminMemberActivity,
  AdminMemberPermissionOverride,
  AdminPermissionCheckResult,
  AdminPermissionDef,
  AdminPermissionUsage,
  AdminRole,
  AdminRoleDistribution,
  AdminStats,
  CreateAdminGroupInvitationInput,
  CreateAdminRoleInput,
  FetchAdminGameAuditParams,
  FetchAdminGroupAuditParams,
  FetchAdminGroupChurnParams,
  FetchAdminGroupGrowthParams,
  FetchAdminGroupMembersParams,
  FetchAdminGroupsParams,
  FetchAdminMemberActivityParams,
  FetchAdminPermissionCheckParams,
  KickAdminGroupMemberInput,
  SetAdminGroupParentInput,
  SetAdminGroupRelationshipInput,
  SetAdminMemberPermissionOverrideInput,
  UpdateAdminGroupMemberInput,
  UpdateAdminRoleInput,
} from "./admin-shared";
import { getAdminToken, getJunjoBaseUrl } from "./junjo";

// Re-export every client-safe symbol so server-side callers continue to
// import from `./admin` unchanged. The split is purely organisational:
// `lib/admin-shared.ts` holds the runtime-free type/interface/constant
// declarations so `"use client"` components can import them without
// dragging the server-only chain (this file -> `./junjo` -> `@junjo/sdk`)
// into the client bundle.
export * from "./admin-shared";

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

// DELETE has its own helper because it returns 204 (no body) on success.
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

// `q`, `kind`, and `visibility` are dropped from the wire request when
// undefined or empty so the server schema (which rejects empty strings) does
// not 400 on a stale URL.
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

// `q` is dropped from the wire request when empty so the server schema
// (which rejects empty strings) does not 400 on a stale URL.
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
// this helper forces `revalidate: 0`.
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

// PATCH semantics: `color: null` clears it; `color: undefined` leaves alone.
export function updateAdminRole(
  gameId: string,
  roleId: string,
  input: UpdateAdminRoleInput,
  opts?: MutationOptions,
): Promise<AdminRole> {
  const body: Record<string, unknown> = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.priority !== undefined) body.priority = input.priority;
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

// The server's revoke endpoint is `DELETE` yet returns a 200 with the
// post-state role JSON, not 204. The `adminMutate` helper with method
// "DELETE" reads the response body just like the other mutations.
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

// `actions` repeats per filter value (`?actions=foo&actions=bar`).
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

// PUT semantics: idempotent on each direction.
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

// Idempotent on missing rows (server returns 204 regardless).
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

// `actions` repeats per filter value; empty arrays / strings dropped.
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

// PUT semantics: self-parent / cycle rejected with 400 parent_cycle.
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

// Returns direct children only; soft-deleted children are excluded server-side.
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

export function fetchAdminGameGroupChurn(
  gameId: string,
  params: FetchAdminGroupChurnParams = {},
  opts?: FetchOptions,
): Promise<AdminGroupChurn> {
  const qs = new URLSearchParams();
  if (params.from !== undefined && params.from.length > 0) qs.set("from", params.from);
  if (params.to !== undefined && params.to.length > 0) qs.set("to", params.to);
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/analytics/group-churn`;
  const search = qs.toString();
  return adminFetch<AdminGroupChurn>(search ? `${path}?${search}` : path, opts);
}

export function fetchAdminGameGroupGrowth(
  gameId: string,
  params: FetchAdminGroupGrowthParams = {},
  opts?: FetchOptions,
): Promise<AdminGroupGrowth> {
  const qs = new URLSearchParams();
  if (params.from !== undefined && params.from.length > 0) qs.set("from", params.from);
  if (params.to !== undefined && params.to.length > 0) qs.set("to", params.to);
  if (params.topN !== undefined) qs.set("topN", String(params.topN));
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/analytics/group-growth`;
  const search = qs.toString();
  return adminFetch<AdminGroupGrowth>(search ? `${path}?${search}` : path, opts);
}

export function fetchAdminGameMemberActivity(
  gameId: string,
  params: FetchAdminMemberActivityParams = {},
  opts?: FetchOptions,
): Promise<AdminMemberActivity> {
  const qs = new URLSearchParams();
  if (params.from !== undefined && params.from.length > 0) qs.set("from", params.from);
  if (params.to !== undefined && params.to.length > 0) qs.set("to", params.to);
  const path = `/v1/admin/games/${encodeURIComponent(gameId)}/analytics/member-activity`;
  const search = qs.toString();
  return adminFetch<AdminMemberActivity>(search ? `${path}?${search}` : path, opts);
}

export function fetchAdminGameRoleDistribution(
  gameId: string,
  opts?: FetchOptions,
): Promise<AdminRoleDistribution> {
  return adminFetch<AdminRoleDistribution>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/analytics/role-distribution`,
    opts,
  );
}

export function fetchAdminGamePermissionUsage(
  gameId: string,
  opts?: FetchOptions,
): Promise<AdminPermissionUsage> {
  return adminFetch<AdminPermissionUsage>(
    `/v1/admin/games/${encodeURIComponent(gameId)}/analytics/permission-usage`,
    opts,
  );
}

// All three params are required; `revalidate: 0` is forced so "Run again"
// always hits the server (the underlying singleton permission cache still
// bounds load to one resolver call per (gameId, groupId, userId, permission)
// per 60 seconds).
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
