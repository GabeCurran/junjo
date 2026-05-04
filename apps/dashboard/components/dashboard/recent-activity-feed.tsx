// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowRight } from "lucide-react";

import { type AdminAuditEntry, AdminDisabledError, fetchRecentAudit } from "../../lib/admin";
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

// Picks the largest unit that fits the elapsed delta. The audit feed shows
// entries from "just now" out to several days ago, so a single unit reads
// cleanly without needing a compound "1d 3h" form.
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

interface ActivityRowProps {
  entry: AdminAuditEntry;
}

function ActivityRow({ entry }: ActivityRowProps) {
  return (
    <li className="flex items-start gap-3 py-3">
      <div className="mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
        <ArrowRight className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-mono text-xs text-muted-foreground">{entry.action}</span>
          <span className="text-xs text-muted-foreground">in</span>
          <span className="text-sm font-medium">
            {entry.gameName}
            <span className="text-muted-foreground"> / </span>
            <span className={entry.groupSoftDeleted ? "line-through" : undefined}>
              {entry.groupName}
            </span>
          </span>
          {entry.groupSoftDeleted ? (
            <span className="rounded-full border border-border px-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              soft-deleted
            </span>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {entry.targetId ? (
            <>
              target <span className="font-mono">{entry.targetId}</span>
              {" · "}
            </>
          ) : null}
          <time dateTime={entry.createdAt}>{relativeTime(entry.createdAt)}</time>
        </p>
      </div>
    </li>
  );
}

interface FeedShellProps {
  children: React.ReactNode;
}

function FeedShell({ children }: FeedShellProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent activity</CardTitle>
        <CardDescription>
          Latest 20 audit entries across every game on this deployment.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function renderEmpty(title: string, body: string) {
  return (
    <FeedShell>
      <div className="rounded-md border border-dashed border-border bg-card/50 p-6 text-center">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{body}</p>
      </div>
    </FeedShell>
  );
}

export async function RecentActivityFeed() {
  let entries: AdminAuditEntry[];
  try {
    const page = await fetchRecentAudit(20);
    entries = page.items;
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return renderEmpty(
        "Activity feed is disabled",
        "Set JUNJO_ADMIN_TOKEN to enable cross-game audit visibility.",
      );
    }
    return renderEmpty(
      "Could not load recent activity",
      err instanceof Error ? err.message : "unknown error fetching audit log",
    );
  }
  if (entries.length === 0) {
    return renderEmpty(
      "Nothing has happened yet",
      "Mutations across any game will surface here as soon as the audit log records them.",
    );
  }
  return (
    <FeedShell>
      <ul className="divide-y divide-border">
        {entries.map((entry) => (
          <ActivityRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </FeedShell>
  );
}
