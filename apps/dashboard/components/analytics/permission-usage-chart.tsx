// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { BarChart, Legend } from "@tremor/react";
import { ShieldCheck } from "lucide-react";
import { useMemo } from "react";

import type { AdminPermissionUsage, AdminPermissionUsageItem } from "../../lib/admin-shared";
import { ChartTooltip } from "../../lib/chart-colors";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

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
// amber as the secondary stack segment for member overrides. Same
// warm-leaning palette as the rest of the analytics charts.
const COLORS = ["coral", "amber"];

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
    <Card>
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-secondary">
          <ShieldCheck className="h-4 w-4 text-secondary-foreground" aria-hidden />
        </div>
        <div className="flex-1 space-y-1.5">
          <CardTitle className="text-base">Most-used permission keys</CardTitle>
          <CardDescription>
            Top-15 permission keys ranked by combined role grants plus member overrides. Overrides
            count regardless of member status because operator-authored config exists independently
            of member lifecycle. Shows current state; not affected by the date range above.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Total grants + overrides</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.totalCount)}
            </p>
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-3">
            <p className="text-muted-foreground">Unique keys</p>
            <p className="mt-1 font-medium tabular-nums text-foreground">
              {formatCount(data.uniqueKeys)}
            </p>
          </div>
        </div>

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
              yAxisWidth={180}
              showLegend={false}
              allowDecimals={false}
              customTooltip={ChartTooltip}
              className={chartHeightClass}
            />
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
            No permission keys are in use yet. Grant a permission to a role from the group detail
            page to start tracking usage.
          </div>
        )}

        {data.otherCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            Plus <span className="tabular-nums">{formatCount(data.otherCount)}</span> additional
            grants / overrides across permission keys outside the top-15.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
