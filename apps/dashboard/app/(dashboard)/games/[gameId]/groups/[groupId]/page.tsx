// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AuditFeed, type AuditQueryState } from "../../../../../../components/dashboard/audit-feed";
import {
  GroupFigures,
  GroupMeta,
} from "../../../../../../components/dashboard/group-detail-header";
import {
  GROUP_DETAIL_DEFAULT_TAB,
  GROUP_DETAIL_TABS,
  type GroupDetailTab,
  GroupDetailTabs,
} from "../../../../../../components/dashboard/group-detail-tabs";
import {
  type MembersQueryState,
  MembersTable,
} from "../../../../../../components/dashboard/members-table";
import { PageHeader } from "../../../../../../components/dashboard/page-header";
import { PermissionsMatrix } from "../../../../../../components/dashboard/permissions-matrix";
import { RelationshipsTable } from "../../../../../../components/dashboard/relationships-table";
import { RolesTable } from "../../../../../../components/dashboard/roles-table";
import { SubGroupsTable } from "../../../../../../components/dashboard/sub-groups-table";
import { Notice } from "../../../../../../components/ui/section";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_DEFAULT_PAGE_SIZE,
  ADMIN_AUDIT_PAGE_SIZE_OPTIONS,
  ADMIN_MEMBERS_DEFAULT_PAGE_SIZE,
  ADMIN_MEMBERS_PAGE_SIZE_OPTIONS,
  ADMIN_MEMBER_STATUS_FILTERS,
  AdminDisabledError,
  type AdminGroup,
  type AdminGroupAuditPage,
  type AdminGroupMemberList,
  type AdminGroupRelationship,
  type AdminMemberStatusFilter,
  type AdminPermissionDef,
  type AdminRole,
  fetchAdminGamePermissions,
  fetchAdminGroup,
  fetchAdminGroupAudit,
  fetchAdminGroupChildren,
  fetchAdminGroupMembers,
  fetchAdminGroupRelationships,
  fetchAdminGroupRoles,
} from "../../../../../../lib/admin";

