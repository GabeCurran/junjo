import type { JunjoEvent } from "@junjo.io/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./db.js";
import { Errors } from "./errors.js";
import { logger } from "./logger.js";
import { serializeEventForStorage } from "./webhooks.js";

export const EVENT_LOG_RETENTION_HOURS = 24;
export const EVENT_LOG_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const SWEEP_BATCH = 5_000;

// One logged event. `event` is the emitted payload after a JSON round
// trip, so its dates are ISO strings, exactly as the wire carries them.
export interface LoggedEvent {
  seq: bigint;
  type: string;
  event: JunjoEvent;
}

// Per-transaction state of a transaction opened through `withEventLog`:
// the events it staged, which are written as its last statements so the
// per-game counter lock is held only for the commit (taking it at stage
// time would hold it across the rest of the transaction and let two
// writers in one game deadlock on rows they each touch afterwards), and
// the group versions it asked for.
interface TxLog {
  events: JunjoEvent[];
  groups: Map<string, GroupVersionHandle>;
}

const pending = new WeakMap<object, TxLog>();

// A group's version as a transaction sees it. `expected`, when set, is
// the precondition: the transaction fails with 412 unless the group's
// version is still this when its events are logged. `value` is filled
// in as the transaction ends: the version its own events gave the group,
// or the current one when it logged none for it.
export interface GroupVersionHandle {
  readonly gameId: string;
  readonly groupId: string;
  expected: bigint | null;
  value: bigint | null;
}

// Asks the current `withEventLog` transaction for `groupId`'s version,
// optionally on the precondition that it is still `expected` (see
// `GroupVersionHandle`). The check runs while the game's counter row is
// locked, after every other write in the game that committed first, so
// two conditional writers can never both pass on the same version.
export function trackGroupVersion(
  tx: Db,
  gameId: string,
  groupId: string,
  expected: bigint | null,
): GroupVersionHandle {
  const log = pending.get(tx);
  if (!log) throw new Error("trackGroupVersion needs a transaction opened through withEventLog");
  const existing = log.groups.get(groupId);
  if (!existing) {
    const handle: GroupVersionHandle = { gameId, groupId, expected, value: null };
    log.groups.set(groupId, handle);
    return handle;
  }
  if (expected !== null) {
    if (existing.expected !== null && existing.expected !== expected) {
      throw groupVersionMismatch(groupId, expected, existing.expected);
    }
    existing.expected = expected;
  }
  return existing;
}

function groupVersionMismatch(groupId: string, expected: bigint, current: bigint | null) {
  const shown = current === null ? "" : ` (current "${current}")`;
  return Errors.preconditionFailed(
    `If-Match "${expected}" does not match group ${groupId}'s version${shown}`,
    current === null ? undefined : { version: current.toString() },
  );
}

// The versions of `groupIds`; a group no logged event has touched yet is
// at version 0.
export async function readGroupVersions(
  db: Db,
  groupIds: readonly string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>(groupIds.map((id) => [id, 0n]));
  if (groupIds.length === 0) return out;
  const rows = await db.groupVersion.findMany({
    where: { groupId: { in: [...groupIds] } },
    select: { groupId: true, seq: true },
  });
  for (const r of rows) out.set(r.groupId, r.seq);
  return out;
}

export async function readGroupVersion(db: Db, groupId: string): Promise<bigint> {
  return (await readGroupVersions(db, [groupId])).get(groupId) ?? 0n;
}

// Logs `events`. Inside a `withEventLog` transaction the write is
// deferred to the end of that transaction; otherwise it happens now, in
// a transaction of its own when the client can open one.
export async function recordEvents(db: Db, events: readonly JunjoEvent[]): Promise<void> {
  if (events.length === 0) return;
  const log = pending.get(db);
  if (log) {
    log.events.push(...events);
    return;
  }
  const client = db as unknown as { $transaction?: unknown };
  if (typeof client.$transaction === "function") {
    await (db as PrismaClient).$transaction((tx) => writeEventLog(tx, events, new Map()));
  } else {
    await writeEventLog(db, events, new Map());
  }
}

function eventGroupId(event: JunjoEvent): string | null {
  const groupId = (event as { groupId?: unknown }).groupId;
  return typeof groupId === "string" ? groupId : null;
}

