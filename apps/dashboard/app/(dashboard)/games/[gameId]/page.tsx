// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { ApiKeysSection } from "../../../../components/dashboard/api-keys-section";
import { GameDetailHeader } from "../../../../components/dashboard/game-detail-header";
import { Topbar } from "../../../../components/dashboard/topbar";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../../components/ui/card";
import { AdminDisabledError, type AdminGame, fetchAdminGame } from "../../../../lib/admin";

interface GameDetailPageProps {
  params: Promise<{ gameId: string }>;
}

export async function generateMetadata(props: GameDetailPageProps) {
  const params = await props.params;
  // Best-effort title: fall back to the gameId if the lookup fails. The page
  // body itself shows a more descriptive empty state when the lookup fails;
  // the title only uses the name when we can fetch it cheaply.
  try {
    const game = await fetchAdminGame(params.gameId);
    return { title: `${game.name} | Junjo Dashboard` };
  } catch {
    return { title: "Game | Junjo Dashboard" };
  }
}

function ApiKeysSectionSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="h-4 w-24 rounded bg-muted" />
        <CardDescription className="h-3 w-72 rounded bg-muted" />
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center justify-between border-b border-border py-3 last:border-0"
            >
              <div className="h-4 w-32 rounded bg-muted" />
              <div className="flex gap-3">
                <div className="h-4 w-20 rounded bg-muted" />
                <div className="h-4 w-20 rounded bg-muted" />
                <div className="h-6 w-16 rounded bg-muted" />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

interface ErrorCardProps {
  title: string;
  body: string;
}

function ErrorCard({ title, body }: ErrorCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
    </Card>
  );
}

async function GameBody({ gameId }: { gameId: string }) {
  let game: AdminGame;
  try {
    game = await fetchAdminGame(gameId);
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <ErrorCard
          title="Cross-game access is disabled"
          body="Set JUNJO_ADMIN_TOKEN on this dashboard to load games. The token gates every cross-game admin endpoint."
        />
      );
    }
    // Map the server's "admin request failed: game not found" message to a
    // Next.js 404. The lib/admin helper surfaces JunjoError envelopes via
    // `Error("admin request failed: <message>")`; the substring match is
    // intentionally narrow.
    if (err instanceof Error && /not.?found/i.test(err.message)) {
      notFound();
    }
    return (
      <ErrorCard
        title="Could not load game"
        body={err instanceof Error ? err.message : "unknown error fetching the game"}
      />
    );
  }

  return (
    <div className="space-y-6">
      <GameDetailHeader game={game} />
      <Suspense fallback={<ApiKeysSectionSkeleton />}>
        <ApiKeysSection gameId={game.id} />
      </Suspense>
    </div>
  );
}

export default async function GameDetailPage(props: GameDetailPageProps) {
  const params = await props.params;
  return (
    <>
      <Topbar title="Game detail" description="Issue and revoke API keys for this game." />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-screen-2xl">
          <GameBody gameId={params.gameId} />
        </div>
      </main>
    </>
  );
}
