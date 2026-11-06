// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { type AdminAuditEntry, AdminDisabledError, fetchRecentAudit } from "../../lib/admin";
import { Notice } from "../ui/section";
import { ActivityLine } from "./activity-line";

export async function RecentActivityFeed() {
  let entries: AdminAuditEntry[];
  try {
    entries = (await fetchRecentAudit(30)).items;
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <Notice
          title="Activity is off"
          body="Set JUNJO_ADMIN_TOKEN on the dashboard and the server to see activity across games."
        />
      );
    }
    return (
      <Notice
        title="Could not load activity"
        body={err instanceof Error ? err.message : "The audit request failed."}
      />
    );
  }
  if (entries.length === 0) {
    return <Notice title="No activity yet" body="Changes in any game show up here." />;
  }
  // Group the feed by game so a busy game does not bury the others'
  // names in every line.
  const byGame = new Map<string, { name: string; items: AdminAuditEntry[] }>();
  for (const entry of entries) {
    const bucket = byGame.get(entry.gameId) ?? { name: entry.gameName, items: [] };
    bucket.items.push(entry);
    byGame.set(entry.gameId, bucket);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...byGame.entries()].map(([gameId, bucket]) => (
        <section key={gameId} aria-label={bucket.name}>
          <h3 className="border-b border-border pb-1.5 text-sm font-semibold">{bucket.name}</h3>
          <ul className="divide-y divide-border/60">
            {bucket.items.map((entry) => (
              <ActivityLine key={entry.id} entry={entry} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
