// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import { AdminDisabledError, type AdminGame, fetchAdminGames } from "../../lib/admin";
import { Notice } from "../ui/section";

const numberFormatter = new Intl.NumberFormat("en-US");

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
});

function GameRow({ game }: { game: AdminGame }) {
  return (
    <tr className="border-b border-border/60 last:border-0 hover:bg-accent/40">
      <td className="py-2.5 pr-4">
        <Link
          href={`/games/${encodeURIComponent(game.id)}`}
          className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3"
        >
          <span className="font-medium hover:underline">{game.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{game.id}</span>
        </Link>
      </td>
      <td className="hidden py-2.5 pr-4 text-right sm:table-cell">
        {numberFormatter.format(game.groupCount)}
      </td>
      <td className="py-2.5 pr-4 text-right">{numberFormatter.format(game.activeMemberCount)}</td>
      <td className="hidden py-2.5 pr-4 text-right md:table-cell">
        {numberFormatter.format(game.apiKeyCount)}
      </td>
      <td className="hidden py-2.5 text-right text-muted-foreground md:table-cell">
        {dateFormatter.format(new Date(game.createdAt))}
      </td>
    </tr>
  );
}

export async function GamesList() {
  let games: AdminGame[];
  try {
    games = (await fetchAdminGames()).items;
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return (
        <Notice
          title="Cross-game access is off"
          body="Set JUNJO_ADMIN_TOKEN on the dashboard and the server to list games."
        />
      );
    }
    return (
      <Notice
        title="Could not load games"
        body={err instanceof Error ? err.message : "The games request failed."}
      />
    );
  }

  if (games.length === 0) {
    return <Notice title="No games yet" body="Create one to issue its first API key." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-2 pr-4 text-left font-medium">Name</th>
            <th className="hidden py-2 pr-4 text-right font-medium sm:table-cell">Groups</th>
            <th className="py-2 pr-4 text-right font-medium">Active members</th>
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
  );
}
