// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type { UserId } from "@junjo.io/sdk";
import { Search } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "../../../../../components/dashboard/page-header";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Notice, Section } from "../../../../../components/ui/section";
import { relativeTime } from "../../../../../lib/activity";
import { AdminDisabledError, fetchAdminGameAudit } from "../../../../../lib/admin";
import { gameClient } from "../../../../../lib/game-client";

export const metadata = {
  title: "Players | Junjo Dashboard",
};

interface PageProps {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<{ q?: string }>;
}

interface Hit {
  userId: string;
  displayName: string | null;
  note: string;
}

// A query is tried as an exact id and as a display name.
async function search(gameId: string, q: string): Promise<Hit[]> {
  const junjo = gameClient(gameId);
  const [byId, byName] = await Promise.all([
    junjo.identities.list(q as UserId).catch(() => []),
    junjo.identities.findByName(q).catch(() => []),
  ]);
  const hits = new Map<string, Hit>();
  for (const i of byId) {
    hits.set(i.userId, {
      userId: i.userId,
      displayName: i.displayName,
      note: i.userId === q ? "exact id" : `linked to ${q}`,
    });
  }
  for (const m of byName) {
    if (!hits.has(m.userId)) {
      hits.set(m.userId, { userId: m.userId, displayName: m.displayName, note: "display name" });
    }
  }
  return [...hits.values()];
}

// Players who appear most recently in the game's audit log.
async function recentPlayers(gameId: string): Promise<{ userId: string; at: string }[]> {
  const page = await fetchAdminGameAudit(gameId, { limit: 100 });
  const seen = new Map<string, string>();
  for (const e of page.items) {
    if (!e.targetId) continue;
    if (!/^(member|game\.user|identity|permission\.override)\./.test(e.action)) continue;
    if (!seen.has(e.targetId)) seen.set(e.targetId, e.createdAt);
  }
  return [...seen.entries()].slice(0, 20).map(([userId, at]) => ({ userId, at }));
}

export default async function PlayersPage(props: PageProps) {
  const { gameId } = await props.params;
  const { q: rawQ } = await props.searchParams;
  const q = (rawQ ?? "").trim();
  const base = `/games/${encodeURIComponent(gameId)}/players`;

  let hits: Hit[] | null = null;
  let recent: { userId: string; at: string }[] = [];
  let failure: string | null = null;
  try {
    if (q) hits = await search(gameId, q);
    else recent = await recentPlayers(gameId);
  } catch (err) {
    failure =
      err instanceof AdminDisabledError
        ? "Set JUNJO_ADMIN_TOKEN on the dashboard and the server to look up players."
        : err instanceof Error
          ? err.message
          : "The lookup failed.";
  }

  return (
    <>
      <PageHeader title="Players" />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-3xl flex-col gap-8">
          <form action={base} className="flex gap-2">
            <div className="relative flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                name="q"
                defaultValue={q}
                placeholder="Id or display name"
                aria-label="Id or display name"
                className="pl-9"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <Button type="submit">Find player</Button>
          </form>

          {failure ? <Notice title="Could not look up players" body={failure} /> : null}

          {hits !== null ? (
            <Section title={`Results for ${q}`}>
              {hits.length === 0 ? (
                <Notice
                  title="No player matches"
                  body={
                    <>
                      Names match whole and ignore case. To open an id the game has never seen,{" "}
                      <Link
                        href={`${base}/${encodeURIComponent(q)}`}
                        className="text-primary hover:underline"
                      >
                        open {q} anyway
                      </Link>
                      .
                    </>
                  }
                />
              ) : (
                <ul className="divide-y divide-border/60">
                  {hits.map((h) => (
                    <li key={h.userId}>
                      <Link
                        href={`${base}/${encodeURIComponent(h.userId)}`}
                        className="flex items-baseline justify-between gap-4 py-2.5 hover:bg-accent/40"
                      >
                        <span className="min-w-0">
                          <span className="font-medium">{h.displayName ?? h.userId}</span>
                          {h.displayName ? (
                            <span className="ml-3 break-all font-mono text-xs text-muted-foreground">
                              {h.userId}
                            </span>
                          ) : null}
                        </span>
                        <span className="shrink-0 text-xs text-muted-foreground">{h.note}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : !failure ? (
            <Section title="Recently active">
              {recent.length === 0 ? (
                <Notice title="No player activity yet" />
              ) : (
                <ul className="divide-y divide-border/60">
                  {recent.map((r) => (
                    <li key={r.userId}>
                      <Link
                        href={`${base}/${encodeURIComponent(r.userId)}`}
                        className="flex items-baseline justify-between gap-4 py-2 hover:bg-accent/40"
                      >
                        <span className="break-all font-mono text-sm">{r.userId}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {relativeTime(r.at)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          ) : null}
        </div>
      </main>
    </>
  );
}
