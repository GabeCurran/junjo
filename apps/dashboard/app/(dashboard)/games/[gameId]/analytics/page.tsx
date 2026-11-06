// @license All Rights Reserved (see apps/dashboard/LICENSE)
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
import { GroupGrowthChart } from "../../../../../components/analytics/group-growth-chart";
import { MemberActivityHeatmap } from "../../../../../components/analytics/member-activity-heatmap";
import { PermissionUsageChart } from "../../../../../components/analytics/permission-usage-chart";
import { RoleDistributionChart } from "../../../../../components/analytics/role-distribution-chart";
import { PageHeader } from "../../../../../components/dashboard/page-header";
import { Notice } from "../../../../../components/ui/section";
import {
  AdminDisabledError,
  type AdminGroupChurn,
  type AdminGroupGrowth,
  type AdminMemberActivity,
  type AdminPermissionUsage,
  type AdminRoleDistribution,
  fetchAdminGame,
  fetchAdminGameGroupChurn,
  fetchAdminGameGroupGrowth,
  fetchAdminGameMemberActivity,
  fetchAdminGamePermissionUsage,
  fetchAdminGameRoleDistribution,
} from "../../../../../lib/admin";
import { getDocsBaseUrl } from "../../../../../lib/junjo";

interface AnalyticsPageProps {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(props: AnalyticsPageProps) {
  const params = await props.params;
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

function AnalyticsBodySkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex flex-col gap-3">
          <div className="h-5 w-40 rounded bg-muted" />
          <div className="h-64 w-full rounded bg-muted/50" />
        </div>
      ))}
    </div>
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
  // that does not exist. The game layout makes the same `fetchAdminGame`
  // request in this render, so Next deduplicates it into one. Pair it
  // with the churn fetch via `Promise.all` so the slower network leg
  // dominates instead of the sum of both.
  const fromIso = resolveRangeFrom(query);
  const toIso = resolveRangeTo(query);

  let churn: AdminGroupChurn;
  let growth: AdminGroupGrowth;
  let memberActivity: AdminMemberActivity;
  let roleDistribution: AdminRoleDistribution;
  let permissionUsage: AdminPermissionUsage;
  try {
    // Six independent fetches in parallel: the game lookup is shared
    // with the game layout's identical request in this render. The 12.5
    // charts (role distribution + permission usage) ignore `fromIso` /
    // `toIso` deliberately - they answer "what is currently deployed?"
    // not "what changed in this window?" Their meta lines say "as of
    // now" so the snapshot semantics stay visible when the range changes.
    [, churn, growth, memberActivity, roleDistribution, permissionUsage] = await Promise.all([
      fetchAdminGame(gameId),
      fetchAdminGameGroupChurn(gameId, { from: fromIso, to: toIso }),
      fetchAdminGameGroupGrowth(gameId, { from: fromIso, to: toIso }),
      fetchAdminGameMemberActivity(gameId, { from: fromIso, to: toIso }),
      fetchAdminGameRoleDistribution(gameId),
      fetchAdminGamePermissionUsage(gameId),
    ]);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <Notice
          title="Cross-game access is off"
          body="Set JUNJO_ADMIN_TOKEN on the dashboard and the server to load analytics."
        />
      );
    }
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return (
      <Notice
        title="Could not load analytics"
        body={
          err instanceof Error ? err.message : "An analytics request failed. Reload to try again."
        }
      />
    );
  }

  // The charts each render their own per-state empty copy when the
  // window has nothing to show. The page-level `<AnalyticsEmptyState>`
  // only fires when the operator has configured `JUNJO_DOCS_BASE_URL`
  // AND the dashboard truly has no data anywhere in the cohort - the
  // first-time-user onboarding path where the tutorial deep-link is the
  // most useful next step. All five chart datasets are checked because
  // any one counts as "this game already has activity": a brand-new
  // game has no groups (churn population zero), no growth series, no
  // audit entries in the window, no role assignments, and no permission
  // grants / overrides; the moment any one of those flips non-zero the
  // operator is past onboarding and the tutorial deep-link becomes
  // noise. Role distribution + permission usage are snapshot endpoints
  // and ignore the date range, so they correctly track "is this game
  // configured at all?" regardless of the picker.
  const docsBaseUrl = getDocsBaseUrl();
  const showOnboardingHint =
    docsBaseUrl !== null &&
    churn.totalDeparturesInWindow === 0 &&
    churn.totalGroupsInWindow === 0 &&
    growth.series.length === 0 &&
    memberActivity.totalEvents === 0 &&
    roleDistribution.totalAssignments === 0 &&
    permissionUsage.totalCount === 0;
  return (
    <div className="flex flex-col gap-10">
      {showOnboardingHint ? <AnalyticsEmptyState docsBaseUrl={docsBaseUrl} /> : null}
      <GroupChurnChart data={churn} />
      <GroupGrowthChart data={growth} />
      <MemberActivityHeatmap data={memberActivity} />
      {/* Role distribution + permission usage sit side-by-side at the
          bottom of the surface. On narrow viewports they stack via the
          responsive grid (single column below `lg`, two columns at lg+). */}
      <div className="grid grid-cols-1 gap-10 lg:grid-cols-2">
        <RoleDistributionChart data={roleDistribution} />
        <PermissionUsageChart data={permissionUsage} />
      </div>
    </div>
  );
}

export default async function GameAnalyticsPage(props: AnalyticsPageProps) {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const query = parseQuery(searchParams);

  // Suspense `key` is the serialized query so the skeleton flashes when
  // the operator changes the date range. Without the key React would
  // attempt to reuse the previous boundary while the server re-runs,
  // leaving stale data on screen during the fetch.
  const suspenseKey = JSON.stringify(query);

  return (
    <>
      <PageHeader title="Analytics" />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-screen-2xl flex-col gap-8">
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
// input is unparseable (only possible for custom).
export function resolveRangeFrom(query: AnalyticsRangeQueryState): string | undefined {
  if (query.range === "custom") {
    return query.from && query.from.length > 0
      ? (datetimeLocalToIso(query.from) ?? query.from)
      : undefined;
  }
  // Defensive: an unknown preset (e.g., a stale URL bookmark across a
  // schema change) would yield undefined here and crash toISOString
  // with "Invalid time value". Fall back to a hard-coded 7d in ms so
  // even a broken import of ANALYTICS_RANGE_PRESET_MS can't crash the
  // page render.
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const looked = ANALYTICS_RANGE_PRESET_MS?.[query.range];
  const presetMs = typeof looked === "number" && Number.isFinite(looked) ? looked : SEVEN_DAYS_MS;
  return new Date(Date.now() - presetMs).toISOString();
}

// Resolve the `to` end. Custom ranges may carry a `to`; presets always
// resolve to "now" (the current request time on the server). Returns
// undefined when no upper bound is meaningful, in which case fetchers
// should omit the wire field.
export function resolveRangeTo(query: AnalyticsRangeQueryState): string | undefined {
  if (query.range !== "custom") return undefined;
  return query.to && query.to.length > 0 ? (datetimeLocalToIso(query.to) ?? query.to) : undefined;
}
