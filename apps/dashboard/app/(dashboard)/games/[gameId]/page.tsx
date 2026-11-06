// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ActivityLine } from "../../../../components/dashboard/activity-line";
import { ApiKeysSection } from "../../../../components/dashboard/api-keys-section";
import { GameFigures } from "../../../../components/dashboard/game-detail-header";
import { LiveRefresh } from "../../../../components/dashboard/live-refresh";
import { PageHeader } from "../../../../components/dashboard/page-header";
import { Notice, Section } from "../../../../components/ui/section";
import {
  AdminDisabledError,
  type AdminGame,
  fetchAdminGame,
  fetchAdminGameAudit,
} from "../../../../lib/admin";

interface GameDetailPageProps {
  params: Promise<{ gameId: string }>;
}

export async function generateMetadata(props: GameDetailPageProps) {
  const params = await props.params;
  try {
    const game = await fetchAdminGame(params.gameId);
    return { title: `${game.name} | Junjo Dashboard` };
  } catch {
    return { title: "Game | Junjo Dashboard" };
  }
}

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

async function GameActivity({ game }: { game: AdminGame }) {
  try {
    const page = await fetchAdminGameAudit(game.id, { limit: 15 }, { revalidate: 0 });
    if (page.items.length === 0) {
      return <Notice title="No activity yet" body="Changes in this game show up here." />;
    }
    return (
      <ul className="divide-y divide-border/60">
        {page.items.map((entry) => (
          <ActivityLine key={entry.id} entry={entry} />
        ))}
      </ul>
    );
  } catch (err) {
    return (
      <Notice
        title="Could not load activity"
        body={err instanceof Error ? err.message : "The audit request failed."}
      />
    );
  }
}

export default async function GameDetailPage(props: GameDetailPageProps) {
  const { gameId } = await props.params;
  let game: AdminGame;
  try {
    game = await fetchAdminGame(gameId);
  } catch (err) {
    if (
      err instanceof Error &&
      !(err instanceof AdminDisabledError) &&
      /not.?found/i.test(err.message)
    ) {
      notFound();
    }
    return (
      <>
        <PageHeader title="Game" />
        <main className="flex-1 px-6 pb-12 pt-4">
          <Notice
            title={
              err instanceof AdminDisabledError
                ? "Cross-game access is off"
                : "Could not load the game"
            }
            body={
              err instanceof AdminDisabledError
                ? "Set JUNJO_ADMIN_TOKEN on the dashboard and the server to open games."
                : err instanceof Error
                  ? err.message
                  : "The game request failed."
            }
          />
        </main>
      </>
    );
  }

  const base = `/games/${encodeURIComponent(game.id)}`;
  return (
    <>
      <PageHeader
        title={game.name}
        meta={
          <>
            <span className="font-mono">{game.id}</span>
            <span className="mx-2 text-border">/</span>
            created {dateFormatter.format(new Date(game.createdAt))}
          </>
        }
      />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-screen-xl flex-col gap-10">
          <GameFigures game={game} />
          <div className="grid gap-10 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Suspense fallback={<div className="h-48 animate-pulse rounded bg-muted" />}>
              <ApiKeysSection gameId={game.id} />
            </Suspense>
            <Section
              title="Recent activity"
              actions={
                <>
                  <LiveRefresh storageKey={`junjo.live.${game.id}`} />
                  <Link href={`${base}/audit`} className="text-sm text-primary hover:underline">
                    Full audit log
                  </Link>
                </>
              }
            >
              <Suspense fallback={<div className="h-48 animate-pulse rounded bg-muted" />}>
                <GameActivity game={game} />
              </Suspense>
            </Section>
          </div>
        </div>
      </main>
    </>
  );
}
