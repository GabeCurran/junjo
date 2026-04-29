// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ArrowRight, Download, History } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH,
  ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE,
  ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS,
  ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH,
  type AdminAuditEntry,
  type AdminGameAuditPage,
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

// URL-state shape. The audit page lives on its own route (no sibling tabs
// fight for the query bag), so the param names are unprefixed. `cursor`
// is the pagination cursor (server `before`) and `endDate` is the
// user-supplied date-range upper bound; the wire request uses
// `cursor ?? endDate` so a paginated walk overrides the user's filter
// only while paging is active. Changing any filter resets the cursor.
export interface GameAuditQueryState {
  action: string;
  actor: string;
  target: string;
  since: string;
  endDate: string;
  cursor: string | undefined;
  limit: number;
}

interface GameAuditFeedProps {
  page: AdminGameAuditPage;
  query: GameAuditQueryState;
  gameName: string;
}

interface AuditRowProps {
  entry: AdminAuditEntry;
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
          <span className="text-xs text-muted-foreground">in</span>
          <span className="truncate text-sm">
            <span
              className={cn(
                "font-medium",
                entry.groupSoftDeleted ? "line-through text-muted-foreground" : undefined,
              )}
            >
              {entry.groupName}
            </span>
          </span>
          {entry.groupSoftDeleted ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              soft-deleted
            </span>
          ) : null}
          <time
            dateTime={entry.createdAt}
            title={absoluteFormatter.format(new Date(entry.createdAt))}
            className="ml-auto text-xs text-muted-foreground"
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
              {" "}
              - target <span className="font-mono">{entry.targetId}</span>
            </>
          ) : null}{" "}
          - group <span className="font-mono">{entry.groupId}</span>
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
  total: number;
  children: React.ReactNode;
}

