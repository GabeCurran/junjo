// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { ChevronRight, Download } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useId, useRef, useState } from "react";

import { relativeTime } from "../../lib/activity";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH,
  ADMIN_GAME_AUDIT_DEFAULT_PAGE_SIZE,
  ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS,
  ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH,
  type AdminAuditEntry,
  type AdminGameAuditPage,
  adminAuditActionLabel,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Notice } from "../ui/section";
import { ActivitySentence } from "./activity-line";

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

// Option groups for the action filter, keyed by the action's first
// segment. Identity actions are game-scoped, so they sit with the game.
const ACTION_GROUPS: ReadonlyArray<{ label: string; prefixes: readonly string[] }> = [
  { label: "Groups", prefixes: ["group"] },
  { label: "Members", prefixes: ["member"] },
  { label: "Roles", prefixes: ["role"] },
  { label: "Permissions", prefixes: ["permission"] },
  { label: "Game", prefixes: ["game", "identity"] },
];

function actionsFor(prefixes: readonly string[]): string[] {
  return ADMIN_AUDIT_ACTIONS.filter((action) => prefixes.includes(action.split(".")[0] ?? ""));
}

const GROUPED_PREFIXES = new Set(ACTION_GROUPS.flatMap((g) => g.prefixes));
const UNGROUPED_ACTIONS = ADMIN_AUDIT_ACTIONS.filter(
  (action) => !GROUPED_PREFIXES.has(action.split(".")[0] ?? ""),
);

const controlClass = cn(
  "h-8 rounded-md border border-input bg-background px-2 text-sm",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  "focus-visible:ring-offset-2 ring-offset-background",
  "placeholder:text-muted-foreground",
);

const buttonClass = cn(
  "inline-flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm",
  "transition-colors hover:bg-accent hover:text-accent-foreground",
  "disabled:pointer-events-none disabled:opacity-50",
);

function DetailItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all">{children}</dd>
    </>
  );
}

