import { ArrowLeft } from "lucide-react";
// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";
import { notFound } from "next/navigation";
import { Topbar } from "../../../../../components/dashboard/topbar";
import { fetchAdminGame, fetchAdminGameConfig } from "../../../../../lib/admin";
import { SettingsForm } from "./settings-form";

interface PageProps {
  params: Promise<{ gameId: string }>;
}

export default async function GameSettingsPage(props: PageProps) {
  const { gameId } = await props.params;

  // Fetch game + config in parallel; the game fetch hits the same 60s
  // revalidate cache the game-detail page populates.
  const [game, config] = await Promise.all([
    fetchAdminGame(gameId).catch(() => null),
    fetchAdminGameConfig(gameId).catch(() => null),
  ]);
  if (!game || !config) notFound();

  return (
    <>
      <Topbar
        title="Settings"
        description={`Per-game configuration for ${game.name}. Toggles save on change.`}
        actions={
          <Link
            href={`/games/${encodeURIComponent(gameId)}`}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="h-3 w-3" aria-hidden />
            Game detail
          </Link>
        }
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto flex max-w-3xl flex-col gap-6">
          <SettingsForm initial={config} gameId={gameId} />
        </div>
      </main>
    </>
  );
}
