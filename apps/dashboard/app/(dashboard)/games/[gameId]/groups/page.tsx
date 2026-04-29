// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
  type GroupsQueryState,
  GroupsTable,
} from "../../../../../components/dashboard/groups-table";
import { Topbar } from "../../../../../components/dashboard/topbar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../../components/ui/card";
import {
  ADMIN_GROUPS_DEFAULT_PAGE_SIZE,
  ADMIN_GROUPS_PAGE_SIZE_OPTIONS,
  ADMIN_GROUP_ORDERS,
  ADMIN_GROUP_SORTS,
  ADMIN_GROUP_VISIBILITIES,
  AdminDisabledError,
  type AdminGroupList,
  type AdminGroupOrder,
  type AdminGroupSort,
  type AdminGroupVisibility,
  fetchAdminGroupsForGame,
} from "../../../../../lib/admin";

export const metadata = {
  title: "Groups | Junjo Dashboard",
};

interface GroupsPageProps {
  params: { gameId: string };
  searchParams: Record<string, string | string[] | undefined>;
}

const SEARCH_LIMIT_MAX = 100;
const SEARCH_VALUE_MAX = 120;
const KIND_VALUE_MAX = 64;

// Lenient parser: invalid values fall through to defaults rather than 400.
// A stale URL (e.g. shared from a previous deploy with a different sort
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

function parseQuery(searchParams: Record<string, string | string[] | undefined>): GroupsQueryState {
  const rawQ = readParam(searchParams, "q") ?? "";
  const q = rawQ.trim().slice(0, SEARCH_VALUE_MAX);

  const rawKind = readParam(searchParams, "kind") ?? "";
  const kind = rawKind.trim().slice(0, KIND_VALUE_MAX);

  const rawVisibility = readParam(searchParams, "visibility") ?? "";
  const visibility: AdminGroupVisibility | "" =
    rawVisibility.length > 0 &&
    (ADMIN_GROUP_VISIBILITIES as readonly string[]).includes(rawVisibility)
      ? (rawVisibility as AdminGroupVisibility)
      : "";

  const rawSort = readParam(searchParams, "sort");
  const sort: AdminGroupSort =
    rawSort !== undefined && (ADMIN_GROUP_SORTS as readonly string[]).includes(rawSort)
      ? (rawSort as AdminGroupSort)
      : "createdAt";

  const rawOrder = readParam(searchParams, "order");
  const order: AdminGroupOrder =
    rawOrder !== undefined && (ADMIN_GROUP_ORDERS as readonly string[]).includes(rawOrder)
      ? (rawOrder as AdminGroupOrder)
      : "desc";

  const offsetRaw = Number(readParam(searchParams, "offset"));
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.trunc(offsetRaw) : 0;

  const limitRaw = Number(readParam(searchParams, "limit"));
  const limit =
    Number.isFinite(limitRaw) &&
    ADMIN_GROUPS_PAGE_SIZE_OPTIONS.includes(Math.trunc(limitRaw)) &&
    limitRaw <= SEARCH_LIMIT_MAX
      ? Math.trunc(limitRaw)
      : ADMIN_GROUPS_DEFAULT_PAGE_SIZE;

  return { q, kind, visibility, sort, order, offset, limit };
}

function GroupsBrowserSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-40 rounded bg-muted" />
        <CardDescription className="h-3 w-72 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <div className="h-10 w-64 rounded-md bg-muted" />
              <div className="h-10 w-40 rounded-md bg-muted" />
              <div className="h-10 w-40 rounded-md bg-muted" />
            </div>
            <div className="h-10 w-24 rounded-md bg-muted" />
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border py-3 last:border-0"
            >
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="flex gap-6">
                <div className="h-4 w-12 rounded bg-muted" />
                <div className="h-4 w-16 rounded bg-muted" />
                <div className="h-4 w-10 rounded bg-muted" />
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

async function GroupsBrowser({
  gameId,
  query,
}: {
  gameId: string;
  query: GroupsQueryState;
}) {
  let page: AdminGroupList;
  try {
    page = await fetchAdminGroupsForGame(gameId, {
      limit: query.limit,
      offset: query.offset,
      q: query.q.length > 0 ? query.q : undefined,
      kind: query.kind.length > 0 ? query.kind : undefined,
      visibility: query.visibility === "" ? undefined : query.visibility,
      sort: query.sort,
      order: query.order,
    });
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load groups. The token gates every cross-game admin endpoint."
        />
      );
    }
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return (
      <ErrorCard
        title="Could not load groups"
        body={err instanceof Error ? err.message : "unknown error fetching groups"}
      />
    );
  }

  // Drive the kind filter dropdown from the rows actually on the current
  // page. This is intentionally a best-effort signal (not the full set of
  // kinds in the game): operators see kinds as they encounter them, and the
  // free-text URL `kind` parameter still works for kinds not in the list.
  const kindOptions = Array.from(new Set(page.items.map((g) => g.kind))).sort();

  return <GroupsTable gameId={gameId} data={page} query={query} kindOptions={kindOptions} />;
}

export default function GroupsPage({ params, searchParams }: GroupsPageProps) {
  const query = parseQuery(searchParams);
  // The Suspense `key` is the serialized query so the skeleton flashes when
  // the operator changes a filter, sort, or page. Without the key the React
  // tree would attempt to reuse the previous Suspense boundary while the
  // server re-runs, leaving the old data on screen during the fetch.
  const suspenseKey = JSON.stringify(query);

  return (
    <>
      <Topbar
        title="Groups"
        description="Search, filter, and sort every group in this game."
        actions={
          <Link
            href={`/games/${encodeURIComponent(params.gameId)}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            Game detail
          </Link>
        }
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-6xl">
          <Suspense key={suspenseKey} fallback={<GroupsBrowserSkeleton />}>
            <GroupsBrowser gameId={params.gameId} query={query} />
          </Suspense>
        </div>
      </main>
    </>
  );
}
