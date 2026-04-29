// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
  GameAuditFeed,
  type GameAuditQueryState,
  resolveBefore,
  resolveSince,
} from "../../../../../components/dashboard/game-audit-feed";
import { Topbar } from "../../../../../components/dashboard/topbar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../../components/ui/card";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH,
  ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE,
  ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS,
  ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH,
  AdminDisabledError,
  type AdminGame,
  type AdminGameAuditPage,
  fetchAdminGame,
  fetchAdminGameAudit,
} from "../../../../../lib/admin";

interface AuditPageProps {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(props: AuditPageProps) {
  const params = await props.params;
  // Best-effort title; the page body itself shows a friendlier empty
  // state when the lookup fails. Mirrors the precedent in `[gameId]/page.tsx`.
  try {
    const game = await fetchAdminGame(params.gameId);
    return { title: `${game.name} audit | Junjo Dashboard` };
  } catch {
    return { title: "Audit | Junjo Dashboard" };
  }
}

// Lenient parser: invalid values fall through to defaults rather than
// 400ing. A stale URL (e.g. shared from a previous deploy with a
// different action enum) should not blow up the page; it just resets
// the affected param. Mirrors the GroupsTable / AuditFeed precedents.
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
): GameAuditQueryState {
  const rawAction = readParam(searchParams, "action") ?? "";
  const action: string =
    rawAction.length > 0 && (ADMIN_AUDIT_ACTIONS as readonly string[]).includes(rawAction)
      ? rawAction
      : "";

  const actor = (readParam(searchParams, "actor") ?? "")
    .trim()
    .slice(0, ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH);
  const target = (readParam(searchParams, "target") ?? "")
    .trim()
    .slice(0, ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH);

  // datetime-local values come through as `YYYY-MM-DDTHH:MM` (or empty).
  // We do not try to revalidate the format here because the
  // `<input type="datetime-local">` element is the upstream validator;
  // a malformed string just produces an undefined wire `before` /
  // `since` via `datetimeLocalToIso` and the server returns the full
  // (unfiltered) result.
  const since = readParam(searchParams, "since") ?? "";
  const endDate = readParam(searchParams, "end") ?? "";

  // Pagination cursor: ISO 8601 from the previous page's `nextCursor`.
  // No date-shape validation here either; a malformed cursor simply
  // produces a 400 from the server which the catch block surfaces.
  const cursorRaw = readParam(searchParams, "cursor") ?? "";
  const cursor = cursorRaw.length > 0 ? cursorRaw : undefined;

  const limitRaw = Number(readParam(searchParams, "limit"));
  const limit =
    Number.isFinite(limitRaw) && ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS.includes(Math.trunc(limitRaw))
      ? Math.trunc(limitRaw)
      : ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE;

  return { action, actor, target, since, endDate, cursor, limit };
}

function AuditFeedSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-24 rounded bg-muted" />
        <CardDescription className="h-3 w-72 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 rounded bg-muted" />
                <div className="h-10 w-full rounded bg-muted" />
              </div>
            ))}
          </div>
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <div className="h-3 w-16 rounded bg-muted" />
                <div className="h-10 w-full rounded bg-muted" />
              </div>
            ))}
          </div>
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="border-b border-border py-3 last:border-0">
              <div className="h-4 w-1/3 rounded bg-muted" />
              <div className="mt-2 h-3 w-1/2 rounded bg-muted" />
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

async function AuditBody({
  gameId,
  query,
}: {
  gameId: string;
  query: GameAuditQueryState;
}) {
  // Game-name fetch and audit-page fetch run in parallel via Promise.all.
  // The game fetch hits the same 60s revalidate cache the game detail
  // page populates, so it is effectively free. Single-fail handling:
  // if the game lookup throws not_found we 404; if either throws
  // AdminDisabledError we render the disabled empty state.
  let game: AdminGame;
  let page: AdminGameAuditPage;
  try {
    [game, page] = await Promise.all([
      fetchAdminGame(gameId),
      fetchAdminGameAudit(gameId, {
        limit: query.limit,
        before: resolveBefore(query.cursor, query.endDate),
        since: resolveSince(query.since),
        actions: query.action.length > 0 ? [query.action] : undefined,
        actorUserId: query.actor.length > 0 ? query.actor : undefined,
        targetId: query.target.length > 0 ? query.target : undefined,
      }),
    ]);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load the audit log. The token gates every cross-game admin endpoint."
        />
      );
    }
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return (
      <ErrorCard
        title="Could not load audit log"
        body={err instanceof Error ? err.message : "unknown error fetching audit entries"}
      />
    );
  }

  return <GameAuditFeed page={page} query={query} gameName={game.name} />;
}

export default async function GameAuditPage(props: AuditPageProps) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const query = parseQuery(searchParams);
  // The Suspense `key` is the serialized query so the skeleton flashes
  // when the operator changes a filter or page. Without the key React
  // would attempt to reuse the previous boundary while the server
  // re-runs, leaving stale data on screen during the fetch.
  const suspenseKey = JSON.stringify(query);

  return (
    <>
      <Topbar
        title="Audit log"
        description="Every state change recorded across this game's groups, with action / actor / target / date-range filters and CSV export."
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
        <div className="mx-auto max-w-screen-2xl">
          <Suspense key={suspenseKey} fallback={<AuditFeedSkeleton />}>
            <AuditBody gameId={params.gameId} query={query} />
          </Suspense>
        </div>
      </main>
    </>
  );
}
