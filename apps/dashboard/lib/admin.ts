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
  method: "POST",
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
