// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import { PageHeader } from "../../../components/dashboard/page-header";
import { Notice } from "../../../components/ui/section";

export const metadata = {
  title: "Audit | Junjo Dashboard",
};

export default function AuditPage() {
  return (
    <>
      <PageHeader title="Audit" />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="max-w-screen-xl">
          <Notice
            title="Audit logs are per game"
            body={
              <>
                Pick a game in the game switcher, then open Audit log. Or choose one from{" "}
                <Link href="/games" className="text-primary hover:underline">
                  Games
                </Link>
                .
              </>
            }
          />
        </div>
      </main>
    </>
  );
}
