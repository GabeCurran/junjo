// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

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
        <div className="mx-auto max-w-screen-xl rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="text-lg font-semibold">Analytics surfaces are game-scoped</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Charts populate from each game's audit log and group / member tables. Open a game from
            the{" "}
            <Link href="/games" className="font-medium text-foreground underline">
              Games list
            </Link>{" "}
            and use its <span className="font-mono">Analytics</span> action to see group churn,
            growth, member activity, and role / permission distributions for that game.
          </p>
        </div>
      </main>
    </>
  );
}
