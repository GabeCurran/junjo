import type { JunjoEvent } from "@junjo.io/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Db } from "./db.js";
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

// Events staged inside a transaction opened through `withEventLog`. They
// are written as the transaction's last statement, so the per-game
// counter lock is held only for the commit: taking it at stage time
// would hold it across the rest of the transaction and let two writers
// in one game deadlock on rows they each touch afterwards.
const pending = new WeakMap<object, JunjoEvent[]>();

// Logs `events`. Inside a `withEventLog` transaction the write is
// deferred to the end of that transaction; otherwise it happens now as
// a single statement.
export async function recordEvents(db: Db, events: readonly JunjoEvent[]): Promise<void> {
  if (events.length === 0) return;
  const queued = pending.get(db);
  if (queued) {
    queued.push(...events);
    return;
  }
  await writeEventLog(db, events);
}

// Allocates positions from the game's counter and inserts the rows in
// one statement per game, so the pair is atomic even without a
// surrounding transaction. Games are written in id order to keep lock
// acquisition order stable.
async function writeEventLog(db: Db, events: readonly JunjoEvent[]): Promise<void> {
  const byGame = new Map<string, JunjoEvent[]>();
  for (const event of events) {
    const list = byGame.get(event.gameId);
    if (list) list.push(event);
    else byGame.set(event.gameId, [event]);
  }
  for (const gameId of [...byGame.keys()].sort()) {
    const list = byGame.get(gameId) as JunjoEvent[];
    const payloads = JSON.stringify(list.map((e) => serializeEventForStorage(e)));
    const count = list.length;
    await db.$executeRaw`
      WITH c AS (
        INSERT INTO "GameEventCounter" ("gameId", "seq") VALUES (${gameId}, ${count}::bigint)
        ON CONFLICT ("gameId") DO UPDATE SET "seq" = "GameEventCounter"."seq" + EXCLUDED."seq"
        RETURNING "seq"
      )
      INSERT INTO "EventLog" ("gameId", "seq", "eventId", "type", "payload", "createdAt")
      SELECT ${gameId}, c."seq" - ${count}::bigint + e.ord, e.p->>'id', e.p->>'type', e.p,
        clock_timestamp()::timestamp
      FROM c, jsonb_array_elements(${payloads}::jsonb) WITH ORDINALITY AS e(p, ord)
    `;
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
      const queue: JunjoEvent[] = [];
      pending.set(tx, queue);
      try {
        const result = await fn(tx);
        if (queue.length > 0) await writeEventLog(tx, queue);
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
  return rows.map((r) => ({
    seq: r.seq,
    type: r.type,
    event: r.payload as unknown as JunjoEvent,
  }));
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
