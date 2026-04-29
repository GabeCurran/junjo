// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { ArrowRight, Gamepad2 } from "lucide-react";
import Link from "next/link";

import { AdminDisabledError, type AdminGame, fetchAdminGames } from "../../lib/admin";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

const numberFormatter = new Intl.NumberFormat("en-US");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

interface ListShellProps {
  children: React.ReactNode;
}

function ListShell({ children }: ListShellProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">All games</CardTitle>
        <CardDescription>
          Every game registered on this Junjo deployment, newest first.
        </CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function renderEmptyState(title: string, body: string) {
  return (
    <ListShell>
      <div className="flex flex-col items-center rounded-md border border-dashed border-border bg-card/50 p-10 text-center">
        <Gamepad2 className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium">{title}</p>
        <p className="mt-1 max-w-md text-xs text-muted-foreground">{body}</p>
      </div>
    </ListShell>
  );
}

interface GameRowProps {
  game: AdminGame;
}

function GameRow({ game }: GameRowProps) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-3 pr-4">
        <Link
          href={`/games/${encodeURIComponent(game.id)}`}
          className="group flex items-baseline gap-2"
        >
          <span className="text-sm font-medium group-hover:underline">{game.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{game.id}</span>
        </Link>
      </td>
      <td className="py-3 pr-4 text-right text-sm tabular-nums">
        {numberFormatter.format(game.groupCount)}
      </td>
      <td className="py-3 pr-4 text-right text-sm tabular-nums">
        {numberFormatter.format(game.activeMemberCount)}
      </td>
      <td className="py-3 pr-4 text-right text-sm tabular-nums">
        {numberFormatter.format(game.apiKeyCount)}
      </td>
      <td className="py-3 pr-4 text-right text-xs text-muted-foreground">
        {dateFormatter.format(new Date(game.createdAt))}
      </td>
      <td className="py-3 text-right">
        <Link
          href={`/games/${encodeURIComponent(game.id)}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          Open
          <ArrowRight className="h-3 w-3" aria-hidden />
        </Link>
      </td>
    </tr>
  );
}

export async function GamesList() {
  let games: AdminGame[];
  try {
    const page = await fetchAdminGames();
    games = page.items;
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return renderEmptyState(
        "Cross-game access is disabled",
        "Set JUNJO_ADMIN_TOKEN on this dashboard to load games. The token gates every cross-game admin endpoint.",
      );
    }
    return renderEmptyState(
      "Could not load games",
      err instanceof Error ? err.message : "unknown error fetching games",
    );
  }

  if (games.length === 0) {
    return renderEmptyState(
      "No games yet",
      "Click 'Create game' above to register the first game on this deployment. You can issue API keys after the game exists.",
    );
  }

  return (
    <ListShell>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-4 text-left font-medium">Name</th>
              <th className="py-2 pr-4 text-right font-medium">Groups</th>
              <th className="py-2 pr-4 text-right font-medium">Active members</th>
              <th className="py-2 pr-4 text-right font-medium">API keys</th>
              <th className="py-2 pr-4 text-right font-medium">Created</th>
              <th className="py-2 font-medium" aria-label="Open game" />
            </tr>
          </thead>
          <tbody>
            {games.map((game) => (
              <GameRow key={game.id} game={game} />
            ))}
          </tbody>
        </table>
      </div>
    </ListShell>
  );
}
