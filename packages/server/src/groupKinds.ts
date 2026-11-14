import type {
  GameId,
  GroupDeletedEvent,
  GroupId,
  GroupKindLimits,
  PartialGameConfig,
} from "@junjo.io/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import { resolveGameConfig } from "./config/defaults.js";
import type { Db } from "./db.js";
import { Errors } from "./errors.js";
import type { EventHub } from "./eventHub.js";
import { publishStagedEvents, stageEvent } from "./events.js";
import { logger } from "./logger.js";
import { SOFT_DELETE_RETENTION_DAYS } from "./softDelete.js";

type Tx = Prisma.TransactionClient;

// The group fields the membership helpers read.
export interface MembershipGroup {
  id: string;
  gameId: string;
  kind: string;
}

export type KindLimitFailure = "group_full" | "group_limit_reached";

// The limits configured for `kind` in the game, or null when the kind is
// not listed. Read without a lock: a config change racing a membership
// write applies from the next write on.
export async function loadKindLimits(
  db: Db,
  gameId: string,
  kind: string,
): Promise<GroupKindLimits | null> {
  const game = await db.game.findUnique({ where: { id: gameId }, select: { config: true } });
  const kinds = resolveGameConfig(game?.config as PartialGameConfig | null).groups.kinds;
  return Object.hasOwn(kinds, kind) ? (kinds[kind] ?? null) : null;
}

// Locks the group row until the transaction ends. Every transaction that
// changes who is an active member of a group takes this lock before it
// touches any member row, so member counts are read under the lock, the
// lock order is always group before member, and two writers cannot
// deadlock between the two. `FOR NO KEY UPDATE` leaves foreign-key
// checks from member inserts unblocked. A group soft-deleted since the
// caller loaded it answers 404, as it would have before the load.
export async function lockGroupMembership(tx: Tx, groupId: string): Promise<MembershipGroup> {
  const rows = await tx.$queryRaw<
    { id: string; gameId: string; kind: string; softDeletedAt: Date | null }[]
  >(Prisma.sql`
    SELECT id, "gameId", kind, "softDeletedAt" FROM "Group"
    WHERE id = ${groupId}
    FOR NO KEY UPDATE
  `);
  const row = rows[0];
  if (!row || row.softDeletedAt !== null) throw Errors.notFound("group");
  return { id: row.id, gameId: row.gameId, kind: row.kind };
}

// For each person in `activating` (people about to become active members
// of `group`, none of them active in it now), the limit their activation
// would break, if any. `activating` is in request order: when the group
// has room for only some of them, the earliest get it. Requires
// `lockGroupMembership` on the group earlier in the transaction.
//
// `maxPerUser` counts memberships in other live groups of the same kind,
// so it is serialized per (game, kind, person) with a transaction-scoped
// advisory lock taken in a fixed order; two writes activating one person
// in two groups therefore see each other's committed membership.
export async function kindLimitFailures(
  tx: Tx,
  group: MembershipGroup,
  limits: GroupKindLimits | null,
  activating: readonly string[],
): Promise<Map<string, KindLimitFailure>> {
  const failures = new Map<string, KindLimitFailure>();
  if (!limits || activating.length === 0) return failures;
  const people = [...new Set(activating)];

  if (limits.maxPerUser !== undefined) {
    await lockPerUserCounts(tx, group.gameId, [group.kind], people);
    const held = await tx.$queryRaw<{ junjoUserId: string; n: bigint }[]>(Prisma.sql`
      SELECT m."junjoUserId", COUNT(*) AS n
      FROM "GroupMember" m
      JOIN "Group" g ON g.id = m."groupId"
      WHERE g."gameId" = ${group.gameId}
        AND g.kind = ${group.kind}
        AND g."softDeletedAt" IS NULL
        AND g.id <> ${group.id}
        AND m.status = 'active'
        AND m."junjoUserId" = ANY(${people}::text[])
      GROUP BY m."junjoUserId"
    `);
    for (const row of held) {
      if (Number(row.n) >= limits.maxPerUser) failures.set(row.junjoUserId, "group_limit_reached");
    }
  }

  if (limits.maxMembers !== undefined) {
    const active = await tx.groupMember.count({ where: { groupId: group.id, status: "active" } });
    let room = limits.maxMembers - active;
    for (const person of people) {
      if (failures.has(person)) continue;
      if (room > 0) room -= 1;
      else failures.set(person, "group_full");
    }
  }
  return failures;
}

