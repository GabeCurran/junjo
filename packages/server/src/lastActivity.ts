import { Prisma, type PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

// Keeps `ExternalIdentity.lastActivityAt` current from the audit log
// outside of any request. Each pass applies the entries after a stored
// (createdAt, id) cursor, a batch at a time, and raises the stored value
// of every identity an entry targets or whose person it names as actor
// in the entry's game.

export const LAST_ACTIVITY_INTERVAL_MS = 5_000;
export const LAST_ACTIVITY_BATCH_SIZE = 5_000;
// An entry whose transaction commits after the cursor has moved past
// its createdAt is invisible to the batch that moved it. Every batch
// also rereads the entries this far behind the cursor, which covers any
// transaction shorter than the window; the longest interactive
// transaction the server opens is allowed one minute. Rereading is
// harmless because values only rise.
export const LAST_ACTIVITY_OVERLAP_MS = 2 * 60_000;

const CURSOR_ID = "lastActivity";

// Below Postgres' default deadlock_timeout, so a batch waiting on an
// identity row a request holds gives up before deadlock detection would
// run, and under the default setting the request is not the one aborted.
// The batch rolls back and the next pass retries it.
const LOCK_TIMEOUT = "500ms";

export interface LastActivityOptions {
  batchSize?: number;
  overlapMs?: number;
}

export interface LastActivityBatch {
  // False when another runner holds the cursor; nothing was read.
  claimed: boolean;
  // Entries past the cursor applied by this batch.
  applied: number;
  // Entries in the overlap window behind the cursor read again.
  reread: number;
  // Identities whose stored value rose.
  raised: number;
}

interface BatchRow {
  claimed: number;
  applied: number;
  reread: number;
  raised: number;
}

// One batch in one statement. The cursor row is claimed with SKIP
// LOCKED, so concurrent runners never wait on each other and only one
// applies a given batch. Identity rows are locked in id order before
// they change, and rows already at or past the new value are neither
// locked nor written.
export async function catchUpLastActivityBatch(
  prisma: PrismaClient,
  opts: LastActivityOptions = {},
): Promise<LastActivityBatch> {
  const batchSize = opts.batchSize ?? LAST_ACTIVITY_BATCH_SIZE;
  const overlapMs = opts.overlapMs ?? LAST_ACTIVITY_OVERLAP_MS;
  // The estimated cost crosses the JIT threshold, and compiling costs
  // several times what the batch itself does, so JIT is off for it.
  const [, , rows] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`),
    prisma.$executeRaw`SET LOCAL jit = off`,
    prisma.$queryRaw<BatchRow[]>(Prisma.sql`
      WITH cursor AS MATERIALIZED (
        SELECT "createdAt" AS at, "auditId" AS id FROM "LastActivityCursor"
        WHERE id = ${CURSOR_ID}
        FOR UPDATE SKIP LOCKED
      ),
      fresh AS MATERIALIZED (
        SELECT a.id, a."createdAt", a."gameId", a."targetId", a."actorUserId"
        FROM cursor c
        CROSS JOIN LATERAL (
          SELECT e.id, e."createdAt", e."gameId", e."targetId", e."actorUserId"
          FROM "AuditEntry" e
          WHERE (e."createdAt", e.id) > (c.at, c.id)
          ORDER BY e."createdAt", e.id
          LIMIT ${batchSize}
        ) a
      ),
      reread AS MATERIALIZED (
        SELECT e."createdAt", e."gameId", e."targetId", e."actorUserId"
        FROM cursor c
        JOIN "AuditEntry" e
          ON e."createdAt" >= c.at - ${overlapMs}::float8 * interval '1 millisecond'
          AND (e."createdAt", e.id) <= (c.at, c.id)
      ),
      entries AS (
        SELECT "createdAt", "gameId", "targetId", "actorUserId" FROM fresh
        UNION ALL
        SELECT "createdAt", "gameId", "targetId", "actorUserId" FROM reread
      ),
      targets AS (
        SELECT "gameId", "targetId", max("createdAt") AS at
        FROM entries
        WHERE "targetId" IS NOT NULL
        GROUP BY "gameId", "targetId"
      ),
      actors AS (
        SELECT "gameId", "actorUserId", max("createdAt") AS at
        FROM entries
        WHERE "actorUserId" IS NOT NULL
        GROUP BY "gameId", "actorUserId"
      ),
      -- OFFSET 0 keeps each lookup a probe of the identity indexes per
      -- aggregated row; a batch names few identities next to the table.
      newest AS (
        SELECT h.id, max(h.at) AT TIME ZONE 'UTC' AS at
        FROM (
          SELECT i.id, t.at
          FROM targets t
          CROSS JOIN LATERAL (
            SELECT x.id FROM "ExternalIdentity" x
            WHERE x."gameId" = t."gameId" AND x."externalUserId" = t."targetId"
            OFFSET 0
          ) i
          UNION ALL
          SELECT i.id, a.at
          FROM actors a
          CROSS JOIN LATERAL (
            SELECT x.id FROM "ExternalIdentity" x
            WHERE x."gameId" = a."gameId" AND x."junjoUserId" = a."actorUserId"
            OFFSET 0
          ) i
        ) h
        GROUP BY h.id
      ),
      locked AS MATERIALIZED (
        SELECT i.id, n.at
        FROM "ExternalIdentity" i
        JOIN newest n ON n.id = i.id
        WHERE i."lastActivityAt" IS NULL OR i."lastActivityAt" < n.at
        ORDER BY i.id
        FOR NO KEY UPDATE OF i
      ),
      raised AS (
        UPDATE "ExternalIdentity" i
        SET "lastActivityAt" = GREATEST(COALESCE(i."lastActivityAt", '-infinity'), l.at)
        FROM locked l
        WHERE i.id = l.id
        RETURNING i.id
      ),
      moved AS (
        UPDATE "LastActivityCursor" k
        SET "createdAt" = f."createdAt", "auditId" = f.id
        FROM (
          SELECT "createdAt", id FROM fresh
          ORDER BY "createdAt" DESC, id DESC
          LIMIT 1
        ) f
        WHERE k.id = ${CURSOR_ID}
        RETURNING k.id
      )
      SELECT
        (SELECT count(*) FROM cursor)::int AS claimed,
        (SELECT count(*) FROM fresh)::int AS applied,
        (SELECT count(*) FROM reread)::int AS reread,
        (SELECT count(*) FROM raised)::int AS raised
    `),
  ]);
  const row = rows[0] as BatchRow;
  if (row.claimed === 0) {
    // Held by another runner, or missing. A missing cursor restarts at
    // the Unix epoch, before every entry, which rereads the log once.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO "LastActivityCursor" (id, "createdAt", "auditId")
      VALUES (${CURSOR_ID}, '1970-01-01', '')
      ON CONFLICT (id) DO NOTHING
    `);
  }
  return {
    claimed: row.claimed > 0,
    applied: row.applied,
    reread: row.reread,
    raised: row.raised,
  };
}

