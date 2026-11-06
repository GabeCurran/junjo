// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { DonutChart, Legend } from "@tremor/react";
import { useMemo } from "react";

import type { AdminRoleDistribution, AdminRoleSlice } from "../../lib/admin-shared";
import { CHART_MULTI_PALETTE, ChartTooltip } from "../../lib/chart-colors";
import { Section } from "../ui/section";
import { ChartEmpty } from "./analytics-empty-state";

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

  const assignments = data.totalAssignments;

  return (
    <Section
      title="Roles held"
      meta={`${formatCount(assignments)} ${assignments === 1 ? "assignment" : "assignments"} across ${formatCount(data.uniqueRoleNames)} role names, as of now`}
    >
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
        <ChartEmpty>Roles given to active members fill this chart.</ChartEmpty>
      )}
    </Section>
  );
}
