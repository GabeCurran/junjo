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
