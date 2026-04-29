// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ArrowRight, History } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useId } from "react";

import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_DEFAULT_PAGE_SIZE,
  ADMIN_AUDIT_PAGE_SIZE_OPTIONS,
  type AdminGroupAuditEntry,
  type AdminGroupAuditPage,
} from "../../lib/admin";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

const TIME_UNITS: Array<{ unit: Intl.RelativeTimeFormatUnit; ms: number }> = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
  { unit: "second", ms: 1000 },
];

// Mirrors `relativeTime` in `recent-activity-feed.tsx` byte-for-byte.
// Picks the largest unit that fits the elapsed delta so a single unit
// reads cleanly without a compound "1d 3h" form.
function relativeTime(iso: string, now = Date.now()): string {
  const then = new Date(iso).getTime();
  const deltaMs = then - now;
  const absMs = Math.abs(deltaMs);
  for (const { unit, ms } of TIME_UNITS) {
    if (absMs >= ms || unit === "second") {
      const value = Math.round(deltaMs / ms);
      return RELATIVE_FORMATTER.format(value, unit);
    }
  }
  return RELATIVE_FORMATTER.format(0, "second");
}

const absoluteFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

export interface AuditQueryState {
  actions: string[];
  before: string | undefined;
  limit: number;
}

interface AuditFeedProps {
  page: AdminGroupAuditPage;
  query: AuditQueryState;
}

interface AuditRowProps {
  entry: AdminGroupAuditEntry;
}

function AuditRow({ entry }: AuditRowProps) {
  const hasPayload = Object.keys(entry.payload).length > 0;
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <ArrowRight className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-sm font-medium">{entry.action}</span>
          <time
            dateTime={entry.createdAt}
            title={absoluteFormatter.format(new Date(entry.createdAt))}
            className="text-xs text-muted-foreground"
          >
            {relativeTime(entry.createdAt)}
          </time>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.actorUserId ? (
            <>
              actor <span className="font-mono">{entry.actorUserId}</span>
            </>
          ) : (
            <span>actor: system</span>
          )}
          {entry.targetId ? (
            <>
              {" · "}target <span className="font-mono">{entry.targetId}</span>
            </>
          ) : null}
        </p>
        {hasPayload ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
              payload
            </summary>
            <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-card/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
              {JSON.stringify(entry.payload, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

interface FeedShellProps {
  total: number | undefined;
  children: React.ReactNode;
}

function FeedShell({ total, children }: FeedShellProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>
          State changes recorded for this group, newest first.
          {total !== undefined
            ? ` ${total} ${total === 1 ? "entry" : "entries"} on this page.`
            : ""}
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function AuditFeed({ page, query }: AuditFeedProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const actionSelectId = useId();
  const pageSizeSelectId = useId();

  // Update URL state. Audit tab uses namespaced params (`auditActions`,
  // `auditBefore`, `auditLimit`) so they do not collide with the members
  // tab's `q` / `status` / `offset` / `limit` on the same route.
  // Switching tabs (via <GroupDetailTabs>) clears all query params so
  // the URL stays clean.
  const pushQuery = useCallback(
    (updates: Partial<AuditQueryState>) => {
      const merged: AuditQueryState = { ...query, ...updates };
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.delete("auditActions");
      next.delete("auditBefore");
      next.delete("auditLimit");
      for (const action of merged.actions) {
        if (action.length > 0) next.append("auditActions", action);
      }
      if (merged.before !== undefined && merged.before.length > 0) {
        next.set("auditBefore", merged.before);
      }
      if (merged.limit !== ADMIN_AUDIT_DEFAULT_PAGE_SIZE) {
        next.set("auditLimit", String(merged.limit));
      }
      // Preserve the active tab marker so a filter change does not bounce
      // the operator back to Members.
      next.set("tab", "audit");
      const target = next.toString();
      router.replace(target.length > 0 ? `${pathname}?${target}` : pathname, { scroll: false });
    },
    [pathname, query, router, searchParams],
  );

  // Single-select dropdown for the action filter. The wire format
  // supports multi-value via the `auditActions` URL param (operators can
  // hand-edit the URL); the dashboard surfaces the simpler one-or-none
  // shape that matches the members table's status filter precedent.
  // When the URL carries multiple actions, the select shows the first
  // entry; the URL itself preserves the full list for the wire request.
  const selectedAction: string = query.actions.length >= 1 ? (query.actions[0] ?? "") : "";

  const isFirstPage = query.before === undefined;

  return (
    <FeedShell total={page.items.length}>
      <div className="space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <label htmlFor={actionSelectId} className="sr-only">
              Filter by action
            </label>
            <select
              id={actionSelectId}
              value={selectedAction}
              onChange={(e) => {
                const next = e.target.value;
                pushQuery({
                  actions: next.length > 0 ? [next] : [],
                  // Reset cursor when the filter changes; the result set
                  // means something different now.
                  before: undefined,
                });
              }}
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 ring-offset-background",
              )}
            >
              <option value="">All actions</option>
              {ADMIN_AUDIT_ACTIONS.map((action) => (
                <option key={action} value={action}>
                  {action}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <label
                htmlFor={pageSizeSelectId}
                className="text-xs uppercase tracking-wide text-muted-foreground"
              >
                Rows
              </label>
              <select
                id={pageSizeSelectId}
                value={query.limit}
                onChange={(e) => {
                  const nextLimit = Number(e.target.value);
                  pushQuery({ limit: nextLimit, before: undefined });
                }}
                className={cn(
                  "h-10 rounded-md border border-input bg-background px-3 text-sm",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "focus-visible:ring-offset-2 ring-offset-background",
                )}
              >
                {ADMIN_AUDIT_PAGE_SIZE_OPTIONS.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {!isFirstPage ? (
            <button
              type="button"
              onClick={() => pushQuery({ before: undefined })}
              className={cn(
                "inline-flex items-center gap-1 rounded-md border border-input bg-background px-3 py-1.5 text-xs",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <History className="h-3 w-3" aria-hidden />
              Jump to newest
            </button>
          ) : null}
        </div>

        {page.items.length === 0 ? (
          <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
            <p className="text-sm font-medium">
              {selectedAction.length > 0
                ? `No ${selectedAction} entries`
                : isFirstPage
                  ? "No audit entries yet"
                  : "No more entries"}
            </p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              {selectedAction.length > 0
                ? "Clear the filter or pick a different action to widen the result set."
                : isFirstPage
                  ? "State changes in this group will appear here as soon as the audit log records them."
                  : "You have reached the end of the audit history for the current filter."}
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {page.items.map((entry) => (
              <AuditRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}

        <div className="flex flex-col items-start justify-between gap-3 border-t border-border pt-3 text-xs text-muted-foreground sm:flex-row sm:items-center">
          <span>
            {isFirstPage ? "Showing the newest page" : "Showing entries older than the cursor"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              // Browser back is the natural "go to the previous page"
              // gesture for cursor-based pagination - the server cannot
              // run the inverse query of `createdAt < before`, so the
              // dashboard relies on the URL history that pushQuery has
              // accumulated.
              onClick={() => router.back()}
              disabled={isFirstPage}
              className={cn(
                "inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => {
                if (page.nextCursor !== null) {
                  pushQuery({ before: page.nextCursor });
                }
              }}
              disabled={page.nextCursor === null}
              className={cn(
                "inline-flex items-center rounded-md border border-input bg-background px-3 py-1.5 text-xs",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </FeedShell>
  );
}
