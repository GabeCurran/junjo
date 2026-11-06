// @license All Rights Reserved (see apps/dashboard/LICENSE)
import Link from "next/link";

import {
  type ActivityInput,
  type ActivityPart,
  activityReason,
  describeActivity,
  isModerationAction,
  relativeTime,
} from "../../lib/activity";
import { cn } from "../../lib/utils";

function Part({ part, gameId }: { part: ActivityPart; gameId?: string }) {
  switch (part.kind) {
    case "who":
      return gameId && part.playerId ? (
        <Link
          href={`/games/${encodeURIComponent(gameId)}/players/${encodeURIComponent(part.playerId)}`}
          className="font-medium text-foreground hover:underline"
        >
          {part.text}
        </Link>
      ) : (
        <span className="font-medium text-foreground">{part.text}</span>
      );
    case "place":
      return (
        <span className={cn("font-medium text-foreground", part.struck && "line-through")}>
          {part.text}
        </span>
      );
    case "code":
      return <code className="font-mono text-[0.85em] text-foreground">{part.text}</code>;
    default:
      return <>{part.text}</>;
  }
}

// The sentence for one audit entry, with the moderator's reason when it
// has one. Feeds and tables both render entries through this.
export function ActivitySentence({ entry }: { entry: ActivityInput }) {
  const reason = activityReason(entry);
  return (
    <>
      {describeActivity(entry).map((part, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional and never reorder.
        <Part key={i} part={part} gameId={entry.gameId} />
      ))}
      {reason ? <span>: {reason}</span> : null}
    </>
  );
}

interface ActivityLineProps {
  entry: ActivityInput & {
    createdAt: string;
    apiKey?: { name: string | null; prefix: string } | null;
  };
}

// One audit entry as a sentence, its reason, and how long ago.
export function ActivityLine({ entry }: ActivityLineProps) {
  const via = entry.apiKey ? (entry.apiKey.name ?? entry.apiKey.prefix) : null;
  return (
    <li className="flex items-baseline gap-3 py-2">
      <span
        aria-hidden
        className={cn(
          "mt-1.5 h-1.5 w-1.5 shrink-0 self-start rounded-full",
          isModerationAction(entry.action) ? "bg-destructive" : "bg-border",
        )}
      />
      <p className="min-w-0 flex-1 break-words text-sm text-muted-foreground">
        <ActivitySentence entry={entry} />
        {via ? <span className="text-muted-foreground/80"> via {via}</span> : null}
      </p>
      <time
        dateTime={entry.createdAt}
        title={new Date(entry.createdAt).toLocaleString("en-US")}
        className="shrink-0 text-xs tabular-nums text-muted-foreground"
      >
        {relativeTime(entry.createdAt)}
      </time>
    </li>
  );
}