function AuditRow({ entry }: { entry: AdminAuditEntry }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const hasPayload = Object.keys(entry.payload).length > 0;
  const via = entry.apiKey ? (entry.apiKey.name ?? entry.apiKey.prefix) : null;
  return (
    <Fragment>
      <tr
        className={cn(
          "border-b border-border/60 align-top hover:bg-accent/40",
          open && "border-b-0",
        )}
      >
        <td className="py-2 pr-4">
          <p className="break-words text-muted-foreground">
            <ActivitySentence entry={entry} />
          </p>
          <code className="mt-0.5 block font-mono text-xs text-muted-foreground">
            {entry.action}
          </code>
        </td>
        <td className="hidden py-2 pr-4 md:table-cell">
          {entry.actorUserId ? (
            <span className="break-all font-mono text-xs">{entry.actorUserId}</span>
          ) : (
            <span className="text-muted-foreground">System</span>
          )}
          {via ? <span className="block text-xs text-muted-foreground">via {via}</span> : null}
        </td>
        <td className="whitespace-nowrap py-2 pr-2 text-right">
          <time
            dateTime={entry.createdAt}
            title={absoluteFormatter.format(new Date(entry.createdAt))}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {relativeTime(entry.createdAt)}
          </time>
        </td>
        <td className="w-8 py-1.5 text-right">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={detailsId}
            aria-label={open ? "Hide details" : "Show details"}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <ChevronRight
              className={cn("h-4 w-4 transition-transform", open && "rotate-90")}
              aria-hidden
            />
          </button>
        </td>
      </tr>
      {open ? (
        <tr id={detailsId} className="border-b border-border/60">
          <td colSpan={4} className="pb-3 pr-2">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-xs">
              <DetailItem label="Action">
                <code className="font-mono">{entry.action}</code>
              </DetailItem>
              <DetailItem label="Target">
                {entry.targetId ? (
                  <code className="font-mono">{entry.targetId}</code>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </DetailItem>
              <DetailItem label="Group">
                {entry.groupId ? (
                  <>
                    {entry.groupName ?? "Unnamed"}
                    {entry.groupSoftDeleted ? (
                      <span className="text-muted-foreground"> (deleted)</span>
                    ) : null}{" "}
                    <code className="font-mono text-muted-foreground">{entry.groupId}</code>
                  </>
                ) : (
                  <span className="text-muted-foreground">Game-wide</span>
                )}
              </DetailItem>
              <DetailItem label="Actor">
                {entry.actorUserId ? (
                  <code className="font-mono">{entry.actorUserId}</code>
                ) : (
                  <span className="text-muted-foreground">System</span>
                )}
              </DetailItem>
              {entry.apiKey ? (
                <DetailItem label="API key">
                  {entry.apiKey.name ? `${entry.apiKey.name} ` : null}
                  <code className="font-mono text-muted-foreground">{entry.apiKey.prefix}</code>
                </DetailItem>
              ) : null}
              <DetailItem label="Time">
                <span className="tabular-nums">
                  {absoluteFormatter.format(new Date(entry.createdAt))}
                </span>
              </DetailItem>
            </dl>
            {hasPayload ? (
              <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(entry.payload, null, 2)}
              </pre>
            ) : null}
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
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
  "apiKeyPrefix",
  "apiKeyName",
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
        entry.groupId ?? "",
        entry.groupName ?? "",
        String(entry.groupSoftDeleted),
        entry.actorUserId ?? "",
        entry.apiKey?.prefix ?? "",
        entry.apiKey?.name ?? "",
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
  const filtered =
    query.action.length > 0 ||
    query.actor.length > 0 ||
    query.target.length > 0 ||
    query.since.length > 0 ||
    query.endDate.length > 0;
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
  const count = page.items.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={actionSelectId} className="text-xs text-muted-foreground">
            Action
          </label>
          <select
            id={actionSelectId}
            value={query.action}
            onChange={(e) => pushQuery({ action: e.target.value, cursor: undefined })}
            className={cn(controlClass, "w-56")}
          >
            <option value="">All actions</option>
            {ACTION_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {actionsFor(group.prefixes).map((action) => (
                  <option key={action} value={action}>
                    {adminAuditActionLabel(action)}
                  </option>
                ))}
              </optgroup>
            ))}
            {UNGROUPED_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {adminAuditActionLabel(action)}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={actorInputId} className="text-xs text-muted-foreground">
            Actor
          </label>
          <input
            id={actorInputId}
            type="text"
            value={actorValue}
            onChange={(e) => setActorValue(e.target.value)}
            maxLength={ADMIN_GAME_AUDIT_ACTOR_ID_MAX_LENGTH}
            placeholder="User id"
            spellCheck={false}
            autoComplete="off"
            className={cn(controlClass, "w-40 font-mono")}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={targetInputId} className="text-xs text-muted-foreground">
            Target
          </label>
          <input
            id={targetInputId}
            type="text"
            value={targetValue}
            onChange={(e) => setTargetValue(e.target.value)}
            maxLength={ADMIN_GAME_AUDIT_TARGET_ID_MAX_LENGTH}
            placeholder="Target id"
            spellCheck={false}
            autoComplete="off"
            className={cn(controlClass, "w-40 font-mono")}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={sinceInputId} className="text-xs text-muted-foreground">
            From
          </label>
          <input
            id={sinceInputId}
            type="datetime-local"
            value={query.since}
            onChange={(e) => pushQuery({ since: e.target.value, cursor: undefined })}
            className={controlClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={endInputId} className="text-xs text-muted-foreground">
            Before
          </label>
          <input
            id={endInputId}
            type="datetime-local"
            value={query.endDate}
            onChange={(e) => pushQuery({ endDate: e.target.value, cursor: undefined })}
            className={controlClass}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label htmlFor={pageSizeSelectId} className="text-xs text-muted-foreground">
            Rows
          </label>
          <select
            id={pageSizeSelectId}
            value={query.limit}
            onChange={(e) => {
              const nextLimit = Number(e.target.value);
              pushQuery({ limit: nextLimit, cursor: undefined });
            }}
            className={controlClass}
          >
            {ADMIN_GAME_AUDIT_PAGE_SIZE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={onExport}
          disabled={count === 0}
          className={cn(buttonClass, "sm:ml-auto")}
          title="Download the entries on this page as CSV"
        >
          <Download className="h-3.5 w-3.5" aria-hidden />
          Export CSV
        </button>
      </div>

      {count === 0 ? (
        <Notice
          title={
            filtered
              ? "No entries match these filters"
              : isFirstPage
                ? "No audit entries yet"
                : "No older entries"
          }
          body={
            filtered
              ? "Widen the filters or clear them."
              : isFirstPage
                ? "Changes in this game show up here."
                : "This is the end of the log."
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="py-2 pr-4 text-left font-medium">Event</th>
                <th className="hidden py-2 pr-4 text-left font-medium md:table-cell">Actor</th>
                <th className="py-2 pr-2 text-right font-medium">When</th>
                <th className="w-8 py-2">
                  <span className="sr-only">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((entry) => (
                <AuditRow key={entry.id} entry={entry} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="tabular-nums">
          {count} {count === 1 ? "entry" : "entries"}
          {isFirstPage ? ", newest first" : ", older page"}
        </span>
        <div className="flex items-center gap-2">
          {!isFirstPage ? (
            <button
              type="button"
              onClick={() => pushQuery({ cursor: undefined })}
              className={buttonClass}
            >
              Jump to newest
            </button>
          ) : null}
          <button
            type="button"
            // Browser back is the natural "previous page" gesture for
            // cursor-based pagination - the server cannot run the
            // inverse of `createdAt < before`, so the dashboard relies
            // on the URL history that pushQuery has accumulated.
            onClick={() => router.back()}
            disabled={isFirstPage}
            className={buttonClass}
          >
            Newer
          </button>
          <button
            type="button"
            onClick={() => {
              if (page.nextCursor !== null) {
                pushQuery({ cursor: page.nextCursor });
              }
            }}
            disabled={page.nextCursor === null}
            className={buttonClass}
          >
            Older
          </button>
        </div>
      </div>
    </div>
  );
}
