// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Topbar } from "../../components/dashboard/topbar";

export default function DashboardHomePage() {
  return (
    <>
      <Topbar
        title="Dashboard"
        description="Operational overview across every game on this Junjo deployment."
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl">
          <h2 className="text-2xl font-semibold tracking-tight">Welcome</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            The home overview lands in Phase 11.2. Until then, use the sidebar to navigate to a
            section that has shipped.
          </p>
        </div>
      </main>
    </>
  );
}
