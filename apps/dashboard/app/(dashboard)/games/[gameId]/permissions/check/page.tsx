// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { PageHeader } from "../../../../../../components/dashboard/page-header";
import { PermissionCheckTester } from "../../../../../../components/dashboard/permission-check-tester";
import { fetchAdminGame } from "../../../../../../lib/admin";

interface PermissionCheckPageProps {
  params: Promise<{ gameId: string }>;
}

export async function generateMetadata(props: PermissionCheckPageProps) {
  const params = await props.params;
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

export default async function PermissionCheckPage(props: PermissionCheckPageProps) {
  const params = await props.params;
  return (
    <>
      <PageHeader title="Permission check" />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="max-w-screen-xl">
          <PermissionCheckTester gameId={params.gameId} />
        </div>
      </main>
    </>
  );
}
