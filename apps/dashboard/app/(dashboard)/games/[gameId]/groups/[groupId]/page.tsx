// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AuditFeed, type AuditQueryState } from "../../../../../../components/dashboard/audit-feed";
import { GroupDetailHeader } from "../../../../../../components/dashboard/group-detail-header";
import {
  GROUP_DETAIL_DEFAULT_TAB,
  GROUP_DETAIL_TABS,
  type GroupDetailTab,
  GroupDetailTabs,
  getTabDescription,
} from "../../../../../../components/dashboard/group-detail-tabs";
import {
  type MembersQueryState,
  MembersTable,
} from "../../../../../../components/dashboard/members-table";
import { PermissionsMatrix } from "../../../../../../components/dashboard/permissions-matrix";
import { RelationshipsTable } from "../../../../../../components/dashboard/relationships-table";
import { RolesTable } from "../../../../../../components/dashboard/roles-table";
import { SubGroupsTable } from "../../../../../../components/dashboard/sub-groups-table";
import { Topbar } from "../../../../../../components/dashboard/topbar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../../../components/ui/card";
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
  params: { gameId: string; groupId: string };
  searchParams: Record<string, string | string[] | undefined>;
}

const SEARCH_VALUE_MAX = 255;
const SEARCH_LIMIT_MAX = 100;

export async function generateMetadata({ params }: GroupDetailPageProps) {
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
// A stale URL (e.g. shared from a previous deploy with a different status
// allowlist) should not blow up the page; it just resets the affected param.
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

function MembersSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-24 rounded bg-muted" />
        <CardDescription className="h-3 w-72 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <div className="h-10 w-64 rounded-md bg-muted" />
              <div className="h-10 w-32 rounded-md bg-muted" />
            </div>
            <div className="h-10 w-24 rounded-md bg-muted" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border py-3 last:border-0"
            >
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="flex gap-3">
                <div className="h-6 w-16 rounded bg-muted" />
                <div className="h-6 w-20 rounded bg-muted" />
                <div className="h-4 w-20 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface ErrorCardProps {
  title: string;
  body: string;
}

function ErrorCard({ title, body }: ErrorCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
    </Card>
  );
}

async function GroupBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let group: AdminGroup;
  try {
    group = await fetchAdminGroup(gameId, groupId);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load this group. The token gates every cross-game admin endpoint."
        />
      );
    }
    // Map the server's "admin request failed: group not found" message to a
    // Next.js 404 (the substring match is intentionally narrow; anything
    // else falls through to the inline empty state below). Mirrors the
    // game detail page's not-found handling.
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return (
      <ErrorCard
        title="Could not load group"
        body={err instanceof Error ? err.message : "unknown error fetching the group"}
      />
    );
  }

  return <GroupDetailHeader group={group} />;
}

function RolesSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-20 rounded bg-muted" />
        <CardDescription className="h-3 w-80 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border py-3 last:border-0"
            >
              <div className="h-4 w-1/4 rounded bg-muted" />
              <div className="flex gap-3">
                <div className="h-6 w-16 rounded bg-muted" />
                <div className="h-6 w-12 rounded bg-muted" />
                <div className="h-4 w-20 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

async function RolesBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let roles: AdminRole[];
  try {
    roles = await fetchAdminGroupRoles(gameId, groupId);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load roles."
        />
      );
    }
    // The roles fetch shares the 404-collapse contract with the group
    // fetch; when the group itself is missing, the parent <GroupBody>
    // already calls notFound(). Reaching here means a transient backend
    // error or a soft-deleted group raced with the page render.
    return (
      <ErrorCard
        title="Could not load roles"
        body={err instanceof Error ? err.message : "unknown error fetching roles"}
      />
    );
  }

  return <RolesTable roles={roles} gameId={gameId} groupId={groupId} />;
}

function PermissionsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-40 rounded bg-muted" />
        <CardDescription className="h-3 w-80 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="h-10 flex-1 rounded-md bg-muted" />
            <div className="h-10 w-32 rounded-md bg-muted" />
          </div>
          <div className="rounded-md border border-border">
            <div className="space-y-2 p-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="h-4 w-32 rounded bg-muted" />
                  <div className="flex flex-1 gap-2">
                    {[0, 1, 2, 3].map((j) => (
                      <div key={j} className="h-6 w-6 rounded bg-muted" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function AuditSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-24 rounded bg-muted" />
        <CardDescription className="h-3 w-72 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <div className="h-10 w-48 rounded-md bg-muted" />
              <div className="h-10 w-24 rounded-md bg-muted" />
            </div>
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-start gap-3 border-b border-border py-3 last:border-0"
            >
              <div className="mt-1 h-6 w-6 shrink-0 rounded-full bg-muted" />
              <div className="flex flex-1 flex-col gap-1">
                <div className="h-4 w-1/3 rounded bg-muted" />
                <div className="h-3 w-1/2 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

async function AuditBody({
  gameId,
  groupId,
  query,
}: {
  gameId: string;
  groupId: string;
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
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load the audit log."
        />
      );
    }
    // The audit fetch shares the 404-collapse contract with the group
    // fetch; when the group itself is missing, the parent <GroupBody>
    // already calls notFound(). Reaching here means a transient backend
    // error or a race against a soft-delete sweep.
    return (
      <ErrorCard
        title="Could not load audit log"
        body={err instanceof Error ? err.message : "unknown error fetching audit entries"}
      />
    );
  }

  return <AuditFeed page={page} query={query} />;
}

function RelationshipsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-32 rounded bg-muted" />
        <CardDescription className="h-3 w-80 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border py-3 last:border-0"
            >
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="flex gap-3">
                <div className="h-6 w-20 rounded bg-muted" />
                <div className="h-4 w-24 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

async function RelationshipsBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let relationships: AdminGroupRelationship[];
  try {
    relationships = await fetchAdminGroupRelationships(gameId, groupId);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load relationships."
        />
      );
    }
    // The relationships fetch shares the 404-collapse contract with the
    // group fetch; when the group itself is missing, the parent
    // <GroupBody> already calls notFound(). Reaching here means a
    // transient backend error.
    return (
      <ErrorCard
        title="Could not load relationships"
        body={err instanceof Error ? err.message : "unknown error fetching relationships"}
      />
    );
  }

  return <RelationshipsTable relationships={relationships} gameId={gameId} groupId={groupId} />;
}

function SubGroupsSkeleton() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="h-4 w-28 rounded bg-muted" />
          <CardDescription className="h-3 w-72 rounded bg-muted" />
        </CardHeader>
        <CardContent>
          <div className="h-16 rounded-md bg-muted" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="h-4 w-32 rounded bg-muted" />
          <CardDescription className="h-3 w-80 rounded bg-muted" />
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between border-b border-border py-3 last:border-0"
              >
                <div className="h-4 w-1/3 rounded bg-muted" />
                <div className="flex gap-3">
                  <div className="h-6 w-12 rounded bg-muted" />
                  <div className="h-4 w-16 rounded bg-muted" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

async function SubGroupsBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let group: AdminGroup;
  let children: AdminGroup[];
  try {
    // Parallel fetches: the parent breadcrumb needs the current group's
    // `parentGroupId` field while the children list needs the bare-array
    // children endpoint. Both fetches share the 60s revalidate cache used
    // by `<GroupBody>` above (the group fetch hits the cached value),
    // so the cost is one extra round trip for the children only.
    [group, children] = await Promise.all([
      fetchAdminGroup(gameId, groupId),
      fetchAdminGroupChildren(gameId, groupId),
    ]);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load sub-groups."
        />
      );
    }
    // The children fetch shares the 404-collapse contract with the group
    // fetch; when the group itself is missing, the parent <GroupBody>
    // already calls notFound(). Reaching here means a transient backend
    // error.
    return (
      <ErrorCard
        title="Could not load sub-groups"
        body={err instanceof Error ? err.message : "unknown error fetching sub-groups"}
      />
    );
  }

  return <SubGroupsTable group={group} childGroups={children} gameId={gameId} />;
}

