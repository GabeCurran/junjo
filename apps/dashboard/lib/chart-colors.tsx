// @license All Rights Reserved (see apps/dashboard/LICENSE)
//
// Single source of truth for analytics chart colors and the shared
// custom tooltip. Every Tremor chart in `components/analytics/`
// imports from here so palette changes flow through with one edit.

import type { CustomTooltipProps } from "@tremor/react";

// Single-series charts (group churn bar, heatmap intensity ramp).
// `coral` is a Tailwind color we register in `tailwind.config.ts`;
// Tremor v3 maps this to `fill-coral-500` / `stroke-coral-500` etc.
// at render time, which is also why `coral` is in the safelist patterns.
export const CHART_BRAND_COLOR = "coral" as const;

// Coral-equivalent HSL for the heatmap component which interpolates
// opacity on a hand-rolled `hsl(<H S L> / <alpha>)` string. Mirrors
// `--primary` from `app/globals.css`.
export const CHART_BRAND_HSL = "0 88% 65%" as const;

// Multi-series palette: coral-anchored, warm-leaning. Avoids the
// rainbow look of Tremor's defaults (blue/violet/teal/emerald/pink)
// so the dashboard's coral brand stays dominant.
//
// Order matters: the first series in any chart's data gets `coral`,
// which lines up with the most-prominent / largest-by-default series.
export const CHART_MULTI_PALETTE = [
  "coral",
  "amber",
  "rose",
  "orange",
  "yellow",
  "stone",
] as const;

// Shared tooltip used by every Tremor chart in the dashboard. The key
// fixes vs Tremor's default tooltip:
//   - bg-card/95 (opaque enough to read text overtop chart fills)
//   - explicit border + shadow so the tooltip lifts off the chart
//   - color dot per series so the row maps back to the line / bar
//   - tabular-nums on values so multi-row tooltips align cleanly
//
// Uses Tremor's exported `CustomTooltipProps` type so the prop shape
// stays in sync if Tremor changes the contract in a minor version.
// Tremor sometimes sends payload entries whose `name` is undefined
// (Recharts internals); we coerce to string for the React key + label.
export function ChartTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-card/95 px-3 py-2 text-xs shadow-lg backdrop-blur">
      {label !== undefined && label !== null && label !== "" ? (
        <div className="mb-1 font-semibold text-foreground">{String(label)}</div>
      ) : null}
      <div className="flex flex-col gap-1">
        {payload.map((entry, idx) => {
          const name = entry.name === undefined ? `series ${idx + 1}` : String(entry.name);
          const rawValue = entry.value;
          const display = typeof rawValue === "number" ? rawValue.toLocaleString() : String(rawValue ?? "");
          return (
            <div key={`${name}-${idx}`} className="flex items-center gap-2 whitespace-nowrap">
              {entry.color ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                  aria-hidden
                />
              ) : null}
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">{display}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