function FeedShell({ total, children }: FeedShellProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Audit log</CardTitle>
        <CardDescription>
          State changes recorded for every group in this game, newest first. Soft-deleted groups
          stay in the history. {total} {total === 1 ? "entry" : "entries"} on this page.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// Convert a `datetime-local` input value (e.g. "2026-04-01T12:30") to the
// ISO 8601 form the server expects. The browser parses datetime-local in
// the user's local timezone; rendering through `new Date()` then calling
// `.toISOString()` produces the canonical UTC form.
function datetimeLocalToIso(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

// RFC 4180 escape: wrap fields containing commas, quotes, or newlines in
// double quotes; double up internal quotes. Used by the CSV export.
function escapeCsvField(value: string): string {
  if (/[,"\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

const CSV_HEADERS = [
  "createdAt",
  "action",
  "gameId",
  "gameName",
  "groupId",
  "groupName",
  "groupSoftDeleted",
  "actorUserId",
  "targetId",
  "payload",
];

function buildCsv(entries: readonly AdminAuditEntry[]): string {
  const lines: string[] = [CSV_HEADERS.join(",")];
  for (const entry of entries) {
    lines.push(
      [
        entry.createdAt,
        entry.action,
        entry.gameId,
        entry.gameName,
        entry.groupId,
        entry.groupName,
        String(entry.groupSoftDeleted),
        entry.actorUserId ?? "",
        entry.targetId ?? "",
        JSON.stringify(entry.payload),
      ]
        .map(escapeCsvField)
        .join(","),
    );
  }
  return lines.join("\n");
}

function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function GameAuditFeed({ page, query, gameName }: GameAuditFeedProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const actionSelectId = useId();
  const actorInputId = useId();
  const targetInputId = useId();
  const sinceInputId = useId();
  const endInputId = useId();
  const pageSizeSelectId = useId();

  // Local mirrors for debounced text inputs. The text inputs (actor /
  // target) push to URL after a 350ms debounce; date inputs and the
  // action select push immediately because the operator's gesture is
  // discrete (click to choose).
  const [actorValue, setActorValue] = useState(query.actor);
  const [targetValue, setTargetValue] = useState(query.target);
  const skipFirstActorRef = useRef(true);
  const skipFirstTargetRef = useRef(true);

  // Push helper. Builds the next URL from the current query merged with
  // the supplied updates and replaces history (no scroll-jump). The
  // pattern mirrors the GroupsTable / AuditFeed precedents - filter
  // tweaks should not pollute the back-stack.
  const pushQuery = useCallback(
    (updates: Partial<GameAuditQueryState>) => {
      const merged: GameAuditQueryState = { ...query, ...updates };
      const next = new URLSearchParams(searchParams?.toString() ?? "");
      next.delete("action");
      next.delete("actor");
      next.delete("target");
      next.delete("since");
      next.delete("end");
      next.delete("cursor");
      next.delete("limit");
      if (merged.action.length > 0) next.set("action", merged.action);
      if (merged.actor.length > 0) next.set("actor", merged.actor);
      if (merged.target.length > 0) next.set("target", merged.target);
      if (merged.since.length > 0) next.set("since", merged.since);
      if (merged.endDate.length > 0) next.set("end", merged.endDate);
      if (merged.cursor !== undefined && merged.cursor.length > 0) {
        next.set("cursor", merged.cursor);
      }
      if (merged.limit !== ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE) {
        next.set("limit", String(merged.limit));
      }
      const target = next.toString();
      router.replace(target.length > 0 ? `${pathname}?${target}` : pathname, { scroll: false });
    },
    [pathname, query, router, searchParams],
  );

  // Actor debounce. The skip-first guard suppresses the mount-time push
  // (which would otherwise bounce on every render). The equality check
  // suppresses no-op pushes when the user types and then erases back to
  // the URL value.
  useEffect(() => {
    if (skipFirstActorRef.current) {
      skipFirstActorRef.current = false;
      return;
    }
    if (actorValue === query.actor) return;
    const id = setTimeout(() => {
      pushQuery({ actor: actorValue, cursor: undefined });
    }, 350);
    return () => clearTimeout(id);
  }, [actorValue, pushQuery, query.actor]);

  useEffect(() => {
    if (skipFirstTargetRef.current) {
      skipFirstTargetRef.current = false;
      return;
    }
    if (targetValue === query.target) return;
    const id = setTimeout(() => {
      pushQuery({ target: targetValue, cursor: undefined });
    }, 350);
    return () => clearTimeout(id);
  }, [targetValue, pushQuery, query.target]);

  const isFirstPage = query.cursor === undefined;
  const csvFilenameSafeName = gameName.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 60);
  // CSV export is intentionally per-page (the operator sees what they
  // get on screen). Multi-page export would need to walk every page on
  // the client which can race with concurrent writes; the user-visible
  // semantics of "what's on screen now" beat the multi-page version's
  // ambiguity.
  const onExport = () => {
    if (page.items.length === 0) return;
    const csv = buildCsv(page.items);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadCsv(csv, `${csvFilenameSafeName || "game"}-audit-${stamp}.csv`);
  };

  return (
    <FeedShell total={page.items.length}>
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={actionSelectId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Action
            </label>
            <select
              id={actionSelectId}
              value={query.action}
              onChange={(e) => pushQuery({ action: e.target.value, cursor: undefined })}
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
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={actorInputId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Actor user id
            </label>
            <input
              id={actorInputId}
              type="text"
              value={actorValue}
              onChange={(e) => setActorValue(e.target.value)}
              maxLength={ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH}
              placeholder="paste from a row"
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 ring-offset-background",
                "placeholder:text-muted-foreground",
              )}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={targetInputId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Target id
            </label>
            <input
              id={targetInputId}
              type="text"
              value={targetValue}
              onChange={(e) => setTargetValue(e.target.value)}
              maxLength={ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH}
              placeholder="paste from a row"
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 ring-offset-background",
                "placeholder:text-muted-foreground",
              )}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={pageSizeSelectId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              Rows per page
            </label>
            <select
              id={pageSizeSelectId}
              value={query.limit}
              onChange={(e) => {
                const nextLimit = Number(e.target.value);
                pushQuery({ limit: nextLimit, cursor: undefined });
              }}
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 ring-offset-background",
              )}
            >
              {ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div className="flex flex-col gap-1">
            <label
              htmlFor={sinceInputId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              From (inclusive)
            </label>
            <input
              id={sinceInputId}
              type="datetime-local"
              value={query.since}
              onChange={(e) => pushQuery({ since: e.target.value, cursor: undefined })}
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 ring-offset-background",
              )}
            />
          </div>

          <div className="flex flex-col gap-1">
            <label
              htmlFor={endInputId}
              className="text-xs uppercase tracking-wide text-muted-foreground"
            >
              To (exclusive)
            </label>
            <input
              id={endInputId}
              type="datetime-local"
              value={query.endDate}
              onChange={(e) => pushQuery({ endDate: e.target.value, cursor: undefined })}
              className={cn(
                "h-10 rounded-md border border-input bg-background px-3 text-sm",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "focus-visible:ring-offset-2 ring-offset-background",
              )}
            />
          </div>

          <div className="flex items-end gap-2 lg:col-span-2 lg:justify-end">
            {!isFirstPage ? (
              <button
                type="button"
                onClick={() => pushQuery({ cursor: undefined })}
                className={cn(
                  "inline-flex h-10 items-center gap-1 rounded-md border border-input bg-background px-3 text-xs",
                  "transition-colors hover:bg-accent hover:text-accent-foreground",
                )}
              >
                <History className="h-3 w-3" aria-hidden />
                Jump to newest
              </button>
            ) : null}
            <button
              type="button"
              onClick={onExport}
              disabled={page.items.length === 0}
              className={cn(
                "inline-flex h-10 items-center gap-1 rounded-md border border-input bg-background px-3 text-xs",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
                "disabled:pointer-events-none disabled:opacity-50",
              )}
              title="Export the entries on this page as CSV"
            >
              <Download className="h-3 w-3" aria-hidden />
              Export CSV
            </button>
          </div>
        </div>

        {page.items.length === 0 ? (
          <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
            <p className="text-sm font-medium">
              {query.action.length > 0 ||
              query.actor.length > 0 ||
              query.target.length > 0 ||
              query.since.length > 0 ||
              query.endDate.length > 0
                ? "No entries match the current filters"
                : isFirstPage
                  ? "No audit entries yet"
                  : "No more entries"}
            </p>
            <p className="mt-1 max-w-md text-xs text-muted-foreground">
              {query.action.length > 0 ||
              query.actor.length > 0 ||
              query.target.length > 0 ||
              query.since.length > 0 ||
              query.endDate.length > 0
                ? "Widen the filters or clear them to see other entries."
                : isFirstPage
                  ? "State changes in any group on this game will appear here as soon as they happen."
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
            {isFirstPage
              ? "Showing the newest page that matches the filters"
              : "Showing entries older than the cursor"}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              // Browser back is the natural "previous page" gesture for
              // cursor-based pagination - the server cannot run the
              // inverse of `createdAt < before`, so the dashboard relies
              // on the URL history that pushQuery has accumulated.
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
                  pushQuery({ cursor: page.nextCursor });
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

// Exported so the page-level Server Component can call the same function
// to derive the wire `before` value from the user's `endDate` filter and
// pagination `cursor`. Keeps the conflict-resolution rule in one place.
export function resolveBefore(cursor: string | undefined, endDate: string): string | undefined {
  if (cursor !== undefined && cursor.length > 0) return cursor;
  return datetimeLocalToIso(endDate);
}

export function resolveSince(since: string): string | undefined {
  return datetimeLocalToIso(since);
}
