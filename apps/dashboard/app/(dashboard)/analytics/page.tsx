// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Topbar } from "../../../components/dashboard/topbar";

export const metadata = {
  title: "Analytics | Junjo Dashboard",
};

export default function AnalyticsPage() {
  return (
    <>
      <Topbar
        title="Analytics"
        description="Group churn, growth, member activity, and permission distributions."
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="text-lg font-semibold">Analytics charts land in Phase 12.1 - 12.5</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Tremor-driven charts cover group churn, growth over time, member activity heatmap, and
            role / permission distribution.
          </p>
        </div>
      </main>
    </>
  );
}
