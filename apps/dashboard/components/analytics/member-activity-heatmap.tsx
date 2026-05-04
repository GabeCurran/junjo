// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Activity } from "lucide-react";
import { useMemo } from "react";

import type { AdminMemberActivity } from "../../lib/admin-shared";
import { CHART_BRAND_HSL } from "../../lib/chart-colors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface MemberActivityHeatmapProps {
  data: AdminMemberActivity;
}

// Server returns `cells[dow][hour]` where `dow=0` is Sunday (matches
// Postgres `EXTRACT(DOW)` and JS `Date.getUTCDay()`). Day labels keep the
// Sun-first order to mirror the wire format verbatim; rotating to Mon-first
// would be one client-side change if operators ever ask, but Sun-first is
// the standard convention in audit dashboards.
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
// Pre-computed stable hour array (values 0-23). Used as iteration keys so
// React's reconciler does not see "index of generated array" as the key
// (which Biome flags via `noArrayIndexKey`); the value 0..23 is the
// stable identifier of the column.
const HOURS: ReadonlyArray<number> = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
];
// Show every third hour label across the top axis to keep the grid
// readable without overlapping; hover or focus on any cell still reveals
// its exact hour through the cell's `title` and `aria-label`.
const HOUR_LABEL_STRIDE = 3;

