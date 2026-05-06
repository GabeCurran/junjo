// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import { Topbar } from "../../../components/dashboard/topbar";

export const metadata = {
  title: "Audit | Junjo Dashboard",
};

export default function AuditPage() {
  return (
    <>
      <Topbar title="Audit" description="Audit logs are scoped per game." />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-screen-xl rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="text-lg font-semibold">Audit logs are game-scoped</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Every mutation writes to its game's audit table. Open a game from the{" "}
            <Link href="/games" className="font-medium text-foreground underline">
              Games list
            </Link>{" "}
            to view its paginated audit log with action / actor / target / date filters and CSV
            export.
          </p>
        </div>
      </main>
    </>
  );
}
