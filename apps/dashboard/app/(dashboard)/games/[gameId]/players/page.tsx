// @license All Rights Reserved (see apps/dashboard/LICENSE)
import { Search } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "../../../../../components/dashboard/page-header";
import { Button } from "../../../../../components/ui/button";
import { Input } from "../../../../../components/ui/input";
import { Notice } from "../../../../../components/ui/section";
import { relativeTime } from "../../../../../lib/activity";
import {
  ADMIN_PLAYERS_PAGE_SIZE,
  AdminDisabledError,
  type AdminPlayer,
  type AdminPlayerList,
  type AdminPlayerSort,
  type AdminPlayerStanding,
  fetchAdminGamePlayers,
} from "../../../../../lib/admin";
import { until } from "../../../../../lib/moderation";

export const metadata = {
  title: "Players | Junjo Dashboard",
};

interface PageProps {
  params: Promise<{ gameId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}

const SORTS: readonly { value: AdminPlayerSort; label: string }[] = [
  { value: "firstSeen", label: "First seen" },
  { value: "lastActivity", label: "Last activity" },
  { value: "name", label: "Name" },
];

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const SELECT = "h-9 rounded-md border border-input bg-background px-2.5 text-sm text-foreground";

function Standing({ p }: { p: AdminPlayer }) {
  if (!p.ban && p.sanctions.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {p.ban ? (
        <span
          className="rounded-sm border border-destructive/50 bg-destructive/10 px-1.5 text-xs text-destructive"
          title={`${p.ban.reason ?? "No reason"}, ${until(p.ban.expiresAt)}`}
        >
          banned
        </span>
      ) : null}
      {p.sanctions.map((s) => (
        <span
          key={s.type}
          className="rounded-sm border border-warn/50 bg-warn/10 px-1.5 font-mono text-xs"
          title={until(s.expiresAt)}
        >
          {s.type}
        </span>
      ))}
    </span>
  );
}

export default async function PlayersPage(props: PageProps) {
  const { gameId } = await props.params;
  const sp = await props.searchParams;
  const q = (sp.q ?? "").trim();
  const namespace = (sp.namespace ?? "").trim();
  const standing =
    sp.standing === "banned" || sp.standing === "sanctioned"
      ? (sp.standing as AdminPlayerStanding)
      : undefined;
  const sort = SORTS.some((s) => s.value === sp.sort) ? (sp.sort as AdminPlayerSort) : "firstSeen";
  const order = sp.order === "asc" ? "asc" : "desc";
  const page = Math.max(0, Number.parseInt(sp.page ?? "0", 10) || 0);
  const base = `/games/${encodeURIComponent(gameId)}/players`;

  let list: AdminPlayerList | null = null;
  let failure: string | null = null;
  try {
    list = await fetchAdminGamePlayers(gameId, {
      q: q || undefined,
      namespace: namespace || undefined,
      standing,
      sort,
      order,
      limit: ADMIN_PLAYERS_PAGE_SIZE,
      offset: page * ADMIN_PLAYERS_PAGE_SIZE,
    });
  } catch (err) {
    failure =
      err instanceof AdminDisabledError
        ? "Set JUNJO_ADMIN_TOKEN on the dashboard and the server to list players."
        : err instanceof Error
          ? err.message
          : "The players request failed.";
  }

  // The current filters with one change, as a query string.
  const href = (change: Record<string, string | number | undefined>) => {
    const next = new URLSearchParams();
    const merged: Record<string, string | number | undefined> = {
      q: q || undefined,
      namespace: namespace || undefined,
      standing,
      sort: sort === "firstSeen" ? undefined : sort,
      order: order === "desc" ? undefined : order,
      page: page || undefined,
      ...change,
    };
    for (const [k, v] of Object.entries(merged))
      if (v !== undefined && v !== "") next.set(k, String(v));
    const qs = next.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const filtered = Boolean(q || namespace || standing);
  const pages = list ? Math.max(1, Math.ceil(list.total / ADMIN_PLAYERS_PAGE_SIZE)) : 1;

  return (
    <>
      <PageHeader
        title="Players"
        meta={
          list
            ? `${list.total.toLocaleString("en-US")} ${filtered ? "matching" : "in this game"}`
            : undefined
        }
      />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-screen-xl flex-col gap-5">
          <form action={base} className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[16rem] flex-1">
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
            <Input
              name="namespace"
              defaultValue={namespace}
              placeholder="namespace"
              aria-label="Namespace"
              className="w-32 font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <select
              name="standing"
              defaultValue={standing ?? ""}
              aria-label="Standing"
              className={SELECT}
            >
              <option value="">Any standing</option>
              <option value="banned">Banned</option>
              <option value="sanctioned">Sanctioned</option>
            </select>
            <select name="sort" defaultValue={sort} aria-label="Sort by" className={SELECT}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select name="order" defaultValue={order} aria-label="Order" className={SELECT}>
              <option value="desc">{sort === "name" ? "Z to A" : "Newest first"}</option>
              <option value="asc">{sort === "name" ? "A to Z" : "Oldest first"}</option>
            </select>
            <Button type="submit">Apply</Button>
            {filtered ? (
              <Link href={base} className="text-sm text-muted-foreground hover:text-foreground">
                Clear
              </Link>
            ) : null}
          </form>

          {failure ? <Notice title="Could not load players" body={failure} /> : null}

          {list && list.items.length === 0 ? (
            filtered ? (
              <Notice
                title="No player matches"
                body={
                  q ? (
                    <>
                      To open an id the game has never seen,{" "}
                      <Link
                        href={`${base}/${encodeURIComponent(q)}`}
                        className="text-primary hover:underline"
                      >
                        open {q} anyway
                      </Link>
                      .
                    </>
                  ) : (
                    "Clear the filters to see everyone."
                  )
                }
              />
            ) : (
              <Notice
                title="No players yet"
                body="Players appear once your game sends their ids."
              />
            )
          ) : null}

          {list && list.items.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Player</th>
                      <th className="hidden py-2 pr-4 font-medium lg:table-cell">Ids</th>
                      <th className="py-2 pr-4 text-right font-medium">Groups</th>
                      <th className="py-2 pr-4 font-medium">Standing</th>
                      <th className="hidden py-2 pr-4 font-medium md:table-cell">First seen</th>
                      <th className="py-2 font-medium">Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.items.map((p) => {
                      const primary = p.userIds[0]?.userId ?? p.personId;
                      return (
                        <tr
                          key={p.personId}
                          className="border-b border-border/60 last:border-0 hover:bg-accent/40"
                        >
                          <td className="py-2 pr-4">
                            <Link href={`${base}/${encodeURIComponent(primary)}`} className="block">
                              <span className="font-medium hover:underline">
                                {p.displayName ?? primary}
                              </span>
                              {p.displayName ? (
                                <span className="block break-all font-mono text-xs text-muted-foreground">
                                  {primary}
                                </span>
                              ) : null}
                            </Link>
                          </td>
                          <td className="hidden py-2 pr-4 lg:table-cell">
                            <span className="flex flex-wrap gap-1">
                              {p.userIds.map((id) => (
                                <span
                                  key={id.userId}
                                  title={id.userId}
                                  className="rounded-sm border border-border px-1.5 font-mono text-xs text-muted-foreground"
                                >
                                  {id.namespace ?? "id"}
                                </span>
                              ))}
                            </span>
                          </td>
                          <td className="py-2 pr-4 text-right">{p.activeGroupCount}</td>
                          <td className="py-2 pr-4">
                            <Standing p={p} />
                          </td>
                          <td className="hidden py-2 pr-4 text-muted-foreground md:table-cell">
                            {dateFormat.format(new Date(p.firstSeenAt))}
                          </td>
                          <td className="py-2 text-muted-foreground">
                            {p.lastActivityAt ? relativeTime(p.lastActivityAt) : "-"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Page {page + 1} of {pages}
                </span>
                <span className="flex gap-2">
                  {page > 0 ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={href({ page: page - 1 || undefined })}>Previous</Link>
                    </Button>
                  ) : null}
                  {page + 1 < pages ? (
                    <Button asChild variant="outline" size="sm">
                      <Link href={href({ page: page + 1 })}>Next</Link>
                    </Button>
                  ) : null}
                </span>
              </div>
            </>
          ) : null}
        </div>
      </main>
    </>
  );
}
