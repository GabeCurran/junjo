// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Activity, Gamepad2, Users, UsersRound } from "lucide-react";
import type { ComponentType } from "react";

import { AdminDisabledError, type AdminStats, fetchAdminStats } from "../../lib/admin";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

interface StatRowProps {
  label: string;
  value: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
}

function StatCard({ label, value, hint, icon: Icon }: StatRowProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-5 w-5 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-4xl font-semibold tabular-nums">{value}</div>
        <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

const formatter = new Intl.NumberFormat("en-US");

function renderCards(stats: AdminStats) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Games"
        value={formatter.format(stats.totalGames)}
        hint="Registered on this deployment"
        icon={Gamepad2}
      />
      <StatCard
        label="Groups"
        value={formatter.format(stats.totalGroups)}
        hint="Excludes soft-deleted groups"
        icon={UsersRound}
      />
      <StatCard
        label="Active members"
        value={formatter.format(stats.totalActiveMembers)}
        hint="Status active, in live groups"
        icon={Users}
      />
      <StatCard
        label="Audit events (24h)"
        value={formatter.format(stats.totalAuditEntriesLast24h)}
        hint="Includes soft-deleted-group history"
        icon={Activity}
      />
    </div>
  );
}

function renderEmptyState(title: string, body: string) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card className="md:col-span-2 xl:col-span-4">
        <CardHeader>
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{body}</p>
        </CardContent>
      </Card>
    </div>
  );
}

export async function StatsCards() {
  let stats: AdminStats;
  try {
    stats = await fetchAdminStats();
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return renderEmptyState(
        "Cross-game stats are disabled",
        "Set the JUNJO_ADMIN_TOKEN env var on this dashboard and on the Junjo server to populate the overview cards. The token gates the cross-game admin endpoints; without it, the per-game SDK has no way to count across deployments.",
      );
    }
    return renderEmptyState(
      "Could not load overview stats",
      err instanceof Error ? err.message : "unknown error fetching stats",
    );
  }
  return renderCards(stats);
}
