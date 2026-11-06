// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { BarChart } from "@tremor/react";

import type { AdminGroupChurn } from "../../lib/admin-shared";
import { CHART_BRAND_COLOR, ChartTooltip } from "../../lib/chart-colors";
import { Section } from "../ui/section";
import { ChartEmpty } from "./analytics-empty-state";

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

// Y-axis ticks, tooltip values and the meta line: non-negative integer
// counts with thousands separators.
function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function GroupChurnChart({ data }: GroupChurnChartProps) {
  const rows = buildChartRows(data);
  const hasDepartures = data.totalDeparturesInWindow > 0;
  const hasGroups = data.totalGroupsInWindow > 0;

  const departures = data.totalDeparturesInWindow;
  const groups = data.totalGroupsInWindow;

  return (
    <Section
      title="Churn by tenure"
      meta={`${formatCount(departures)} ${departures === 1 ? "departure" : "departures"} from ${formatCount(groups)} ${groups === 1 ? "group" : "groups"} created in this range`}
    >
      {hasDepartures ? (
        <BarChart
          data={rows}
          index="bin"
          categories={[VALUE_KEY]}
          colors={[CHART_BRAND_COLOR]}
          customTooltip={ChartTooltip}
          valueFormatter={formatCount}
          yAxisWidth={48}
          showLegend={false}
          allowDecimals={false}
          className="h-72"
        />
      ) : (
        <ChartEmpty>
          {hasGroups
            ? "Members who leave or get kicked from these groups fill this chart."
            : "Groups created in this range, and the members who leave them, fill this chart."}
        </ChartEmpty>
      )}
    </Section>
  );
}
