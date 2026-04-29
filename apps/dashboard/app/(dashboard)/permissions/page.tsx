// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import { Topbar } from "../../../components/dashboard/topbar";

export const metadata = {
  title: "Permissions | Junjo Dashboard",
};

export default function PermissionsPage() {
  return (
    <>
      <Topbar
        title="Permissions"
        description="Resolve a (user, group, permission) triple to debug authorization."
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl rounded-lg border border-dashed border-border bg-card/50 p-10 text-center">
          <h2 className="text-lg font-semibold">Permission checks are game-scoped</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Permissions are defined and resolved per game. Open a game from the{" "}
            <Link href="/games" className="font-medium text-foreground underline">
              Games list
            </Link>{" "}
            and use its <span className="font-mono">Permission check</span> action to test a (user,
            group, permission) triple against the same resolver your runtime uses.
          </p>
        </div>
      </main>
    </>
  );
}
