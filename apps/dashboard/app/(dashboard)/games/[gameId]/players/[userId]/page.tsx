// @license All Rights Reserved (see apps/dashboard/LICENSE)
import type {
  Friendship,
  GroupId,
  Junjo,
  LinkedIdentity,
  Member,
  MemberAccess,
  SanctionHistoryEntry,
  UserId,
  UserModeration,
} from "@junjo.io/sdk";
import Link from "next/link";

import { ActivityLine } from "../../../../../../components/dashboard/activity-line";
import { PageHeader } from "../../../../../../components/dashboard/page-header";
import { Notice, Section } from "../../../../../../components/ui/section";
import { relativeTime } from "../../../../../../lib/activity";
import {
  type AdminAuditEntry,
  AdminDisabledError,
  type AdminGroup,
  type AdminRole,
  fetchAdminGameAudit,
  fetchAdminGroup,
  fetchAdminGroupRoles,
} from "../../../../../../lib/admin";
import { gameClient } from "../../../../../../lib/game-client";
import { until } from "../../../../../../lib/moderation";
import { MembershipPanel, type MembershipView } from "../membership-panel";
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

// Audit entries naming any of the person's ids, newest first.
async function loadActivity(gameId: string, ids: string[]): Promise<AdminAuditEntry[]> {
  const pages = await Promise.all(
    ids.map((targetId) =>
      fetchAdminGameAudit(gameId, { targetId, limit: 30 }, { revalidate: 0 })
        .then((p) => p.items)
        .catch(() => [] as AdminAuditEntry[]),
    ),
  );
  const byId = new Map<string, AdminAuditEntry>();
  for (const e of pages.flat()) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
}

function contextLabel(context: Record<string, string> | undefined): string | null {
  if (!context) return null;
  const pairs = Object.entries(context);
  return pairs.length === 0 ? null : pairs.map(([k, v]) => `${k}=${v}`).join(", ");
}

const numberFormat = new Intl.NumberFormat("en-US");

function Figure({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col-reverse">
      <dt className="mt-1 text-sm text-muted-foreground">{label}</dt>
      <dd className="font-condensed text-2xl font-semibold leading-none">{value}</dd>
    </div>
  );
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

  const junjo = gameClient(gameId);
  const allIds = identities.length > 0 ? identities.map((i) => i.userId as string) : [userId];
  const [groups, accessList, activity, friends] = await Promise.all([
    loadGroups(gameId, members),
    Promise.all(
      members.map((m) => junjo.members.getAccess(m.groupId as GroupId, m.userId).catch(() => null)),
    ),
    loadActivity(gameId, allIds),
    // Null when friends are off for the game.
    junjo.friends
      .list(userId, { limit: 100 })
      .then((p) => ({ items: p.items, more: p.nextCursor !== null }))
      .catch(() => null as { items: Friendship[]; more: boolean } | null),
  ]);
  const accessByGroup = new Map<string, MemberAccess>();
  for (const a of accessList) if (a) accessByGroup.set(a.groupId as string, a);
  const self = identities.find((i) => i.userId === userId);
  const name = self?.displayName ?? identities.find((i) => i.displayName)?.displayName ?? null;
  const history = historyRows(banHistory, sanctionHistory, groups);
  const base = `/games/${encodeURIComponent(gameId)}`;
  const firstSeen = identities.reduce<Date | null>(
    (min, i) => (min === null || i.linkedAt < min ? i.linkedAt : min),
    null,
  );
  const activeGroups = members.filter((m) => m.status === "active").length;
  const memberships: MembershipView[] = members
    .slice()
    .sort((a, b) => (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1))
    .map((m) => {
      const info = groups.get(m.groupId as string);
      const access = accessByGroup.get(m.groupId as string);
      const roleView = (id: string) => {
        const r = info?.roles.get(id);
        return { id, name: r?.name ?? id, color: r?.color ?? null };
      };
      return {
        groupId: m.groupId as string,
        groupName: info?.group?.name ?? (m.groupId as string),
        groupHref: `${base}/groups/${encodeURIComponent(m.groupId)}`,
        userId: m.userId,
        status: m.status,
        version: m.version,
        joinedAt: m.joinedAt.toISOString(),
        roles: m.roles.map((id) => roleView(id as string)),
        groupRoles: [...(info?.roles.values() ?? [])]
          .sort((a, b) => b.priority - a.priority)
          .map((r) => ({ id: r.id, name: r.name, color: r.color })),
        overrides: (access?.overrides ?? []).map((o) => ({
          permission: o.permission as string,
          value: o.grant,
          context: contextLabel(o.context),
        })),
        notesPublic: m.notesPublic,
        notesPrivate: m.notesPrivate,
        metadata: JSON.stringify(m.metadata ?? {}, null, 2),
      };
    });

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
          <dl className="flex flex-wrap gap-x-12 gap-y-4">
            <Figure value={firstSeen ? dateFormat.format(firstSeen) : "-"} label="first seen" />
            <Figure
              value={activity[0] ? relativeTime(activity[0].createdAt) : "-"}
              label="last activity"
            />
            <Figure value={numberFormat.format(activeGroups)} label="active groups" />
            <Figure
              value={
                friends === null
                  ? "off"
                  : `${numberFormat.format(friends.items.length)}${friends.more ? "+" : ""}`
              }
              label="friends"
            />
          </dl>
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

            <Section title="Friends">
              {friends === null ? (
                <Notice title="Friends are off for this game" />
              ) : friends.items.length === 0 ? (
                <Notice title="No friends yet" />
              ) : (
                <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-sm">
                  {friends.items.map((f) => (
                    <li key={f.id}>
                      <Link
                        href={`${base}/players/${encodeURIComponent(f.junjoUserId)}`}
                        className="hover:underline"
                      >
                        {f.displayName ?? (
                          <span className="font-mono text-xs">{f.junjoUserId}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>

          <Section title="Groups">
            {memberships.length === 0 ? (
              <Notice title="In no groups" />
            ) : (
              <ul className="divide-y divide-border/60">
                {memberships.map((m) => (
                  <MembershipPanel key={m.groupId} gameId={gameId} pagePlayerId={userId} m={m} />
                ))}
              </ul>
            )}
          </Section>

          <div className="grid gap-10 xl:grid-cols-2">
            <Section title="Activity">
              {activity.length === 0 ? (
                <Notice title="No activity on record" />
              ) : (
                <ul className="divide-y divide-border/60">
                  {activity.map((e) => (
                    <ActivityLine key={e.id} entry={e} />
                  ))}
                </ul>
              )}
            </Section>

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
        </div>
      </main>
    </>
  );
}
