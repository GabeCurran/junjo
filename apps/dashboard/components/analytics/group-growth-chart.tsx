// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Legend, LineChart } from "@tremor/react";
import { TrendingUp } from "lucide-react";
import { useMemo } from "react";

import type { AdminGroupGrowth, AdminGroupGrowthSeries } from "../../lib/admin-shared";
import { CHART_MULTI_PALETTE, ChartTooltip } from "../../lib/chart-colors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface GroupGrowthChartProps {
  data: AdminGroupGrowth;
}

// Tremor's <LineChart> wants one row per x-axis tick; each row carries
// the index column plus one numeric column per series. We pivot the
// server's per-series `data` arrays into per-bucket records the chart
// consumes and pre-format the bucket label so the x-axis prints a
// readable date / time instead of the raw ISO 8601 string.
//
// Tremor pins line colors to category position in the `categories` prop,
// so the categories array must stay in lockstep with the series order
// the server returned (top-N by end-count desc plus "All others" at the
// tail). Re-render is stable as long as the server keeps returning the
// same ranking.
const VALUE_KEY_PREFIX = "Series ";

interface ChartRow {
  bucket: string;
  [columnName: string]: string | number;
}

interface SeriesColumn {
  // Display name for the chart legend / tooltip. Disambiguated when two
  // groups share the same `name` server-side (rare; the dashboard guards
  // against it by suffixing the groupId-prefix).
  column: string;
  // Original wire row, kept for legend / tooltip rendering.
  source: AdminGroupGrowthSeries;
}

// Top-N max is 10; one extra slot covers the "All others" aggregate.
// The palette comes from the shared chart-colors module so coral
// branding stays consistent across charts. CHART_MULTI_PALETTE has 6
// entries; if a game has more series than that the rotation repeats.
const SERIES_COLORS = CHART_MULTI_PALETTE;

function deriveSeriesColumns(series: AdminGroupGrowthSeries[]): SeriesColumn[] {
  const used = new Set<string>();
  return series.map((s, idx) => {
    let column = s.name && s.name.length > 0 ? s.name : `${VALUE_KEY_PREFIX}${idx + 1}`;
    if (used.has(column)) {
      // Two groups with the same name (rare). Disambiguate via a short
      // groupId prefix so the chart legend stays unique.
      const suffix = s.groupId ? s.groupId.slice(0, 6) : String(idx + 1);
      column = `${column} (${suffix})`;
    }
    used.add(column);
    return { column, source: s };
  });
}

function buildRows(
  buckets: string[],
  columns: SeriesColumn[],
  formatBucket: (iso: string) => string,
): ChartRow[] {
  return buckets.map((bucket, i) => {
    const row: ChartRow = { bucket: formatBucket(bucket) };
    for (const col of columns) {
      row[col.column] = col.source.data[i] ?? 0;
    }
    return row;
  });
}

// Renders the bucket size as a human-readable cadence. Mirrors the
// server's `pickGrowthBucketSizeMs` ladder: <=1d is hourly, <=7d is
// 6-hourly, <=30d is daily, <=90d is 3-day, longer is weekly.
function describeBucketSize(bucketSizeMs: number): string {
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;
  if (bucketSizeMs === ONE_HOUR) return "hourly";
  if (bucketSizeMs === 6 * ONE_HOUR) return "6-hourly";
  if (bucketSizeMs === ONE_DAY) return "daily";
  if (bucketSizeMs === 3 * ONE_DAY) return "every 3 days";
  if (bucketSizeMs === 7 * ONE_DAY) return "weekly";
  // Forward-compat: print the raw count if the server's ladder ever
  // grows.
  const hours = Math.round(bucketSizeMs / ONE_HOUR);
  if (hours < 24) return `every ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(bucketSizeMs / ONE_DAY);
  return `every ${days} day${days === 1 ? "" : "s"}`;
}

function formatWindow(from: string, to: string): string {
  return `${formatShortDate(from)} - ${formatShortDate(to)}`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

// Picks a tick formatter that matches the bucket cadence. Hourly /
// 6-hourly buckets show time; daily and coarser only show the date.
// Falls back to a date-with-time short stamp so a custom server-side
// bucket size still renders something sensible.
function pickBucketFormatter(bucketSizeMs: number): (iso: string) => string {
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;
  if (bucketSizeMs >= ONE_DAY) {
    return (iso) => {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d);
    };
  }
  return (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      hour12: true,
    }).format(d);
  };
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function GroupGrowthChart({ data }: GroupGrowthChartProps) {
  const columns = useMemo(() => deriveSeriesColumns(data.series), [data.series]);
  const formatBucket = useMemo(() => pickBucketFormatter(data.bucketSizeMs), [data.bucketSizeMs]);
  const rows = useMemo(
    () => buildRows(data.buckets, columns, formatBucket),
    [data.buckets, columns, formatBucket],
  );
  const colors = useMemo(
    () => columns.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length] ?? "coral"),
    [columns],
  );
  const categoryNames = useMemo(() => columns.map((c) => c.column), [columns]);
  const hasSeries = columns.length > 0;
  const hasBuckets = data.buckets.length > 0;
  const cadence = describeBucketSize(data.bucketSizeMs);

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <TrendingUp className="h-4 w-4 text-secondary-foreground" aria-hidden />
        </div>
        <div className="flex-1 space-y-1.5">
          <CardTitle className="text-base">Group growth over time</CardTitle>
          <CardDescription>
            Cumulative active member counts at every bucket boundary. Top groups by current member
            count plus an "All others" aggregate when the game has more groups than the configured
            top-N.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Window</p>
            <p className="mt-1 font-medium text-foreground">{formatWindow(data.from, data.to)}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Cadence</p>
            <p className="mt-1 font-medium capitalize text-foreground">{cadence}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Series</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(columns.length)}
            </p>
          </div>
        </div>

        {hasSeries && hasBuckets ? (
          <div className="flex flex-col gap-3">
            <LineChart
              data={rows}
              index="bucket"
              categories={categoryNames}
              colors={colors}
              valueFormatter={formatCount}
              yAxisWidth={48}
              showLegend={false}
              customTooltip={ChartTooltip}
              allowDecimals={false}
              connectNulls
              // Wide windows produce 50+ buckets; show only the first and
              // last x-axis ticks to avoid crowding. Narrow windows keep
              // every label.
              startEndOnly={data.buckets.length > 12}
              className="h-80"
            />
            <Legend categories={categoryNames} colors={colors} className="justify-center" />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            {data.buckets.length === 0
              ? "No buckets generated for this window. Pick a wider range."
              : "No groups in this game yet. Create a group to start tracking growth."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