// The per-(game, kind, person) advisory locks that serialize `maxPerUser`
// counts, taken in one sorted order by every caller so that two writers
// cannot deadlock on them. JSON keeps the three parts unambiguous.
// Re-taking a key the transaction already holds returns at once.
export async function lockPerUserCounts(
  tx: Tx,
  gameId: string,
  kinds: readonly string[],
  people: readonly string[],
): Promise<void> {
  const keys: string[] = [];
  for (const kind of kinds) {
    for (const person of people) keys.push(JSON.stringify([gameId, kind, person]));
  }
  keys.sort();
  for (const key of keys) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
}

// Kinds whose `maxPerUser` one person holding the active memberships of
// all of `people` would exceed, in kind order. Counts distinct live
// groups, so a group several of them are active in counts once, which is
// what a merge leaves behind. `maxMembers` needs no check here: merging
// moves memberships that every group already counts.
export async function mergedPerUserOverflow(
  tx: Tx,
  gameId: string,
  people: readonly string[],
): Promise<string[]> {
  const game = await tx.game.findUnique({ where: { id: gameId }, select: { config: true } });
  const kinds = resolveGameConfig(game?.config as PartialGameConfig | null).groups.kinds;
  const capped = Object.entries(kinds)
    .filter(([, limits]) => limits?.maxPerUser !== undefined)
    .map(([kind]) => kind)
    .sort();
  if (capped.length === 0 || people.length === 0) return [];
  await lockPerUserCounts(tx, gameId, capped, [...new Set(people)]);
  const rows = await tx.$queryRaw<{ kind: string; n: bigint }[]>(Prisma.sql`
    SELECT g.kind, COUNT(DISTINCT g.id) AS n
    FROM "GroupMember" m
    JOIN "Group" g ON g.id = m."groupId"
    WHERE g."gameId" = ${gameId}
      AND g."softDeletedAt" IS NULL
      AND g.kind = ANY(${capped}::text[])
      AND m.status = 'active'
      AND m."junjoUserId" = ANY(${[...people]}::text[])
    GROUP BY g.kind
  `);
  return rows
    .filter((row) => Number(row.n) > (kinds[row.kind]?.maxPerUser ?? Number.POSITIVE_INFINITY))
    .map((row) => row.kind)
    .sort();
}

// Throws the matching 409 when `junjoUserId` may not become an active
// member of `group`. The single-person form of `kindLimitFailures`.
export async function assertCanActivate(
  tx: Tx,
  group: MembershipGroup,
  limits: GroupKindLimits | null,
  junjoUserId: string,
): Promise<void> {
  const failure = (await kindLimitFailures(tx, group, limits, [junjoUserId])).get(junjoUserId);
  if (failure === "group_full") throw Errors.groupFull();
  if (failure === "group_limit_reached") throw Errors.groupLimitReached();
}

