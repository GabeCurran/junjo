// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { AnalyticsEmptyState } from "../../../../../components/analytics/analytics-empty-state";
import {
  ANALYTICS_DEFAULT_RANGE,
  ANALYTICS_RANGE_PRESETS,
  ANALYTICS_RANGE_PRESET_MS,
  type AnalyticsRange,
  type AnalyticsRangeQueryState,
  DateRangePicker,
  datetimeLocalToIso,
} from "../../../../../components/analytics/date-range-picker";
import { GroupChurnChart } from "../../../../../components/analytics/group-churn-chart";
import { Topbar } from "../../../../../components/dashboard/topbar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../../components/ui/card";
import {
  AdminDisabledError,
  type AdminGame,
  type AdminGroupChurn,
  fetchAdminGame,
  fetchAdminGameGroupChurn,
} from "../../../../../lib/admin";
import { getDocsBaseUrl } from "../../../../../lib/junjo";

interface AnalyticsPageProps {
  params: { gameId: string };
  searchParams: Record<string, string | string[] | undefined>;
}

export async function generateMetadata({ params }: AnalyticsPageProps) {
  // Best-effort title; the page body itself shows a friendlier empty
  // state when the lookup fails. Mirrors the precedent in `[gameId]/page.tsx`
  // and `[gameId]/audit/page.tsx`.
  try {
    const game = await fetchAdminGame(params.gameId);
    return { title: `${game.name} analytics | Junjo Dashboard` };
  } catch {
    return { title: "Analytics | Junjo Dashboard" };
  }
}

function readParam(
  searchParams: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const raw = searchParams[key];
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

// Lenient parser. Unknown `range` values fall through to the default rather
// than 400'ing; malformed `from` / `to` strings produce undefined wire
// values. A stale URL bookmark from a previous deploy that changed the
// preset enum should not blow up the page.
function parseQuery(
  searchParams: Record<string, string | string[] | undefined>,
): AnalyticsRangeQueryState {
  const rawRange = readParam(searchParams, "range");
  const range: AnalyticsRange =
    typeof rawRange === "string" &&
    (ANALYTICS_RANGE_PRESETS as readonly string[]).includes(rawRange)
      ? (rawRange as AnalyticsRange)
      : ANALYTICS_DEFAULT_RANGE;

  // `from` / `to` are only meaningful for `range === "custom"`. The picker
  // keeps them in the URL across preset switches as a "remember the last
  // custom range" affordance, so the parse preserves them regardless of
  // the selected preset.
  const from = readParam(searchParams, "from");
  const to = readParam(searchParams, "to");
  return {
    range,
    from: typeof from === "string" && from.length > 0 ? from : undefined,
    to: typeof to === "string" && to.length > 0 ? to : undefined,
  };
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

function AnalyticsBodySkeleton() {
  return (
    <Card className="border-dashed">
      <CardHeader>
        <CardTitle className="h-4 w-32 rounded bg-muted" />
        <CardDescription className="h-3 w-72 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="h-24 w-full rounded bg-muted/50" />
      </CardContent>
    </Card>
  );
}

async function AnalyticsBody({
  gameId,
  query,
}: {
  gameId: string;
  query: AnalyticsRangeQueryState;
}) {
  // Resolve the game once, so a missing / cross-game / soft-deleted id
  // 404s the page rather than rendering an empty shell pointed at a game
  // that does not exist. The `fetchAdminGame` call hits the same 60s
  // revalidate cache the game detail page populates, so it is effectively
  // free. Pair it with the churn fetch via `Promise.all` so the slower
  // network leg dominates instead of the sum of both.
  const fromIso = resolveRangeFrom(query);
  const toIso = resolveRangeTo(query);

  let game: AdminGame;
  let churn: AdminGroupChurn;
  try {
    [game, churn] = await Promise.all([
      fetchAdminGame(gameId),
      fetchAdminGameGroupChurn(gameId, { from: fromIso, to: toIso }),
    ]);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load analytics. The token gates every cross-game admin endpoint."
        />
      );
    }
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return (
      <ErrorCard
        title="Could not load analytics"
        body={err instanceof Error ? err.message : "unknown error fetching analytics"}
      />
    );
  }

  // The chart renders unconditionally now (Phase 12.2b). The chart owns
  // its own empty-state copy when the window has zero matching groups or
  // zero departures; the page-level `<AnalyticsEmptyState>` only renders
  // when the operator has not configured `JUNJO_DOCS_BASE_URL` AND the
  // chart has nothing to show, which is the early-onboarding case where
  // the tutorial deep-link is the most useful next step. Charts 12.3 -
  // 12.5 will land alongside the churn chart in subsequent iterations.
  const docsBaseUrl = getDocsBaseUrl();
  const showOnboardingHint =
    docsBaseUrl !== null && churn.totalDeparturesInWindow === 0 && churn.totalGroupsInWindow === 0;
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Game <span className="font-mono">{game.name}</span> -{" "}
        <span className="font-mono text-[11px]">{game.id}</span>
      </p>
      <GroupChurnChart data={churn} />
      {showOnboardingHint ? <AnalyticsEmptyState docsBaseUrl={docsBaseUrl} /> : null}
    </div>
  );
}

export default function GameAnalyticsPage({ params, searchParams }: AnalyticsPageProps) {
  const query = parseQuery(searchParams);

  // Suspense `key` is the serialized query so the skeleton flashes when
  // the operator changes the date range. Without the key React would
  // attempt to reuse the previous boundary while the server re-runs,
  // leaving stale data on screen during the fetch.
  const suspenseKey = JSON.stringify(query);

  return (
    <>
      <Topbar
        title="Analytics"
        description="Group churn, growth over time, member activity, and role / permission distributions."
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
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <DateRangePicker query={query} />
          <Suspense key={suspenseKey} fallback={<AnalyticsBodySkeleton />}>
            <AnalyticsBody gameId={params.gameId} query={query} />
          </Suspense>
        </div>
      </main>
    </>
  );
}

// Resolve the `from` end of the date window for fetch helpers. For preset
// ranges, this is `now() - ANALYTICS_RANGE_PRESET_MS[range]`; for custom,
// it is `query.from` parsed back to ISO 8601. Returns undefined when the
// input is unparseable (only possible for custom). Phase 12.2 will
// consume this for per-chart fetches.
export function resolveRangeFrom(query: AnalyticsRangeQueryState): string | undefined {
  if (query.range === "custom") {
    return query.from && query.from.length > 0
      ? (datetimeLocalToIso(query.from) ?? query.from)
      : undefined;
  }
  return new Date(Date.now() - ANALYTICS_RANGE_PRESET_MS[query.range]).toISOString();
}

// Resolve the `to` end. Custom ranges may carry a `to`; presets always
// resolve to "now" (the current request time on the server). Returns
// undefined when no upper bound is meaningful, in which case fetchers
// should omit the wire field.
export function resolveRangeTo(query: AnalyticsRangeQueryState): string | undefined {
  if (query.range !== "custom") return undefined;
  return query.to && query.to.length > 0 ? (datetimeLocalToIso(query.to) ?? query.to) : undefined;
}
