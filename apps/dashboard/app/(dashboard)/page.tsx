// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Suspense } from "react";

import { RecentActivityFeed } from "../../components/dashboard/recent-activity-feed";
import { StatsCards } from "../../components/dashboard/stats-cards";
import { Topbar } from "../../components/dashboard/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";

export const metadata = {
  title: "Dashboard | Junjo",
};

// Both panels fetch independently with their own revalidate window inside
// `lib/admin.ts`. Suspense lets either panel arrive on the page without
// blocking the other, and a streaming-render placeholder keeps the layout
// stable while the slower panel is in flight.

function StatsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <CardTitle className="h-4 w-24 rounded bg-muted" />
          </CardHeader>
          <CardContent>
            <div className="h-7 w-16 rounded bg-muted" />
            <div className="mt-2 h-3 w-32 rounded bg-muted" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ActivitySkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-40 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <ul className="divide-y divide-border">
          {[0, 1, 2, 3, 4].map((i) => (
            <li key={i} className="flex items-start gap-3 py-3">
              <div className="mt-1 h-6 w-6 shrink-0 rounded-full bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-3/4 rounded bg-muted" />
                <div className="h-3 w-1/3 rounded bg-muted" />
              </div>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function DashboardHomePage() {
  return (
    <>
      <Topbar
        title="Dashboard"
        description="Operational overview across every game on this Junjo deployment."
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-6">
          <Suspense fallback={<StatsSkeleton />}>
            <StatsCards />
          </Suspense>
          <Suspense fallback={<ActivitySkeleton />}>
            <RecentActivityFeed />
          </Suspense>
        </div>
      </main>
    </>
  );
}
