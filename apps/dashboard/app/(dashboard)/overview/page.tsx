// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Suspense } from "react";

import { PageHeader } from "../../../components/dashboard/page-header";
import { RecentActivityFeed } from "../../../components/dashboard/recent-activity-feed";
import { StatsCards } from "../../../components/dashboard/stats-cards";

export const metadata = {
  title: "Dashboard | Junjo",
};

function Placeholder({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-muted ${className}`} />;
}

export default function DashboardHomePage() {
  return (
    <>
      <PageHeader title="Overview" />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="mx-auto flex max-w-screen-xl flex-col gap-8">
          {/* Each panel streams in on its own. */}
          <Suspense fallback={<Placeholder className="h-16 w-full max-w-xl" />}>
            <StatsCards />
          </Suspense>
          <section aria-labelledby="activity-heading" className="max-w-3xl">
            <h2 id="activity-heading" className="mb-3 text-lg font-semibold">
              Recent activity
            </h2>
            <Suspense fallback={<Placeholder className="h-64 w-full" />}>
              <RecentActivityFeed />
            </Suspense>
          </section>
        </div>
      </main>
    </>
  );
}
