// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowLeft, ScrollText, ShieldCheck } from "lucide-react";
import Link from "next/link";
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
  params: { gameId: string };
}

export async function generateMetadata({ params }: GameDetailPageProps) {
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

export default function GameDetailPage({ params }: GameDetailPageProps) {
  return (
    <>
      <Topbar
        title="Game detail"
        description="Issue and revoke API keys for this game."
        actions={
          <div className="flex items-center gap-2">
            <Link
              href={`/games/${encodeURIComponent(params.gameId)}/permissions/check`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ShieldCheck className="h-3 w-3" aria-hidden />
              Permission check
            </Link>
            <Link
              href={`/games/${encodeURIComponent(params.gameId)}/audit`}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ScrollText className="h-3 w-3" aria-hidden />
              Audit log
            </Link>
            <Link
              href="/games"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              <ArrowLeft className="h-3 w-3" aria-hidden />
              All games
            </Link>
          </div>
        }
      />
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-6xl">
          <GameBody gameId={params.gameId} />
        </div>
      </main>
    </>
  );
}
