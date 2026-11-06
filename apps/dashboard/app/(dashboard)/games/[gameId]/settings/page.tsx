// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { notFound } from "next/navigation";

import { PageHeader } from "../../../../../components/dashboard/page-header";
import { fetchAdminGame, fetchAdminGameConfig } from "../../../../../lib/admin";
import { SettingsForm } from "./settings-form";

interface PageProps {
  params: Promise<{ gameId: string }>;
}

export async function generateMetadata(props: PageProps) {
  const { gameId } = await props.params;
  try {
    const game = await fetchAdminGame(gameId);
    return { title: `Settings | ${game.name} | Junjo Dashboard` };
  } catch {
    return { title: "Settings | Junjo Dashboard" };
  }
}

export default async function GameSettingsPage(props: PageProps) {
  const { gameId } = await props.params;
  const [game, config] = await Promise.all([
    fetchAdminGame(gameId).catch(() => null),
    // Uncached: the editors compare against what is stored right now.
    fetchAdminGameConfig(gameId, { revalidate: 0 }).catch(() => null),
  ]);
  if (!game || !config) notFound();

  return (
    <>
      <PageHeader title="Settings" meta={game.name} />
      <main className="flex-1 px-6 pb-16 pt-4">
        <div className="max-w-screen-lg">
          <SettingsForm initial={config} gameId={gameId} />
        </div>
      </main>
    </>
  );
}
