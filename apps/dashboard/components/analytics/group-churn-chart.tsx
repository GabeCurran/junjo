// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { BarChart } from "@tremor/react";
import { ActivitySquare } from "lucide-react";

import type { AdminGroupChurn } from "../../lib/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface GroupChurnChartProps {
  data: AdminGroupChurn;
}

// Format the bin counts as Tremor's BarChart expects: one row per bin with
// the bin's `label` as the x-axis index and `Departures` as the value.
// Tremor's chart props pin a single category name across the whole series
// so the legend / tooltip refer to a single label rather than per-row
// computed names.
const VALUE_KEY = "Departures";

function buildChartRows(data: AdminGroupChurn) {
  return data.bins.map((bin) => ({
    bin: bin.label,
    [VALUE_KEY]: bin.count,
  }));
}

// Renders the wire `from` / `to` window as one of: a preset-style "last X"
// hint when only `from` is set (most common case from the date-range
// picker's preset rows), or an explicit "from X to Y" sentence when both
// bounds are set, or an "all-time" callout when both are omitted (only
// reachable today via hand-edited URLs; the picker always sends `from`).
function describeWindow(data: AdminGroupChurn): string {
  if (data.from && data.to) {
    return `From ${formatDate(data.from)} to ${formatDate(data.to)}`;
  }
  if (data.from && !data.to) {
    return `Since ${formatDate(data.from)}`;
  }
  if (!data.from && data.to) {
    return `Up to ${formatDate(data.to)}`;
  }
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

// Single-axis number formatter for the Y-axis ticks and tooltip values.
// Counts are always non-negative integers; rendering with thousands
// separators (e.g., "1,254") matches the home page's stat tiles.
function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function GroupChurnChart({ data }: GroupChurnChartProps) {
  const rows = buildChartRows(data);
  const hasDepartures = data.totalDeparturesInWindow > 0;
  const hasGroups = data.totalGroupsInWindow > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <ActivitySquare className="h-4 w-4 text-secondary-foreground" aria-hidden />
        </div>
        <div className="flex-1 space-y-1.5">
          <CardTitle className="text-base">Group churn distribution</CardTitle>
          <CardDescription>
            Tenure histogram of kicked + left members across groups created in the selected window.
            Bins are half-open; a tenure that lands exactly on a boundary goes into the higher bin.
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
            <p className="text-muted-foreground">Groups in window</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.totalGroupsInWindow)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Total departures</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.totalDeparturesInWindow)}
            </p>
          </div>
        </div>

        {hasDepartures ? (
          <BarChart
            data={rows}
            index="bin"
            categories={[VALUE_KEY]}
            colors={["blue"]}
            valueFormatter={formatCount}
            yAxisWidth={48}
            showLegend={false}
            allowDecimals={false}
            className="h-72"
          />
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            {hasGroups
              ? "No kicked or left members yet for groups created in this window. Pick a wider range or wait for activity."
              : "No groups were created in this window. Pick a wider range or check the games list to confirm activity."}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