// Per game, in game id order so lock acquisition order is stable: takes
// the counter row lock and allocates the positions, checks the group
// version preconditions of that game under the lock, then inserts the
// log rows and moves each touched group's version to its last event.
// A group whose deletion is logged here and whose row is gone loses its
// version row in the same statement. Handles in `groups` are filled with
// the versions this write gave their groups.
async function writeEventLog(
  db: Db,
  events: readonly JunjoEvent[],
  groups: ReadonlyMap<string, GroupVersionHandle>,
): Promise<void> {
  const byGame = new Map<string, JunjoEvent[]>();
  for (const event of events) {
    const list = byGame.get(event.gameId);
    if (list) list.push(event);
    else byGame.set(event.gameId, [event]);
  }
  for (const gameId of [...byGame.keys()].sort()) {
    const list = byGame.get(gameId) as JunjoEvent[];
    const count = list.length;
    const allocated = await db.$queryRaw<{ seq: bigint }[]>`
      INSERT INTO "GameEventCounter" ("gameId", "seq") VALUES (${gameId}, ${count}::bigint)
      ON CONFLICT ("gameId") DO UPDATE SET "seq" = "GameEventCounter"."seq" + EXCLUDED."seq"
      RETURNING "seq"
    `;
    const last = allocated[0]?.seq;
    if (last === undefined) throw new Error("event counter returned no row");
    const first = last - BigInt(count) + 1n;

    const checks = [...groups.values()].filter((h) => h.gameId === gameId && h.expected !== null);
    if (checks.length > 0) {
      const current = await readGroupVersions(
        db,
        checks.map((h) => h.groupId),
      );
      for (const h of checks) {
        const now = current.get(h.groupId) ?? 0n;
        if (now !== h.expected) throw groupVersionMismatch(h.groupId, h.expected as bigint, now);
      }
    }

    const versions = new Map<string, bigint>();
    const deleted = new Set<string>();
    list.forEach((event, i) => {
      const groupId = eventGroupId(event);
      if (groupId === null) return;
      versions.set(groupId, first + BigInt(i));
      if (event.type === "group.deleted") deleted.add(groupId);
    });
    const payloads = JSON.stringify(list.map((e) => serializeEventForStorage(e)));
    const touched = JSON.stringify(
      [...versions].map(([groupId, seq]) => ({ groupId, seq: seq.toString() })),
    );
    await db.$executeRaw`
      WITH logged AS (
        INSERT INTO "EventLog" ("gameId", "seq", "eventId", "type", "payload", "createdAt")
        SELECT ${gameId}, ${first}::bigint - 1 + e.ord, e.p->>'id', e.p->>'type', e.p,
          clock_timestamp()::timestamp
        FROM jsonb_array_elements(${payloads}::jsonb) WITH ORDINALITY AS e(p, ord)
      ),
      versioned AS (
        INSERT INTO "GroupVersion" ("groupId", "gameId", "seq")
        SELECT v."groupId", ${gameId}, v."seq"::bigint
        FROM jsonb_to_recordset(${touched}::jsonb) AS v("groupId" text, "seq" text)
        ON CONFLICT ("groupId") DO UPDATE
          SET "seq" = GREATEST("GroupVersion"."seq", EXCLUDED."seq")
      )
      SELECT 1
    `;
    if (deleted.size > 0) {
      await db.$executeRaw`
        DELETE FROM "GroupVersion" v
        WHERE v."groupId" = ANY(${[...deleted]}::text[])
          AND NOT EXISTS (SELECT 1 FROM "Group" g WHERE g.id = v."groupId")
      `;
    }
    for (const [groupId, seq] of versions) {
      const handle = groups.get(groupId);
      if (handle) handle.value = seq;
    }
  }
}

// Settles the version handles a transaction's own events did not fill:
// preconditions on groups it logged nothing for are checked against the
// stored version (nothing was written, so no lock is needed), and the
// handle reports that version.
async function settleGroupVersions(
  db: Db,
  groups: ReadonlyMap<string, GroupVersionHandle>,
): Promise<void> {
  const open = [...groups.values()].filter((h) => h.value === null);
  if (open.length === 0) return;
  const current = await readGroupVersions(
    db,
    open.map((h) => h.groupId),
  );
  for (const h of open) {
    const now = current.get(h.groupId) ?? 0n;
    if (h.expected !== null && now !== h.expected) {
      throw groupVersionMismatch(h.groupId, h.expected, now);
    }
    h.value = now;
  }
}

