import type { PartialGameConfig, UserIdFormat } from "@junjo.io/shared";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { resolveGameConfig } from "./config/defaults.js";
import { Errors } from "./errors.js";
import { currentRequestContext } from "./requestContext.js";

type FormatClient = PrismaClient | Prisma.TransactionClient;

export type DeclaredFormats = Readonly<Record<string, UserIdFormat>>;

const FORMAT_PATTERNS: Record<UserIdFormat, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
};

// Postgres spellings of FORMAT_PATTERNS for the declare-time scan. Kept
// beside the JS patterns so the two cannot drift apart unnoticed.
const FORMAT_SQL_PATTERNS: Record<UserIdFormat, string> = {
  uuid: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
};

// The text before the first ":", or null when there is none or it is
// empty. A namespace carries meaning only when a caller prefers it or
// the game declares a format for it.
export function userIdNamespace(userId: string): string | null {
  const at = userId.indexOf(":");
  return at > 0 ? userId.slice(0, at) : null;
}

export function matchesUserIdFormat(format: UserIdFormat, value: string): boolean {
  return FORMAT_PATTERNS[format].test(value);
}

// True when the id is outside every declared namespace, or matches the
// format its namespace declares.
export function isUserIdWellFormed(formats: DeclaredFormats, userId: string): boolean {
  const ns = userIdNamespace(userId);
  if (ns === null) return true;
  const format = Object.hasOwn(formats, ns) ? formats[ns] : undefined;
  if (format === undefined) return true;
  return matchesUserIdFormat(format, userId.slice(ns.length + 1));
}

export function assertUserIdWellFormed(formats: DeclaredFormats, userId: string): void {
  if (!isUserIdWellFormed(formats, userId)) {
    const ns = userIdNamespace(userId) as string;
    throw Errors.invalidUserId(
      `user id in namespace "${ns}" must be a ${formats[ns]} (lowercase, hyphenated)`,
    );
  }
}

// The game's declared formats, memoized on the request context so one
// request pays at most one lookup per game. A missing game has none.
export async function idFormatsFor(client: FormatClient, gameId: string): Promise<DeclaredFormats> {
  const ctx = currentRequestContext();
  const cached = ctx?.idFormats.get(gameId);
  if (cached) return cached;
  const game = await client.game.findUnique({ where: { id: gameId }, select: { config: true } });
  const formats = resolveGameConfig((game?.config ?? null) as PartialGameConfig | null).identity
    .formats;
  ctx?.idFormats.set(gameId, formats);
  return formats;
}

// Rejects with `invalid_user_id` when any id breaks its namespace's
// declared format. Games that declare nothing skip the check after the
// (memoized) config read.
export async function assertUserIdsWellFormed(
  client: FormatClient,
  gameId: string,
  userIds: Iterable<string>,
): Promise<void> {
  const formats = await idFormatsFor(client, gameId);
  if (Object.keys(formats).length === 0) return;
  for (const id of userIds) assertUserIdWellFormed(formats, id);
}

// Stored ids that would stop resolving if `formats` were declared, at
// most `limit` of them. Only namespaces whose format is new or changed
// relative to `previous` are scanned.
export async function findFormatConflicts(
  client: FormatClient,
  gameId: string,
  previous: DeclaredFormats,
  formats: DeclaredFormats,
  limit = 5,
): Promise<string[]> {
  const conflicts: string[] = [];
  for (const [ns, format] of Object.entries(formats)) {
    if (previous[ns] === format) continue;
    const prefix = `${ns}:`;
    const rows = await client.$queryRaw<{ externalUserId: string }[]>(Prisma.sql`
      SELECT "externalUserId" FROM "ExternalIdentity"
      WHERE "gameId" = ${gameId}
        AND starts_with("externalUserId", ${prefix})
        AND substr("externalUserId", ${prefix.length + 1}::int) !~ ${FORMAT_SQL_PATTERNS[format]}
      ORDER BY "externalUserId"
      LIMIT ${limit - conflicts.length}
    `);
    for (const row of rows) conflicts.push(row.externalUserId);
    if (conflicts.length >= limit) break;
  }
  return conflicts;
}
