// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { AdminGame } from "../../lib/admin";

const numberFormatter = new Intl.NumberFormat("en-US");

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-sm text-muted-foreground">{label}</dt>
      <dd className="font-condensed text-3xl font-semibold tabular-nums leading-none">
        {numberFormatter.format(value)}
      </dd>
    </div>
  );
}

// The game's size, as a row of figures under the page header.
export function GameFigures({ game }: { game: AdminGame }) {
  return (
    <dl className="flex flex-wrap gap-x-12 gap-y-4">
      <Figure value={game.activeMemberCount} label="active members" />
      <Figure value={game.groupCount} label="groups" />
      <Figure value={game.apiKeyCount} label="active API keys" />
    </dl>
  );
}
