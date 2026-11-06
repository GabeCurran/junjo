// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { BarChart, Legend } from "@tremor/react";
import { useMemo } from "react";

import type { AdminPermissionUsage, AdminPermissionUsageItem } from "../../lib/admin-shared";
import { ChartTooltip } from "../../lib/chart-colors";
import { Section } from "../ui/section";
import { ChartEmpty } from "./analytics-empty-state";

interface PermissionUsageChartProps {
  data: AdminPermissionUsage;
}

// Tremor's `<BarChart layout="vertical">` reads one row per bar; the
// `index` prop is the per-row label (the permission key) and the
// `categories` prop names the value column. We render two stacked
// categories so each bar shows a role-grants segment and a member-
// overrides segment in the same color family. This makes the dominant
// driver per permission obvious at a glance without needing the
// tooltip.
const ROLE_GRANTS_KEY = "Role grants";
const MEMBER_OVERRIDES_KEY = "Member overrides";
const CATEGORIES = [ROLE_GRANTS_KEY, MEMBER_OVERRIDES_KEY];
// Coral leads (the dominant driver in most setups: role grants), with
// amber as the secondary stack segment for member overrides. "red" is
// used in place of "coral" because Tremor v3's color resolver only
// honors Tailwind default-palette names; see lib/chart-colors.tsx.
const COLORS = ["red", "amber"];

interface BarRow {
  permission: string;
  [ROLE_GRANTS_KEY]: number;
  [MEMBER_OVERRIDES_KEY]: number;
}

function buildRows(items: AdminPermissionUsageItem[]): BarRow[] {
  return items.map((item) => ({
    permission: item.permission,
    [ROLE_GRANTS_KEY]: item.roleGrants,
    [MEMBER_OVERRIDES_KEY]: item.memberOverrides,
  }));
}

function formatCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function PermissionUsageChart({ data }: PermissionUsageChartProps) {
  const rows = useMemo(() => buildRows(data.items), [data.items]);
  const hasData = data.totalCount > 0;
  // Up to 15 bars; ~28px per row + axis chrome leaves the chart roughly
  // 480px tall when full. The `h-` Tailwind utility is computed so the
  // chart shrinks naturally on smaller cohorts. Floor at 14rem to keep
  // the empty-state footprint visible without crushing the labels.
  const chartHeightClass = useMemo(() => {
    const rowsCount = Math.max(rows.length, 1);
    if (rowsCount <= 3) return "h-56";
    if (rowsCount <= 6) return "h-72";
    if (rowsCount <= 9) return "h-96";
    return "h-[32rem]";
  }, [rows.length]);

  return (
    <Section
      title="Most-used permissions"
      meta={`${formatCount(data.totalCount)} grants and overrides across ${formatCount(data.uniqueKeys)} keys, as of now`}
    >
      {hasData ? (
        <div className="flex flex-col gap-3">
          <Legend categories={CATEGORIES} colors={COLORS} className="justify-center" />
          <BarChart
            data={rows}
            index="permission"
            categories={CATEGORIES}
            colors={COLORS}
            valueFormatter={formatCount}
            // `layout="vertical"` flips Tremor's BarChart into a
            // horizontal-bar layout (long permission keys would be
            // unreadable rotated 90 degrees on a normal axis). Stacked
            // segments encode the role / override split per bar.
            layout="vertical"
            stack
            yAxisWidth={220}
            showLegend={false}
            allowDecimals={false}
            customTooltip={ChartTooltip}
            className={chartHeightClass}
          />
          {data.otherCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              Plus <span className="tabular-nums">{formatCount(data.otherCount)}</span> more outside
              the top 15.
            </p>
          ) : null}
        </div>
      ) : (
        <ChartEmpty>Role grants and member overrides fill this chart.</ChartEmpty>
      )}
    </Section>
  );
}
