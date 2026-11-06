// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type {
  Junjo,
  LinkedIdentity,
  Member,
  SanctionHistoryEntry,
  UserId,
  UserModeration,
} from "@junjo.io/sdk";
import Link from "next/link";

import { PageHeader } from "../../../../../../components/dashboard/page-header";
import { RoleChip } from "../../../../../../components/ui/role-chip";
import { Notice, Section } from "../../../../../../components/ui/section";
import {
  AdminDisabledError,
  type AdminGroup,
  type AdminRole,
  fetchAdminGroup,
  fetchAdminGroupRoles,
} from "../../../../../../lib/admin";
import { gameClient } from "../../../../../../lib/game-client";
import { until } from "../../../../../../lib/moderation";
import { DisplayNameField, PlayerModeration } from "../player-moderation";

interface PageProps {
  params: Promise<{ gameId: string; userId: string }>;
}

export async function generateMetadata(props: PageProps) {
  const { userId } = await props.params;
  return { title: `${decodeURIComponent(userId)} | Junjo Dashboard` };
}

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const dateTimeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type BanHistoryEntry = Awaited<ReturnType<Junjo["bans"]["history"]>>["items"][number];

interface GroupInfo {
  group: AdminGroup | null;
  roles: Map<string, AdminRole>;
}

async function loadGroups(gameId: string, members: Member[]): Promise<Map<string, GroupInfo>> {
  const ids = [...new Set(members.map((m) => m.groupId as string))];
  const entries = await Promise.all(
    ids.map(async (groupId): Promise<[string, GroupInfo]> => {
      const [group, roles] = await Promise.all([
        fetchAdminGroup(gameId, groupId).catch(() => null),
        fetchAdminGroupRoles(gameId, groupId).catch(() => [] as AdminRole[]),
      ]);
      return [groupId, { group, roles: new Map(roles.map((r) => [r.id, r])) }];
    }),
  );
  return new Map(entries);
}

type HistoryRow = {
  at: Date;
  key: string;
  text: string;
  detail: string | null;
  tone: "ban" | "lift" | "sanction";
};

function historyRows(
  bans: BanHistoryEntry[],
  sanctions: SanctionHistoryEntry[],
  groups: Map<string, GroupInfo>,
): HistoryRow[] {
  const rows: HistoryRow[] = [];
  for (const b of bans) {
    const where =
      b.scope === "group"
        ? (groups.get(b.groupId as string)?.group?.name ?? "a group")
        : "the game";
    const end = b.expiresAt ? until(b.expiresAt.toISOString()) : "with no end";
    rows.push({
      at: b.eventAt,
      key: `ban-${b.id}`,
      text: b.kind === "set" ? `Banned from ${where} ${end}` : `Ban lifted in ${where}`,
      detail: b.reason,
      tone: b.kind === "set" ? "ban" : "lift",
    });
  }
  for (const s of sanctions) {
    const end = s.expiresAt ? until(s.expiresAt.toISOString()) : "with no end";
    rows.push({
      at: s.eventAt,
      key: `sanction-${s.id}`,
      text: s.kind === "set" ? `${s.type} ${end}` : `${s.type} lifted`,
      detail: s.reason,
      tone: s.kind === "set" ? "sanction" : "lift",
    });
  }
  return rows.sort((a, b) => b.at.getTime() - a.at.getTime());
}

