// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Eye, EyeOff, Layers, Lock, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { AdminGroup } from "../../lib/admin";
import { Badge } from "../ui/badge";
import { Card, CardContent } from "../ui/card";

const numberFormatter = new Intl.NumberFormat("en-US");

const dateTimeFormatter = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const VISIBILITY_ICON: Record<string, LucideIcon> = {
  public: Eye,
  "invite-only": Lock,
  secret: EyeOff,
};

interface GroupDetailHeaderProps {
  group: AdminGroup;
}

export function GroupDetailHeader({ group }: GroupDetailHeaderProps) {
  const VisibilityIcon = VISIBILITY_ICON[group.visibility] ?? Lock;
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-card text-primary">
            <Layers className="h-6 w-6" aria-hidden />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight">{group.name}</h2>
              <Badge variant="muted" className="font-mono">
                {group.kind}
              </Badge>
              <Badge variant="secondary" className="inline-flex items-center gap-1">
                <VisibilityIcon className="h-3 w-3" aria-hidden />
                {group.visibility}
              </Badge>
            </div>
            <p className="font-mono text-xs text-muted-foreground">{group.id}</p>
            <p className="text-xs text-muted-foreground">
              Created {dateTimeFormatter.format(new Date(group.createdAt))} - Updated{" "}
              {dateTimeFormatter.format(new Date(group.updatedAt))}
            </p>
          </div>
        </div>
        <Card className="sm:w-56">
          <CardContent className="flex items-center justify-between gap-4 p-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Active members
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {numberFormatter.format(group.memberCount)}
              </p>
            </div>
            <Users className="h-6 w-6 text-muted-foreground" aria-hidden />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