export interface LastActivityTotals {
  batches: number;
  applied: number;
  raised: number;
}

// Runs batches until one comes back short of a full batch, or another
// runner holds the cursor, or `shouldStop` answers true.
export async function catchUpLastActivity(
  prisma: PrismaClient,
  opts: LastActivityOptions & { shouldStop?: () => boolean } = {},
): Promise<LastActivityTotals> {
  const batchSize = opts.batchSize ?? LAST_ACTIVITY_BATCH_SIZE;
  const totals: LastActivityTotals = { batches: 0, applied: 0, raised: 0 };
  for (;;) {
    const batch = await catchUpLastActivityBatch(prisma, opts);
    if (!batch.claimed) return totals;
    totals.batches += 1;
    totals.applied += batch.applied;
    totals.raised += batch.raised;
    if (batch.applied < batchSize || opts.shouldStop?.()) return totals;
  }
}

// Every `intervalMs`, catches up from the cursor. 0 disables the job.
// Every server process may run it; the cursor claim keeps one runner at
// a time.
export function startLastActivityJob(
  prisma: PrismaClient,
  opts: LastActivityOptions & { intervalMs?: number } = {},
): { stop(): void } {
  const intervalMs = opts.intervalMs ?? LAST_ACTIVITY_INTERVAL_MS;
  if (intervalMs === 0) return { stop: () => {} };
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const totals = await catchUpLastActivity(prisma, { ...opts, shouldStop: () => stopped });
      if (totals.applied > 0) logger.debug(totals, "applied audit entries to last activity");
    } catch (err) {
      logger.warn({ err }, "last activity catch-up failed; retrying on the next tick");
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return {
    stop: () => {
      stopped = true;
      clearInterval(handle);
    },
  };
}
