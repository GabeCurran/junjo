// @license All Rights Reserved (see apps/dashboard/LICENSE)
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
          <h2 className="text-lg font-semibold">Permission tester lands in Phase 11.9</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            This page will run permission checks and explain the resolution path (role grant,
            override, or default).
          </p>
        </div>
      </main>
    </>
  );
}
