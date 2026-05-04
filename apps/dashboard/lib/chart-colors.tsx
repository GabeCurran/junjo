// @license All Rights Reserved (see apps/dashboard/LICENSE)
//
// Single source of truth for analytics chart colors and the shared
// custom tooltip. Every Tremor chart in `components/analytics/`
// imports from here so palette changes flow through with one edit.

import type { CustomTooltipProps } from "@tremor/react";

// Single-series Tremor charts (group churn bar, donut "primary" slice).
// Tremor v3's color resolver only accepts the Tailwind default-palette
// color names (blue, red, rose, etc.) - custom Tailwind colors like
// our brand "coral" silently render as black/transparent SVG fills
// because Tremor's internal class-name map doesn't recognize them.
// "red" is the closest warm Tailwind default to our coral brand
// (#ef4444 vs #f76a6a); the slight tonal mismatch is an acceptable
// tradeoff vs forking Tremor or dropping to Recharts directly.
export const CHART_BRAND_COLOR = "red" as const;

// The heatmap is hand-rolled Tailwind, NOT Tremor. It builds its
// cell color via `hsl(<H S L> / <alpha>)` so it CAN use the exact
// brand coral. Mirrors `--primary` from `app/globals.css`.
export const CHART_BRAND_HSL = "0 88% 65%" as const;

// Multi-series palette: warm-leaning so charts read as one family
// instead of Tremor's default rainbow (blue/violet/teal/emerald/pink).
// Order matters: the first series gets the brand color (red), which
// is typically the most-prominent / largest-by-default series.
export const CHART_MULTI_PALETTE = [
  "red",
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
          const display =
            typeof rawValue === "number" ? rawValue.toLocaleString() : String(rawValue ?? "");
          // Recharts populates different fields per chart type:
          // - LineChart: stroke (line color)
          // - BarChart / DonutChart: fill (bar / arc color)
          // - Some Tremor variants forward `color` directly
          // Without the fallbacks the dot is missing for entire chart
          // types, breaking the legend-tooltip mapping.
          const swatch =
            (entry as { color?: string }).color ??
            (entry as { stroke?: string }).stroke ??
            (entry as { fill?: string }).fill;
          return (
            <div key={`${name}-${idx}`} className="flex items-center gap-2 whitespace-nowrap">
              {swatch ? (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: swatch }}
                  aria-hidden
                />
              ) : null}
              <span className="text-muted-foreground">{name}</span>
              <span className="ml-auto pl-3 font-medium tabular-nums text-foreground">
                {display}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
