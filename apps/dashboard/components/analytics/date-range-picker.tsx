// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { Calendar } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { cn } from "../../lib/utils";

// Closed enum of preset windows plus the open-ended "custom" sentinel.
// Custom windows are expressed as a `from` / `to` ISO 8601 pair pushed
// to the URL alongside `range=custom`; presets compute their `from`
// from `now()` at render time on the page server. `range` always lives
// in the URL, `from` / `to` only when `range === "custom"`.
export const ANALYTICS_RANGE_PRESETS = ["24h", "7d", "30d", "90d", "custom"] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGE_PRESETS)[number];

export const ANALYTICS_DEFAULT_RANGE: AnalyticsRange = "7d";

// Each preset's window in milliseconds; the page server resolves `from = now -
// presetMs[range]` at fetch time. Custom carries no entry because its `from`
// comes from the URL. Exported so the page server can run the same
// resolution rule the picker advertises in its label.
export const ANALYTICS_RANGE_PRESET_MS: Record<Exclude<AnalyticsRange, "custom">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
};

const PRESET_LABELS: Record<AnalyticsRange, string> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  custom: "Custom",
};

// URL-friendly, lenient picker over the closed enum. Unknown values fall
// through to the default rather than 400'ing, so stale URL bookmarks
// keep working across deploys that change the enum.
export function parseAnalyticsRange(value: string | null | undefined): AnalyticsRange {
  if (typeof value !== "string") return ANALYTICS_DEFAULT_RANGE;
  return (ANALYTICS_RANGE_PRESETS as readonly string[]).includes(value)
    ? (value as AnalyticsRange)
    : ANALYTICS_DEFAULT_RANGE;
}

// Convert a `<input type="datetime-local">` value (`YYYY-MM-DDTHH:MM` in
// the browser's local timezone) to UTC ISO 8601. Empty input or
// unparseable strings return undefined so the page server omits the
// wire field. The audit feed uses the same boundary normalization.
export function datetimeLocalToIso(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return undefined;
  return new Date(stamp).toISOString();
}

// Reverse: render an ISO 8601 string into the `<input type="datetime-local">`
// format. Used to round-trip the URL `from` / `to` back into the form. The
// browser interprets the result as local time so the picker re-displays the
// same wall-clock value the operator saw before pushing the URL.
function isoToDatetimeLocal(iso: string | undefined): string {
  if (typeof iso !== "string" || iso.length === 0) return "";
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "";
  const d = new Date(stamp);
  // YYYY-MM-DDTHH:MM in local time; pad with zeros so the input accepts it.
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  const hh = d.getHours().toString().padStart(2, "0");
  const mi = d.getMinutes().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export interface AnalyticsRangeQueryState {
  range: AnalyticsRange;
  from: string | undefined;
  to: string | undefined;
}

interface DateRangePickerProps {
  query: AnalyticsRangeQueryState;
}

export function DateRangePicker({ query }: DateRangePickerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromId = useId();
  const toId = useId();

  // Local input state for the custom-range datetime fields. Controlled
  // inputs - the user may type for a few seconds before clicking Apply -
  // and we do not want to push an in-flight value to the URL.
  const [customFrom, setCustomFrom] = useState(() => isoToDatetimeLocal(query.from));
  const [customTo, setCustomTo] = useState(() => isoToDatetimeLocal(query.to));

  // Re-sync local state when the URL changes from outside the picker (e.g.
  // a router push from a sibling component, or a back/forward navigation).
  // The ref guards against the first effect run since the initial `useState`
  // already snapshotted from `query`.
  const lastSyncedQueryRef = useRef(query);
  useEffect(() => {
    if (lastSyncedQueryRef.current === query) return;
    lastSyncedQueryRef.current = query;
    setCustomFrom(isoToDatetimeLocal(query.from));
    setCustomTo(isoToDatetimeLocal(query.to));
  }, [query]);

  // Push a new URL with the supplied param overrides preserving every
  // other existing search param (e.g. a future `chart=` filter). Empty
  // / undefined values clear the param. `router.replace` over `push`
  // because changing the time window shouldn't pollute the back-stack
  // with intermediate states.
  const pushQuery = useCallback(
    (overrides: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined || value.length === 0) {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const qs = next.toString();
      router.replace(qs.length > 0 ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const onPresetChange = useCallback(
    (range: AnalyticsRange) => {
      // Selecting a preset clears `from` / `to`. Selecting `custom` keeps
      // any prior `from` / `to` so the operator's previously-applied window
      // is the seed value of the inputs - matches Stripe / Linear analytics
      // pickers' "remember the last custom range" behavior.
      pushQuery(range === "custom" ? { range } : { range, from: undefined, to: undefined });
    },
    [pushQuery],
  );

  const onApplyCustom = useCallback(() => {
    pushQuery({
      range: "custom",
      from: datetimeLocalToIso(customFrom),
      to: datetimeLocalToIso(customTo),
    });
  }, [customFrom, customTo, pushQuery]);

  const customSelected = query.range === "custom";

  return (
    <div className="flex flex-col gap-3">
      <fieldset className="m-0 inline-flex items-center gap-1 rounded-md border border-border bg-background p-1">
        <legend className="sr-only">Date range</legend>
        <Calendar className="ml-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden />
        {ANALYTICS_RANGE_PRESETS.map((preset) => {
          const active = query.range === preset;
          return (
            <label
              key={preset}
              className={cn(
                "cursor-pointer rounded-sm px-2.5 py-1 text-xs font-medium transition-colors",
                active
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <input
                type="radio"
                name="analytics-range"
                value={preset}
                checked={active}
                onChange={() => onPresetChange(preset)}
                className="sr-only"
              />
              {PRESET_LABELS[preset]}
            </label>
          );
        })}
      </fieldset>
      {customSelected ? (
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-background p-3">
          <div className="flex flex-col gap-1">
            <label htmlFor={fromId} className="text-xs text-muted-foreground">
              From
            </label>
            <input
              id={fromId}
              type="datetime-local"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor={toId} className="text-xs text-muted-foreground">
              To
            </label>
            <input
              id={toId}
              type="datetime-local"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            />
          </div>
          <button
            type="button"
            onClick={onApplyCustom}
            className="rounded-md border border-border bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Apply
          </button>
        </div>
      ) : null}
    </div>
  );
}