interface GroupDetailPageProps {
  params: Promise<{ gameId: string; groupId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const SEARCH_VALUE_MAX = 255;
const SEARCH_LIMIT_MAX = 100;

export async function generateMetadata(props: GroupDetailPageProps) {
  const params = await props.params;
  // Best-effort title: fall back to a generic label if the lookup fails. The
  // page body itself surfaces a more descriptive empty state on failure.
  try {
    const group = await fetchAdminGroup(params.gameId, params.groupId);
    return { title: `${group.name} | Junjo Dashboard` };
  } catch {
    return { title: "Group | Junjo Dashboard" };
  }
}

// Lenient parser: invalid values fall through to defaults rather than 400.
// A stale URL, from a deploy with a different status allowlist, should not
// blow up the page; it just resets the affected param.
function readParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = searchParams[key];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

function parseQuery(
  searchParams: Record<string, string | string[] | undefined>,
): MembersQueryState {
  const rawQ = readParam(searchParams, "q") ?? "";
  const q = rawQ.trim().slice(0, SEARCH_VALUE_MAX);

  const rawStatus = readParam(searchParams, "status");
  const status: AdminMemberStatusFilter =
    rawStatus !== undefined &&
    (ADMIN_MEMBER_STATUS_FILTERS as readonly string[]).includes(rawStatus)
      ? (rawStatus as AdminMemberStatusFilter)
      : "active";

  const offsetRaw = Number(readParam(searchParams, "offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0;

  const limitRaw = Number(readParam(searchParams, "limit"));
  const limit =
    Number.isFinite(limitRaw) &&
    ADMIN_MEMBERS_PAGE_SIZE_OPTIONS.includes(Math.trunc(limitRaw)) &&
    limitRaw <= SEARCH_LIMIT_MAX
      ? Math.trunc(limitRaw)
      : ADMIN_MEMBERS_DEFAULT_PAGE_SIZE;

  return { q, status, offset, limit };
}

// The active tab is read from `?tab=`; unknown values fall back to the
// default (members) so a stale URL after a future tab rename does not 404
// or empty the page.
function parseActiveTab(
  searchParams: Record<string, string | string[] | undefined>,
): GroupDetailTab {
  const raw = readParam(searchParams, "tab");
  if (raw === undefined) return GROUP_DETAIL_DEFAULT_TAB;
  if ((GROUP_DETAIL_TABS as readonly string[]).includes(raw)) {
    return raw as GroupDetailTab;
  }
  return GROUP_DETAIL_DEFAULT_TAB;
}

// Audit tab query parser. Uses namespaced URL params (`auditActions`,
// `auditBefore`, `auditLimit`) so they do not collide with the members
// tab's `q` / `status` / `offset` / `limit`. Lenient like the members
// parser: invalid values fall through to defaults rather than returning
// 400.
function parseAuditQuery(
  searchParams: Record<string, string | string[] | undefined>,
): AuditQueryState {
  const rawActions = searchParams.auditActions;
  const candidates = Array.isArray(rawActions)
    ? rawActions
    : rawActions !== undefined
      ? [rawActions]
      : [];
  const validActions = new Set(ADMIN_AUDIT_ACTIONS);
  const actions = candidates.filter((a) => typeof a === "string" && validActions.has(a));

  const rawBefore = readParam(searchParams, "auditBefore");
  const before =
    rawBefore !== undefined && rawBefore.length > 0 && !Number.isNaN(Date.parse(rawBefore))
      ? rawBefore
      : undefined;

  const limitRaw = Number(readParam(searchParams, "auditLimit"));
  const limit =
    Number.isFinite(limitRaw) &&
    ADMIN_AUDIT_PAGE_SIZE_OPTIONS.includes(Math.trunc(limitRaw)) &&
    limitRaw <= SEARCH_LIMIT_MAX
      ? Math.trunc(limitRaw)
      : ADMIN_AUDIT_DEFAULT_PAGE_SIZE;

  return { actions, before, limit };
}

// A loading block shaped like a toolbar over a few table rows.
function TabSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <div className="flex items-center justify-between gap-3">
        <div className="h-9 w-64 animate-pulse rounded-md bg-muted" />
        <div className="h-9 w-28 animate-pulse rounded-md bg-muted" />
      </div>
      <div className="flex flex-col">
        <div className="h-8 border-b border-border" />
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows never reorder.
          <div key={i} className="flex items-center gap-6 border-b border-border/60 py-3">
            <div className="h-4 w-1/4 animate-pulse rounded bg-muted" />
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-4 w-24 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

// The failure every tab shares when the dashboard has no admin token.
function AdminOffNotice({ what }: { what: string }) {
  return (
    <Notice
      title="Cross-game access is off"
      body={`Set JUNJO_ADMIN_TOKEN on the dashboard and the server to load ${what}.`}
    />
  );
}

function failureBody(err: unknown, what: string): string {
  return err instanceof Error ? err.message : `The ${what} request failed.`;
}

// Every tab body below shares the group fetch's 404 contract: a missing
// group already resolved to notFound() in the page, so a failure here is
// a transient backend error or a race with a delete.

async function RolesBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let roles: AdminRole[];
  try {
    roles = await fetchAdminGroupRoles(gameId, groupId);
  } catch (err) {
    if (err instanceof AdminDisabledError) return <AdminOffNotice what="roles" />;
    return <Notice title="Could not load roles" body={failureBody(err, "roles")} />;
  }

  return <RolesTable roles={roles} gameId={gameId} groupId={groupId} />;
}

async function AuditBody({
  gameId,
  groupId,
  groupName,
  query,
}: {
  gameId: string;
  groupId: string;
  groupName: string;
  query: AuditQueryState;
}) {
  let page: AdminGroupAuditPage;
  try {
    page = await fetchAdminGroupAudit(gameId, groupId, {
      limit: query.limit,
      before: query.before,
      actions: query.actions.length > 0 ? query.actions : undefined,
    });
  } catch (err) {
    if (err instanceof AdminDisabledError) return <AdminOffNotice what="the audit log" />;
    return <Notice title="Could not load the audit log" body={failureBody(err, "audit")} />;
  }

  return <AuditFeed page={page} query={query} groupName={groupName} />;
}

async function RelationshipsBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let relationships: AdminGroupRelationship[];
  try {
    relationships = await fetchAdminGroupRelationships(gameId, groupId);
  } catch (err) {
    if (err instanceof AdminDisabledError) return <AdminOffNotice what="relationships" />;
    return <Notice title="Could not load relationships" body={failureBody(err, "relationships")} />;
  }

  return <RelationshipsTable relationships={relationships} gameId={gameId} groupId={groupId} />;
}

async function SubGroupsBody({ gameId, group }: { gameId: string; group: AdminGroup }) {
  let children: AdminGroup[];
  try {
    children = await fetchAdminGroupChildren(gameId, group.id);
  } catch (err) {
    if (err instanceof AdminDisabledError) return <AdminOffNotice what="sub-groups" />;
    return <Notice title="Could not load sub-groups" body={failureBody(err, "sub-groups")} />;
  }

  return <SubGroupsTable group={group} childGroups={children} gameId={gameId} />;
}

async function PermissionsBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let roles: AdminRole[];
  let catalog: AdminPermissionDef[];
  try {
    // The matrix needs both rows (roles) and columns (catalog keys).
    [roles, catalog] = await Promise.all([
      fetchAdminGroupRoles(gameId, groupId),
      fetchAdminGamePermissions(gameId),
    ]);
  } catch (err) {
    if (err instanceof AdminDisabledError) return <AdminOffNotice what="permissions" />;
    return <Notice title="Could not load permissions" body={failureBody(err, "permissions")} />;
  }

  return <PermissionsMatrix roles={roles} catalog={catalog} gameId={gameId} groupId={groupId} />;
}

async function MembersBody({
  gameId,
  groupId,
  query,
}: {
  gameId: string;
  groupId: string;
  query: MembersQueryState;
}) {
  let page: AdminGroupMemberList;
  try {
    page = await fetchAdminGroupMembers(gameId, groupId, {
      limit: query.limit,
      offset: query.offset,
      status: query.status,
      q: query.q.length > 0 ? query.q : undefined,
    });
  } catch (err) {
    if (err instanceof AdminDisabledError) return <AdminOffNotice what="members" />;
    return <Notice title="Could not load members" body={failureBody(err, "members")} />;
  }

  return <MembersTable data={page} query={query} gameId={gameId} groupId={groupId} />;
}

export default async function GroupDetailPage(props: GroupDetailPageProps) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const activeTab = parseActiveTab(searchParams);
  const query = parseQuery(searchParams);
  const auditQuery = parseAuditQuery(searchParams);
  // The Suspense `key` for the members panel is the serialized query so the
  // skeleton flashes when the operator changes a filter, sort, or page.
  // Without the key, React would reuse the previous Suspense boundary while
  // the server re-runs, leaving the old data on screen during the fetch.
  const membersKey = JSON.stringify(query);
  const auditKey = JSON.stringify(auditQuery);