// Timestamps are written as UTC wall time, the form Prisma stores in
// `timestamp(3)` columns, whatever the session time zone is.
function utc(now: Date): Prisma.Sql {
  return Prisma.sql`(${now.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

// Moves the group's membership activity clock to `now`. Written with a
// raw statement so the group's `updatedAt`, which tracks edits to the
// group itself, stays put.
export async function touchMemberActivity(
  tx: Tx,
  groupId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`UPDATE "Group" SET "memberActivityAt" = ${utc(now)} WHERE id = ${groupId}`,
  );
}

// Soft-deletes the group in the caller's transaction, writes the same
// audit entry as `DELETE /v1/groups/:id` (with `reason`), and stages
// `group.deleted`. The caller publishes the event after commit.
export async function softDeleteGroupInTx(
  tx: Tx,
  group: MembershipGroup,
  reason: "empty" | "idle",
  now: Date = new Date(),
): Promise<GroupDeletedEvent> {
  await tx.group.update({ where: { id: group.id }, data: { softDeletedAt: now } });
  await tx.auditEntry.create({
    data: {
      gameId: group.gameId,
      groupId: group.id,
      actorUserId: null,
      action: "group.deleted",
      targetId: group.id,
      payload: {
        kind: "soft",
        softDeletedAt: now.toISOString(),
        retentionDays: SOFT_DELETE_RETENTION_DAYS,
        reason,
      } as Prisma.InputJsonValue,
    },
  });
  return stageEvent<GroupDeletedEvent>(tx, {
    type: "group.deleted",
    gameId: group.gameId as GameId,
    groupId: group.id as GroupId,
    actorUserId: null,
  });
}

// Records that a write changed who is an active member of `group`: moves
// the activity clock and, when someone left and the kind deletes empty
// groups, soft-deletes the group once no active member remains. Returns
// the staged `group.deleted`, or null. Requires `lockGroupMembership`.
export async function afterMembershipChange(
  tx: Tx,
  group: MembershipGroup,
  limits: GroupKindLimits | null,
  departed: boolean,
): Promise<GroupDeletedEvent | null> {
  const now = new Date();
  await touchMemberActivity(tx, group.id, now);
  if (!departed || !limits?.deleteWhenEmpty) return null;
  const remaining = await tx.groupMember.count({ where: { groupId: group.id, status: "active" } });
  if (remaining > 0) return null;
  return softDeleteGroupInTx(tx, group, "empty", now);
}

// =====================================================================
// Idle-group sweeper
// =====================================================================

export const IDLE_GROUP_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const IDLE_SWEEP_BATCH = 100;

// Soft-deletes every live group whose kind sets `idleDeleteHours` and
// whose membership has not changed for that long, one transaction per
// group; each stages `group.deleted`, published after its commit. The
// idle condition is re-read under the group lock, so a membership change
// racing the sweep keeps the group. Returns the number deleted.
export async function sweepIdleGroups(
  prisma: PrismaClient,
  hub: EventHub,
  opts: { now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const games = await prisma.$queryRaw<{ id: string; config: unknown }[]>(Prisma.sql`
    SELECT id, config FROM "Game"
    WHERE jsonb_typeof(config->'groups'->'kinds') = 'object'
  `);
  let total = 0;
  for (const game of games) {
    const kinds = resolveGameConfig(game.config as PartialGameConfig | null).groups.kinds;
    for (const [kind, limits] of Object.entries(kinds)) {
      if (limits.idleDeleteHours === undefined) continue;
      const cutoff = new Date(now.getTime() - limits.idleDeleteHours * 60 * 60 * 1000);
      for (;;) {
        const batch = await prisma.group.findMany({
          where: { gameId: game.id, kind, softDeletedAt: null, memberActivityAt: { lt: cutoff } },
          select: { id: true },
          orderBy: { memberActivityAt: "asc" },
          take: IDLE_SWEEP_BATCH,
        });
        let deleted = 0;
        for (const { id } of batch) {
          const event = await prisma.$transaction(async (tx) => {
            const rows = await tx.$queryRaw<
              { memberActivityAt: Date; softDeletedAt: Date | null }[]
            >(
              Prisma.sql`
                SELECT "memberActivityAt", "softDeletedAt" FROM "Group"
                WHERE id = ${id}
                FOR NO KEY UPDATE
              `,
            );
            const row = rows[0];
            if (!row || row.softDeletedAt !== null || row.memberActivityAt >= cutoff) return null;
            return softDeleteGroupInTx(tx, { id, gameId: game.id, kind }, "idle", now);
          });
          if (event) {
            publishStagedEvents(hub, event);
            deleted += 1;
          }
        }
        total += deleted;
        // A short batch is the last one; a batch whose groups all turned
        // active again would otherwise be selected forever.
        if (batch.length < IDLE_SWEEP_BATCH || deleted === 0) break;
      }
    }
  }
  return total;
}

export function startIdleGroupSweeper(
  prisma: PrismaClient,
  hub: EventHub,
  opts: { intervalMs?: number } = {},
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? IDLE_GROUP_SWEEP_INTERVAL_MS;
  const tick = async () => {
    try {
      const removed = await sweepIdleGroups(prisma, hub);
      if (removed > 0) logger.info({ removed }, "soft-deleted idle groups");
    } catch (err) {
      logger.error({ err }, "idle group sweep failed");
    }
  };
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
