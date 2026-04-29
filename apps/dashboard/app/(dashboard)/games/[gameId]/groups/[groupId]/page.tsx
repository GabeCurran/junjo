// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { GroupDetailHeader } from "../../../../../../components/dashboard/group-detail-header";
import {
  type MembersQueryState,
  MembersTable,
} from "../../../../../../components/dashboard/members-table";
import { Topbar } from "../../../../../../components/dashboard/topbar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../../../components/ui/card";
import {
  ADMIN_MEMBERS_DEFAULT_PAGE_SIZE,
  ADMIN_MEMBERS_PAGE_SIZE_OPTIONS,
  ADMIN_MEMBER_STATUS_FILTERS,
  AdminDisabledError,
  type AdminGroup,
  type AdminGroupMemberList,
  type AdminMemberStatusFilter,
  fetchAdminGroup,
  fetchAdminGroupMembers,
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

  return <MembersTable data={page} query={query} />;
}

export default function GroupDetailPage({ params, searchParams }: GroupDetailPageProps) {
  const query = parseQuery(searchParams);
  // The Suspense `key` for the members panel is the serialized query so the
  // skeleton flashes when the operator changes a filter, sort, or page.
  // Without the key, React would reuse the previous Suspense boundary while
  // the server re-runs, leaving the old data on screen during the fetch.
  const membersKey = JSON.stringify(query);

  return (
    <>
      <Topbar
        title="Group detail"
        description="Members in this group, with their assigned roles and lifecycle status."
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
          <Suspense key={membersKey} fallback={<MembersSkeleton />}>
            <MembersBody gameId={params.gameId} groupId={params.groupId} query={query} />
          </Suspense>
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