export default async function PlayerPage(props: PageProps) {
  const params = await props.params;
  const gameId = params.gameId;
  const userId = decodeURIComponent(params.userId) as UserId;

  let identities: LinkedIdentity[];
  let moderation: UserModeration;
  let members: Member[];
  let banHistory: BanHistoryEntry[];
  let sanctionHistory: SanctionHistoryEntry[];
  try {
    const junjo = gameClient(gameId);
    [identities, moderation, members, banHistory, sanctionHistory] = await Promise.all([
      junjo.identities.list(userId),
      junjo.bans.moderation(userId),
      junjo.members.listForUser(userId, { gameId: gameId as never }),
      junjo.bans.history(userId, { limit: 50 }).then((p) => p.items),
      junjo.sanctions.history(userId, { limit: 50 }).then((p) => p.items),
    ]);
  } catch (err) {
    return (
      <>
        <PageHeader title={userId} />
        <main className="flex-1 px-6 pb-12 pt-4">
          <Notice
            title={
              err instanceof AdminDisabledError
                ? "Cross-game access is off"
                : "Could not load this player"
            }
            body={
              err instanceof AdminDisabledError
                ? "Set JUNJO_ADMIN_TOKEN on the dashboard and the server to open players."
                : err instanceof Error
                  ? err.message
                  : "The player request failed."
            }
          />
        </main>
      </>
    );
  }

  const groups = await loadGroups(gameId, members);
  const self = identities.find((i) => i.userId === userId);
  const name = self?.displayName ?? identities.find((i) => i.displayName)?.displayName ?? null;
  const history = historyRows(banHistory, sanctionHistory, groups);
  const base = `/games/${encodeURIComponent(gameId)}`;

  return (
    <>
      <PageHeader
        title={name ?? userId}
        meta={
          <>
            {name ? <span className="font-mono">{userId}</span> : null}
            {name ? <span className="mx-2 text-border">/</span> : null}
            {identities.length === 0
              ? "never seen by this game"
              : identities.length === 1
                ? "1 id"
                : `${identities.length} linked ids`}
          </>
        }
      />
      <main className="flex-1 px-6 pb-12 pt-4">
        <div className="flex max-w-screen-xl flex-col gap-10">
          <Section title="Standing">
            <PlayerModeration
              gameId={gameId}
              userId={userId}
              version={moderation.version}
              ban={
                moderation.ban
                  ? {
                      reason: moderation.ban.reason,
                      bannedAt: moderation.ban.bannedAt.toISOString(),
                      expiresAt: moderation.ban.expiresAt?.toISOString() ?? null,
                      issuer: moderation.ban.issuer,
                    }
                  : null
              }
              sanctions={moderation.sanctions.map((s) => ({
                type: s.type,
                reason: s.reason,
                startedAt: s.startedAt.toISOString(),
                expiresAt: s.expiresAt?.toISOString() ?? null,
                issuer: s.issuer,
              }))}
            />
          </Section>

          <div className="grid gap-10 xl:grid-cols-2">
            <Section title="Ids">
              {identities.length === 0 ? (
                <Notice title="No ids yet" body="This id has never reached the game." />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Id</th>
                      <th className="py-2 pr-4 font-medium">Display name</th>
                      <th className="py-2 font-medium">Linked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {identities.map((i) => (
                      <tr key={i.userId} className="border-b border-border/60 last:border-0">
                        <td className="py-2 pr-4">
                          {i.userId === userId ? (
                            <span className="break-all font-mono text-xs">{i.userId}</span>
                          ) : (
                            <Link
                              href={`${base}/players/${encodeURIComponent(i.userId)}`}
                              className="break-all font-mono text-xs hover:underline"
                            >
                              {i.userId}
                            </Link>
                          )}
                        </td>
                        <td className="py-2 pr-4">
                          <DisplayNameField
                            gameId={gameId}
                            pagePlayerId={userId}
                            userId={i.userId}
                            value={i.displayName}
                          />
                        </td>
                        <td className="py-2 text-muted-foreground">
                          {dateFormat.format(i.linkedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section title="Groups">
              {members.length === 0 ? (
                <Notice title="In no groups" />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-4 font-medium">Group</th>
                      <th className="py-2 pr-4 font-medium">Roles</th>
                      <th className="py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => {
                      const info = groups.get(m.groupId as string);
                      return (
                        <tr key={m.id} className="border-b border-border/60 last:border-0">
                          <td className="py-2 pr-4">
                            <Link
                              href={`${base}/groups/${encodeURIComponent(m.groupId)}`}
                              className="font-medium hover:underline"
                            >
                              {info?.group?.name ?? m.groupId}
                            </Link>
                          </td>
                          <td className="py-2 pr-4">
                            <div className="flex flex-wrap gap-1">
                              {m.roles.length === 0 ? (
                                <span className="text-muted-foreground">-</span>
                              ) : (
                                m.roles.map((roleId) => {
                                  const role = info?.roles.get(roleId as string);
                                  return (
                                    <RoleChip
                                      key={roleId}
                                      name={role?.name ?? roleId}
                                      color={role?.color}
                                    />
                                  );
                                })
                              )}
                            </div>
                          </td>
                          <td className="py-2 capitalize text-muted-foreground">{m.status}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          <Section title="Moderation history">
            {history.length === 0 ? (
              <Notice title="Nothing on record" />
            ) : (
              <ul className="max-w-3xl divide-y divide-border/60">
                {history.map((h) => (
                  <li key={h.key} className="flex items-baseline gap-3 py-2 text-sm">
                    <span
                      aria-hidden
                      className={`mt-1.5 h-1.5 w-1.5 shrink-0 self-start rounded-full ${
                        h.tone === "ban"
                          ? "bg-destructive"
                          : h.tone === "sanction"
                            ? "bg-warn"
                            : "bg-allow"
                      }`}
                    />
                    <p className="min-w-0 flex-1">
                      <span className="font-medium">{h.text}</span>
                      {h.detail ? (
                        <span className="text-muted-foreground">: {h.detail}</span>
                      ) : null}
                    </p>
                    <time
                      dateTime={h.at.toISOString()}
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {dateTimeFormat.format(h.at)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </main>
    </>
  );
}
