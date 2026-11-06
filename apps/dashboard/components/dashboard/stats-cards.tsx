// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { AdminDisabledError, type AdminStats, fetchAdminStats } from "../../lib/admin";

const formatter = new Intl.NumberFormat("en-US");

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1.5 text-sm text-muted-foreground">{label}</dt>
      <dd className="font-condensed text-4xl font-semibold tabular-nums leading-none">
        {formatter.format(value)}
      </dd>
    </div>
  );
}

// The deployment in four numbers, set as a row rather than four cards.
export async function StatsCards() {
  let stats: AdminStats;
  try {
    stats = await fetchAdminStats();
  } catch (err) {
    const body =
      err instanceof AdminDisabledError
        ? "Set JUNJO_ADMIN_TOKEN on the dashboard and the server to count across games."
        : err instanceof Error
          ? err.message
          : "The stats request failed.";
    return <p className="text-sm text-muted-foreground">{body}</p>;
  }
  return (
    <dl className="flex flex-wrap gap-x-12 gap-y-6 border-b border-border pb-6">
      <Figure value={stats.totalGames} label="games" />
      <Figure value={stats.totalGroups} label="groups" />
      <Figure value={stats.totalActiveMembers} label="active members" />
      <Figure value={stats.totalAuditEntriesLast24h} label="changes in the last 24 hours" />
    </dl>
  );
}
