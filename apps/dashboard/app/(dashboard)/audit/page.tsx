// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Topbar } from "../../../components/dashboard/topbar";

export const metadata = {
  title: "Audit | Junjo Dashboard",
};

export default function AuditPage() {
  return (
    <>
      <Topbar title="Audit" description="Cross-game audit feed across every Junjo group." />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-screen-xl rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="text-lg font-semibold">Audit viewer lands in Phase 11.8</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This page will surface a paginated audit table with action / actor / target / date
            filters and CSV export.
          </p>
        </div>
      </main>
    </>
  );
}