  const allGroupsLink = (
    <Link
      href={`/games/${encodeURIComponent(params.gameId)}/groups`}
      className="text-sm text-muted-foreground hover:text-foreground hover:underline"
    >
      All groups
    </Link>
  );

  // The group heads the page, so it loads before the tabs. The fetch is
  // cached, so generateMetadata and this call share one request.
  let group: AdminGroup;
  try {
    group = await fetchAdminGroup(params.gameId, params.groupId);
  } catch (err) {
    // The server reports a missing group as "group not found"; the match
    // is narrow so anything else renders the inline failure below.
    if (
      err instanceof Error &&
      !(err instanceof AdminDisabledError) &&
      /not.?found/i.test(err.message)
    ) {
      notFound();
    }
    return (
      <>
        <PageHeader title="Group" actions={allGroupsLink} />
        <main className="flex-1 px-6 pb-12 pt-4">
          <div className="max-w-screen-2xl">
            {err instanceof AdminDisabledError ? (
              <AdminOffNotice what="this group" />
            ) : (
              <Notice title="Could not load the group" body={failureBody(err, "group")} />
            )}
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <PageHeader title={group.name} meta={<GroupMeta group={group} />} actions={allGroupsLink} />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-screen-2xl flex-col gap-8">
          <GroupFigures group={group} />
          <div className="flex flex-col gap-5">
            <GroupDetailTabs gameId={params.gameId} groupId={params.groupId} active={activeTab} />
            {activeTab === "roles" ? (
              <Suspense fallback={<TabSkeleton rows={3} />}>
                <RolesBody gameId={params.gameId} groupId={params.groupId} />
              </Suspense>
            ) : activeTab === "permissions" ? (
              <Suspense fallback={<TabSkeleton rows={3} />}>
                <PermissionsBody gameId={params.gameId} groupId={params.groupId} />
              </Suspense>
            ) : activeTab === "audit" ? (
              <Suspense key={auditKey} fallback={<TabSkeleton />}>
                <AuditBody
                  gameId={params.gameId}
                  groupId={params.groupId}
                  groupName={group.name}
                  query={auditQuery}
                />
              </Suspense>
            ) : activeTab === "relationships" ? (
              <Suspense fallback={<TabSkeleton rows={3} />}>
                <RelationshipsBody gameId={params.gameId} groupId={params.groupId} />
              </Suspense>
            ) : activeTab === "sub-groups" ? (
              <Suspense fallback={<TabSkeleton rows={3} />}>
                <SubGroupsBody gameId={params.gameId} group={group} />
              </Suspense>
            ) : (
              <Suspense key={membersKey} fallback={<TabSkeleton />}>
                <MembersBody gameId={params.gameId} groupId={params.groupId} query={query} />
              </Suspense>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