// Wraps a client so every interactive transaction it opens writes its
// staged events as its final statement. Batch transactions and every
// other member pass through unchanged. Clients without `$transaction`
// (test stand-ins) are returned as is.
export function withEventLog(client: PrismaClient): PrismaClient {
  const base = client as unknown as Record<PropertyKey, unknown>;
  if (typeof base.$transaction !== "function") return client;
  const original = (base.$transaction as (...args: unknown[]) => Promise<unknown>).bind(client);
  const transaction = (arg: unknown, options?: unknown): Promise<unknown> => {
    if (typeof arg !== "function") return original(arg, options);
    const fn = arg as (tx: Prisma.TransactionClient) => Promise<unknown>;
    return original(async (tx: Prisma.TransactionClient) => {
      const log: TxLog = { events: [], groups: new Map() };
      pending.set(tx, log);
      try {
        const result = await fn(tx);
        if (log.events.length > 0) await writeEventLog(tx, log.events, log.groups);
        await settleGroupVersions(tx, log.groups);
        return result;
      } finally {
        pending.delete(tx);
      }
    }, options);
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "$transaction") return transaction;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// The game's latest stream position; "0" before its first event. A
// snapshot read after this call reflects every event up to the returned
// position (and possibly some after it).
export async function readStreamPosition(db: Db, gameId: string): Promise<bigint> {
  const row = await db.gameEventCounter.findUnique({ where: { gameId }, select: { seq: true } });
  return row?.seq ?? 0n;
}

// True when the log still holds the event right after `position`.
// Rows are stamped with the statement clock at their commit-time insert,
// so ages follow position order closely; checking the exact next row
// rather than the oldest one also covers a row swept out of order.
export async function hasEventAfter(db: Db, gameId: string, position: bigint): Promise<boolean> {
  const row = await db.eventLog.findUnique({
    where: { gameId_seq: { gameId, seq: position + 1n } },
    select: { seq: true },
  });
  return row !== null;
}

// Up to `limit` logged events after `after`, in position order.
export async function readEventLog(
  db: Db,
  gameId: string,
  after: bigint,
  limit: number,
): Promise<LoggedEvent[]> {
  const rows = await db.eventLog.findMany({
    where: { gameId, seq: { gt: after } },
    orderBy: { seq: "asc" },
    take: limit,
    select: { seq: true, type: true, payload: true },
  });
  return rows.map((r) => {
    const event = r.payload as unknown as JunjoEvent;
    // Rows logged before events carried an origin read as unattributed.
    if (event.origin === undefined) event.origin = { apiKeyId: null, tag: null };
    return { seq: r.seq, type: r.type, event };
  });
}

// Deletes logged events older than the retention window in bounded
// batches. Age is measured against the database clock, which also
// stamped the rows. Returns the number of rows removed.
export async function sweepEventLog(
  prisma: PrismaClient,
  opts: { retentionHours?: number } = {},
): Promise<number> {
  const hours = opts.retentionHours ?? EVENT_LOG_RETENTION_HOURS;
  let total = 0;
  for (;;) {
    const removed = await prisma.$executeRaw`
      DELETE FROM "EventLog" WHERE ctid IN (
        SELECT ctid FROM "EventLog"
        WHERE "createdAt" < LOCALTIMESTAMP - make_interval(hours => ${hours}::int)
        LIMIT ${SWEEP_BATCH}
      )
    `;
    total += removed;
    if (removed < SWEEP_BATCH) return total;
  }
}

export function startEventLogSweeper(
  prisma: PrismaClient,
  opts: { intervalMs?: number; retentionHours?: number } = {},
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? EVENT_LOG_SWEEP_INTERVAL_MS;
  const tick = async () => {
    try {
      const removed = await sweepEventLog(prisma, { retentionHours: opts.retentionHours });
      if (removed > 0) logger.info({ removed }, "removed expired event log rows");
    } catch (err) {
      logger.error({ err }, "event log sweep failed");
    }
  };
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
