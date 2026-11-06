// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use client";

import { History } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useId } from "react";

import { isModerationAction, relativeTime } from "../../lib/activity";
import {
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_DEFAULT_PAGE_SIZE,
  ADMIN_AUDIT_PAGE_SIZE_OPTIONS,
  type AdminGroupAuditEntry,
  type AdminGroupAuditPage,
} from "../../lib/admin-shared";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
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

const SELECT_CLASS = cn(
  "h-9 rounded-md border border-input bg-background px-3 text-sm ring-offset-background",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
);

export interface AuditQueryState {
  actions: string[];
  before: string | undefined;
  limit: number;
}

interface AuditFeedProps {
  page: AdminGroupAuditPage;
  query: AuditQueryState;
  // The group's name, used as the place in each entry's sentence.
  groupName?: string;
}

interface AuditRowProps {
  entry: AdminGroupAuditEntry;
  groupName: string | undefined;
}

// One entry as a sentence with its actor, the raw action on hover, and
// the payload behind a disclosure.
function AuditRow({ entry, groupName }: AuditRowProps) {
  const hasPayload = Object.keys(entry.payload).length > 0;
  const via = entry.apiKey ? (entry.apiKey.name ?? entry.apiKey.prefix) : null;
  return (
    <li className="flex items-baseline gap-3 py-2.5">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-1.5 w-1.5 shrink-0 self-start rounded-full",
          isModerationAction(entry.action) ? "bg-destructive" : "bg-border",
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm text-muted-foreground" title={entry.action}>
          <ActivitySentence entry={{ ...entry, groupName: groupName ?? null }} />
          {entry.actorUserId ? (
            <>
              {" by "}
              <span className="font-medium text-foreground">{entry.actorUserId}</span>
            </>
          ) : null}
          {via ? <span className="text-muted-foreground/80"> via {via}</span> : null}
        </p>
        {hasPayload ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground transition-colors hover:text-foreground">
              Payload
            </summary>
            <pre className="mt-1 overflow-x-auto rounded-md border border-border bg-card p-2 font-mono text-xs leading-relaxed text-muted-foreground">
              {JSON.stringify(entry.payload, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
      <time
        dateTime={entry.createdAt}
        title={absoluteFormatter.format(new Date(entry.createdAt))}
        className="shrink-0 text-xs tabular-nums text-muted-foreground"
      >
        {relativeTime(entry.createdAt)}
      </time>
    </li>
  );
}

export function AuditFeed({ page, query, groupName }: AuditFeedProps) {
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
    <div className="flex flex-col gap-4">
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
            className={SELECT_CLASS}
          >
            <option value="">All actions</option>
            {ADMIN_AUDIT_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
          <label htmlFor={pageSizeSelectId} className="ml-2 text-sm text-muted-foreground">
            Rows
          </label>
          <select
            id={pageSizeSelectId}
            value={query.limit}
            onChange={(e) => {
              const nextLimit = Number(e.target.value);
              pushQuery({ limit: nextLimit, before: undefined });
            }}
            className={SELECT_CLASS}
          >
            {ADMIN_AUDIT_PAGE_SIZE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        {!isFirstPage ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => pushQuery({ before: undefined })}
          >
            <History className="h-3.5 w-3.5" aria-hidden />
            Jump to newest
          </Button>
        ) : null}
      </div>

      {page.items.length === 0 ? (
        selectedAction.length > 0 ? (
          <Notice
            title={`No ${selectedAction} entries`}
            body="Clear the action filter or pick another action."
          />
        ) : isFirstPage ? (
          <Notice title="No activity yet" body="Changes in this group show up here." />
        ) : (
          <Notice title="No older entries" body="This is the end of the audit log." />
        )
      ) : (
        <ul className="divide-y divide-border/60 border-y border-border/60">
          {page.items.map((entry) => (
            <AuditRow key={entry.id} entry={entry} groupName={groupName} />
          ))}
        </ul>
      )}

      <div className="flex flex-col items-start justify-between gap-3 text-sm text-muted-foreground sm:flex-row sm:items-center">
        <span>{isFirstPage ? "Newest entries" : "Older entries"}</span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            // Browser back is the natural "go to the previous page"
            // gesture for cursor-based pagination: the server cannot
            // run the inverse query of `createdAt < before`, so the
            // dashboard relies on the URL history that pushQuery has
            // accumulated.
            onClick={() => router.back()}
            disabled={isFirstPage}
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              if (page.nextCursor !== null) {
                pushQuery({ before: page.nextCursor });
              }
            }}
            disabled={page.nextCursor === null}
          >
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