function describeWindow(data: AdminMemberActivity): string {
  if (data.from && data.to) return `From ${formatDate(data.from)} to ${formatDate(data.to)}`;
  if (data.from && !data.to) return `Since ${formatDate(data.from)}`;
  if (!data.from && data.to) return `Up to ${formatDate(data.to)}`;
  return "All-time";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(d);
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

interface PeakCell {
  dow: number;
  hour: number;
  count: number;
}

function pickPeak(cells: number[][]): PeakCell | null {
  let best: PeakCell | null = null;
  for (let d = 0; d < cells.length; d++) {
    const row = cells[d] ?? [];
    for (let h = 0; h < row.length; h++) {
      const count = row[h] ?? 0;
      if (count > 0 && (!best || count > best.count)) {
        best = { dow: d, hour: h, count };
      }
    }
  }
  return best;
}

function maxCellCount(cells: number[][]): number {
  let max = 0;
  for (const row of cells) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  return max;
}

// Square-root scaling on the count / max ratio so low-count cells stay
// distinguishable from empty cells. Linear scaling makes a single-event
// cell visually identical to a zero cell when the peak is in the
// thousands; sqrt amplifies the bottom of the range. The floor (0.08)
// keeps a sliver of color over the muted background so the operator
// knows a non-zero count exists; the ceiling (1.0) is full intensity at
// the peak cell.
function intensity(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const ratio = Math.min(Math.max(count / max, 0), 1);
  return 0.08 + 0.92 * Math.sqrt(ratio);
}

// Coral brand HSL (mirrors `--primary` in `app/globals.css`). The
// heatmap interpolates opacity on this hue / saturation / lightness
// anchor to produce its intensity ramp; sourcing from chart-colors
// means a brand re-tint flows through every chart at once.
const HEATMAP_HSL = CHART_BRAND_HSL;

function cellStyle(opacity: number): React.CSSProperties {
  if (opacity <= 0) return {};
  return { backgroundColor: `hsl(${HEATMAP_HSL} / ${opacity})` };
}

function describeCell(dow: number, hour: number, count: number): string {
  const day = DAY_LABELS[dow] ?? `Day ${dow}`;
  if (count === 0) return `${day} ${formatHour(hour)} UTC: no events`;
  if (count === 1) return `${day} ${formatHour(hour)} UTC: 1 event`;
  return `${day} ${formatHour(hour)} UTC: ${formatCount(count)} events`;
}

export function MemberActivityHeatmap({ data }: MemberActivityHeatmapProps) {
  const max = useMemo(() => maxCellCount(data.cells), [data.cells]);
  const peak = useMemo(() => pickPeak(data.cells), [data.cells]);
  const hasActivity = data.totalEvents > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <Activity className="h-4 w-4 text-secondary-foreground" aria-hidden />
        </div>
        <div className="flex-1 space-y-1.5">
          <CardTitle className="text-base">Member activity heatmap</CardTitle>
          <CardDescription>
            Audit-entry counts bucketed by UTC day-of-week and hour-of-day across every group in
            this game. Every action type contributes; entries from soft-deleted groups are included
            so prior activity stays visible after a group is removed.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Window</p>
            <p className="mt-1 font-medium text-foreground">{describeWindow(data)}</p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Total events</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.totalEvents)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Peak hour (UTC)</p>
            <p className="mt-1 font-medium text-foreground">
              {peak
                ? `${DAY_LABELS[peak.dow]} ${formatHour(peak.hour)} - ${formatCount(peak.count)}`
                : "-"}
            </p>
          </div>
        </div>

        {hasActivity ? (
          <div className="space-y-2">
            <HeatmapTable cells={data.cells} max={max} />
            <HeatmapLegend max={max} />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            No audit activity in this window. Pick a wider date range or wait for events to land.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface HeatmapTableProps {
  cells: number[][];
  max: number;
}

// Real `<table>` / `<thead>` / `<tbody>` / `<tr>` / `<th>` / `<td>`
// elements rather than ARIA-roled divs. Native semantics give screen
// readers a free table-navigation mode and Biome's `useSemanticElements`
// rule is happy with the markup. The outer `overflow-x-auto` + inner
// `min-w-[640px]` keeps the grid horizontally scrollable on narrow
// viewports without crushing the cell sizes.
function HeatmapTable({ cells, max }: HeatmapTableProps) {
  return (
    <div className="overflow-x-auto">
      <table
        className="min-w-[640px] border-separate border-spacing-px"
        aria-label="Member activity by day of week (rows) and hour of day in UTC (columns)"
      >
        <thead>
          <tr className="text-[10px] tabular-nums text-muted-foreground">
            <th className="w-12" scope="col" aria-hidden />
            {HOURS.map((h) => (
              <th key={h} scope="col" className="px-0.5 text-center font-normal" aria-hidden>
                {h % HOUR_LABEL_STRIDE === 0 ? formatHour(h) : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DAY_LABELS.map((label, d) => {
            const row = cells[d] ?? [];
            return (
              <tr key={label}>
                <th
                  scope="row"
                  className="pr-2 text-right text-[11px] font-normal text-muted-foreground"
                >
                  {label}
                </th>
                {HOURS.map((h) => {
                  const count = row[h] ?? 0;
                  const opacity = intensity(count, max);
                  const empty = opacity === 0;
                  return (
                    <td
                      key={h}
                      aria-label={describeCell(d, h, count)}
                      title={describeCell(d, h, count)}
                      className={
                        empty
                          ? "h-6 rounded-sm border border-border/40 bg-muted/30"
                          : "h-6 rounded-sm border border-border/40"
                      }
                      style={cellStyle(opacity)}
                    />
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface HeatmapLegendProps {
  max: number;
}

function HeatmapLegend({ max }: HeatmapLegendProps) {
  // Five steps from "less" to "more" matching the cell-intensity ramp.
  // The first step is the empty-cell muted color; the remaining four
  // step through intensity ratios that match `intensity(count, max)`
  // applied to the swatch.
  const steps = [
    { id: "step-0", ratio: 0 },
    { id: "step-25", ratio: 0.25 },
    { id: "step-50", ratio: 0.5 },
    { id: "step-75", ratio: 0.75 },
    { id: "step-100", ratio: 1 },
  ] as const;
  return (
    <div className="flex items-center justify-end gap-2 text-[11px] text-muted-foreground">
      <span>0</span>
      <div className="flex gap-0.5" aria-hidden>
        {steps.map((step) => {
          const opacity = step.ratio === 0 ? 0 : 0.08 + 0.92 * Math.sqrt(step.ratio);
          return (
            <div
              key={step.id}
              className={
                opacity === 0
                  ? "h-3 w-4 rounded-sm border border-border/40 bg-muted/30"
                  : "h-3 w-4 rounded-sm border border-border/40"
              }
              style={cellStyle(opacity)}
            />
          );
        })}
      </div>
      <span className="tabular-nums">{formatCount(max)}</span>
    </div>
  );
}
