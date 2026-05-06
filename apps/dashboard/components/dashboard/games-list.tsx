// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Gamepad2 } from "lucide-react";
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
        <Link href={`/games/${encodeURIComponent(game.id)}`} className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-primary hover:underline">{game.name}</span>
          <span className="hidden font-mono text-xs text-muted-foreground sm:inline">
            {game.id}
          </span>
        </Link>
      </td>
      <td className="hidden py-3 pr-4 text-right text-sm tabular-nums sm:table-cell">
        {numberFormatter.format(game.groupCount)}
      </td>
      <td className="py-3 pr-4 text-right text-sm tabular-nums">
        {numberFormatter.format(game.activeMemberCount)}
      </td>
      <td className="hidden py-3 pr-4 text-right text-sm tabular-nums md:table-cell">
        {numberFormatter.format(game.apiKeyCount)}
      </td>
      <td className="hidden py-3 text-right text-xs text-muted-foreground md:table-cell">
        {dateFormatter.format(new Date(game.createdAt))}
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
              <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Groups</th>
              <th className="py-2 pr-4 text-right font-medium">
                <span className="sm:hidden">Members</span>
                <span className="hidden sm:inline">Active members</span>
              </th>
              <th className="hidden py-2 pr-4 text-right font-medium md:table-cell">API keys</th>
              <th className="hidden py-2 text-right font-medium md:table-cell">Created</th>
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