async function PermissionsBody({ gameId, groupId }: { gameId: string; groupId: string }) {
  let roles: AdminRole[];
  let catalog: AdminPermissionDef[];
  try {
    // Parallel fetches: the matrix needs both rows (roles) and columns
    // (catalog keys). Either failing surfaces the same envelope; we only
    // distinguish `AdminDisabledError` for the operator-friendly hint.
    [roles, catalog] = await Promise.all([
      fetchAdminGroupRoles(gameId, groupId),
      fetchAdminGamePermissions(gameId),
    ]);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load the permissions matrix."
        />
      );
    }
    return (
      <ErrorCard
        title="Could not load permissions"
        body={err instanceof Error ? err.message : "unknown error fetching permissions"}
      />
    );
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
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load members."
        />
      );
    }
    // The members fetch can fail with the same not-found envelope as the
    // group fetch (the server enforces the same 404-collapse). When the
    // group itself is missing, the parent <GroupBody> already calls
    // notFound() above, so reaching here means a transient backend error.
    return (
      <ErrorCard
        title="Could not load members"
        body={err instanceof Error ? err.message : "unknown error fetching members"}
      />
    );
  }

  return <MembersTable data={page} query={query} gameId={gameId} groupId={groupId} />;
}

export default function GroupDetailPage({ params, searchParams }: GroupDetailPageProps) {
  const activeTab = parseActiveTab(searchParams);
  const query = parseQuery(searchParams);
  const auditQuery = parseAuditQuery(searchParams);
  // The Suspense `key` for the members panel is the serialized query so the
  // skeleton flashes when the operator changes a filter, sort, or page.
  // Without the key, React would reuse the previous Suspense boundary while
  // the server re-runs, leaving the old data on screen during the fetch.
  const membersKey = JSON.stringify(query);
  const auditKey = JSON.stringify(auditQuery);

  return (
    <>
      <Topbar
        title="Group detail"
        description={getTabDescription(activeTab)}
        actions={
          <Link
            href={`/games/${encodeURIComponent(params.gameId)}/groups`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            All groups
          </Link>
        }
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-6xl space-y-6">
          <Suspense fallback={<GroupHeaderSkeleton />}>
            <GroupBody gameId={params.gameId} groupId={params.groupId} />
          </Suspense>
          <GroupDetailTabs gameId={params.gameId} groupId={params.groupId} active={activeTab} />
          {activeTab === "roles" ? (
            <Suspense fallback={<RolesSkeleton />}>
              <RolesBody gameId={params.gameId} groupId={params.groupId} />
            </Suspense>
          ) : activeTab === "permissions" ? (
            <Suspense fallback={<PermissionsSkeleton />}>
              <PermissionsBody gameId={params.gameId} groupId={params.groupId} />
            </Suspense>
          ) : activeTab === "audit" ? (
            <Suspense key={auditKey} fallback={<AuditSkeleton />}>
              <AuditBody gameId={params.gameId} groupId={params.groupId} query={auditQuery} />
            </Suspense>
          ) : activeTab === "relationships" ? (
            <Suspense fallback={<RelationshipsSkeleton />}>
              <RelationshipsBody gameId={params.gameId} groupId={params.groupId} />
            </Suspense>
          ) : activeTab === "sub-groups" ? (
            <Suspense fallback={<SubGroupsSkeleton />}>
              <SubGroupsBody gameId={params.gameId} groupId={params.groupId} />
            </Suspense>
          ) : (
            <Suspense key={membersKey} fallback={<MembersSkeleton />}>
              <MembersBody gameId={params.gameId} groupId={params.groupId} query={query} />
            </Suspense>
          )}
        </div>
      </main>
    </>
  );
}

function GroupHeaderSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="h-12 w-12 rounded-md bg-muted" />
        <div className="flex flex-col gap-2">
          <div className="h-5 w-48 rounded bg-muted" />
          <div className="h-3 w-32 rounded bg-muted" />
          <div className="h-3 w-40 rounded bg-muted" />
        </div>
      </div>
      <div className="h-20 w-full rounded-md bg-muted sm:w-56" />
    </div>
  );
}
