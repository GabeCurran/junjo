// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Gamepad2, KeyRound, Layers, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { AdminGame } from "../../lib/admin";
import { Card, CardContent } from "../ui/card";

const numberFormatter = new Intl.NumberFormat("en-US");

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

interface StatTileProps {
  label: string;
  value: number;
  icon: LucideIcon;
}

function StatTile({ label, value, icon: Icon }: StatTileProps) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 p-4">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums">
            {numberFormatter.format(value)}
          </p>
        </div>
        <Icon className="h-6 w-6 text-muted-foreground" aria-hidden />
      </CardContent>
    </Card>
  );
}

interface GameDetailHeaderProps {
  game: AdminGame;
}

export function GameDetailHeader({ game }: GameDetailHeaderProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-card text-primary">
          <Gamepad2 className="h-6 w-6" aria-hidden />
        </div>
        <div className="flex flex-col">
          <h2 className="text-xl font-semibold tracking-tight">{game.name}</h2>
          <p className="font-mono text-xs text-muted-foreground">{game.id}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Created {dateTimeFormatter.format(new Date(game.createdAt))}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatTile label="Groups" value={game.groupCount} icon={Layers} />
        <StatTile label="Active members" value={game.activeMemberCount} icon={Users} />
        <StatTile label="Active API keys" value={game.apiKeyCount} icon={KeyRound} />
      </div>
    </div>
  );
}
