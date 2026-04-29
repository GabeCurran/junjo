// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { PermissionCheckTester } from "../../../../../../components/dashboard/permission-check-tester";
import { Topbar } from "../../../../../../components/dashboard/topbar";
import { fetchAdminGame } from "../../../../../../lib/admin";

interface PermissionCheckPageProps {
  params: { gameId: string };
}

export async function generateMetadata({ params }: PermissionCheckPageProps) {
  // Best-effort title; the page body itself works fine even when the
  // game lookup fails (the form does not depend on the game name).
  // Mirrors the precedent in `[gameId]/page.tsx` and
  // `[gameId]/audit/page.tsx`.
  try {
    const game = await fetchAdminGame(params.gameId);
    return { title: `${game.name} permissions | Junjo Dashboard` };
  } catch {
    return { title: "Permission check | Junjo Dashboard" };
  }
}

export default function PermissionCheckPage({ params }: PermissionCheckPageProps) {
  return (
    <>
      <Topbar
        title="Permission check"
        description="Resolve a (user, group, permission) triple to debug authorization. The answer matches what your runtime junjo.can() call sees."
        actions={
          <Link
            href={`/games/${encodeURIComponent(params.gameId)}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            Game detail
          </Link>
        }
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-5xl">
          <PermissionCheckTester gameId={params.gameId} />
        </div>
      </main>
    </>
  );
}
