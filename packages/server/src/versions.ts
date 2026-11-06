import { Prisma } from "@prisma/client";
import type { Context } from "hono";
import type { Db } from "./db.js";
import { Errors } from "./errors.js";

type Tx = Prisma.TransactionClient;

// Entity tags are the decimal version in double quotes, like a strong
// HTTP entity tag. `If-Match` accepts that form or the bare integer;
// any other value (lists, weak tags, `*`) is a 400 so a client bug
// cannot silently skip the precondition.
const QUOTED = /^"(\d{1,10})"$/;
const BARE = /^(\d{1,10})$/;
const MAX_VERSION = 2_147_483_647;

// The version an `If-Match` header names, or null when the header is
// absent. Throws 400 on any value that is not one version.
export function readIfMatch(c: Context): number | null {
  const raw = c.req.header("if-match");
  if (raw === undefined) return null;
  const value = raw.trim();
  const match = QUOTED.exec(value) ?? BARE.exec(value);
  const parsed = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed > MAX_VERSION) {
    throw Errors.badRequest('If-Match must be one version, quoted ("7") or bare (7)');
  }
  return parsed;
}

export function etagFor(version: number): string {
  return `"${version}"`;
}

export function setEtag(c: Context, version: number): void {
  c.header("ETag", etagFor(version));
}

// Throws 412 when a precondition was sent and does not name `current`.
export function assertVersion(expected: number | null, current: number): void {
  if (expected !== null && expected !== current) {
    throw Errors.preconditionFailed(
      `If-Match ${etagFor(expected)} does not match the current version ${etagFor(current)}`,
    );
  }
}

// =====================================================================
// Member version
// =====================================================================

// Locks the member row until the transaction ends and checks the
// precondition against the locked version. Writers that lock first
// serialize on the row, so the version compared is the one the write
// replaces. A missing row is a 404, never a 412.
export async function lockMemberVersion(
  tx: Tx,
  memberId: string,
  expected: number | null,
): Promise<number> {
  const row = await lockMember(tx, memberId);
  assertVersion(expected, row.version);
  return row.version;
}

// Locks the member row until the transaction ends and returns its
// current version and status. Writes that depend on the status decide
// from this read, not from one taken before the lock, so a concurrent
// write that changed the status first is seen.
export async function lockMember(
  tx: Tx,
  memberId: string,
): Promise<{ version: number; status: string }> {
  const rows = await tx.$queryRaw<{ version: number; status: string }[]>(
    Prisma.sql`SELECT version, status FROM "GroupMember" WHERE id = ${memberId} FOR UPDATE`,
  );
  const row = rows[0];
  if (!row) throw Errors.notFound("member");
  return row;
}

// Raises the member's version by one and returns the new value. Call at
// most once per write, after deciding the write changes something.
export async function bumpMemberVersion(tx: Tx, memberId: string): Promise<number> {
  const row = await tx.groupMember.update({
    where: { id: memberId },
    data: { version: { increment: 1 } },
    select: { version: true },
  });
  return row.version;
}

// =====================================================================
// Moderation version
// =====================================================================

export async function readModerationVersion(
  db: Db,
  gameId: string,
  junjoUserId: string,
): Promise<number> {
  const row = await db.moderationState.findUnique({
    where: { gameId_junjoUserId: { gameId, junjoUserId } },
    select: { version: true },
  });
  return row?.version ?? 0;
}

export async function readModerationVersions(
  db: Db,
  gameId: string,
  junjoUserIds: readonly string[],
): Promise<Map<string, number>> {
  if (junjoUserIds.length === 0) return new Map();
  const rows = await db.moderationState.findMany({
    where: { gameId, junjoUserId: { in: [...new Set(junjoUserIds)] } },
    select: { junjoUserId: true, version: true },
  });
  return new Map(rows.map((r) => [r.junjoUserId, r.version]));
}

// Locks the person's moderation row until the transaction ends (creating
// it at version 0 when absent) and checks the precondition against the
// locked version. Concurrent moderation writes for one person serialize
// here, including two first-ever writes, which meet on the primary key.
export async function lockModerationVersion(
  tx: Tx,
  gameId: string,
  junjoUserId: string,
  expected: number | null,
): Promise<number> {
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO "ModerationState" ("gameId", "junjoUserId", "version", "updatedAt")
    VALUES (${gameId}, ${junjoUserId}, 0, CURRENT_TIMESTAMP)
    ON CONFLICT ("gameId", "junjoUserId") DO NOTHING
  `);
  const rows = await tx.$queryRaw<{ version: number }[]>(Prisma.sql`
    SELECT version FROM "ModerationState"
    WHERE "gameId" = ${gameId} AND "junjoUserId" = ${junjoUserId}
    FOR UPDATE
  `);
  const current = rows[0]?.version ?? 0;
  assertVersion(expected, current);
  return current;
}

// Raises the person's moderation version by one and returns the new
// value. Requires `lockModerationVersion` earlier in the transaction.
export async function bumpModerationVersion(
  tx: Tx,
  gameId: string,
  junjoUserId: string,
): Promise<number> {
  const row = await tx.moderationState.update({
    where: { gameId_junjoUserId: { gameId, junjoUserId } },
    data: { version: { increment: 1 } },
    select: { version: true },
  });
  return row.version;
}
