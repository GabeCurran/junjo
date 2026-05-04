// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { DonutChart, Legend } from "@tremor/react";
import { PieChart } from "lucide-react";
import { useMemo } from "react";

import type { AdminRoleDistribution, AdminRoleSlice } from "../../lib/admin-shared";
import { CHART_MULTI_PALETTE, ChartTooltip } from "../../lib/chart-colors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface RoleDistributionChartProps {
  data: AdminRoleDistribution;
}

// Tremor's `<DonutChart>` reads one row per slice. We include the "Other"
// aggregate at the tail when the server's `otherCount > 0` so the donut
// shows the full population; rendering only the top-10 slices would make
// `totalAssignments` look wrong relative to the visible arc lengths.
const OTHER_LABEL = "Other";

interface DonutRow {
  // Slice label (the role name, or "Other" for the aggregate). The
  // `index` prop on `<DonutChart>` reads this.
  name: string;
  // Slice value. The `category` prop reads this.
  count: number;
}

// Slice palette comes from the shared chart-colors module so the donut
// shares the coral-anchored warm palette with every other Tremor chart
// on the analytics page. Tremor pins slice colors to category position;
// rotation kicks in if the game has more than 6 distinct roles.
const SLICE_COLORS = CHART_MULTI_PALETTE;

function buildRows(topRoles: AdminRoleSlice[], otherCount: number): DonutRow[] {
  const rows: DonutRow[] = topRoles.map((s) => ({ name: s.name, count: s.count }));
  if (otherCount > 0) rows.push({ name: OTHER_LABEL, count: otherCount });
  return rows;
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function RoleDistributionChart({ data }: RoleDistributionChartProps) {
  const rows = useMemo(() => buildRows(data.topRoles, data.otherCount), [data]);
  const colors = useMemo(
    () => rows.map((_, i) => SLICE_COLORS[i % SLICE_COLORS.length] ?? "coral"),
    [rows],
  );
  const sliceNames = useMemo(() => rows.map((r) => r.name), [rows]);
  const hasData = data.totalAssignments > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <PieChart className="h-4 w-4 text-secondary-foreground" aria-hidden />
        </div>
        <div className="flex-1 space-y-1.5">
          <CardTitle className="text-base">Role distribution</CardTitle>
          <CardDescription>
            Active-member role assignments aggregated by role name across every group in this game.
            Two groups that share a role name (e.g., "Officer") contribute to the same slice. Shows
            current state; not affected by the date range above.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Total assignments</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.totalAssignments)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Unique role names</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.uniqueRoleNames)}
            </p>
          </div>
        </div>

        {hasData ? (
          <div className="flex flex-col items-center gap-4">
            <DonutChart
              data={rows}
              category="count"
              index="name"
              colors={colors}
              valueFormatter={formatCount}
              variant="donut"
              showAnimation={false}
              customTooltip={ChartTooltip}
              className="h-60 w-60"
            />
            <Legend categories={sliceNames} colors={colors} className="justify-center" />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            No active members hold any role yet. Assign roles to members from the group detail page
            to start tracking distribution.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
