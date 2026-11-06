import type { PartialGameConfig } from "@junjo.io/shared";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { resolveGameConfig } from "./config/defaults.js";
import type { Db } from "./db.js";
import { currentPreferredNamespaces } from "./requestContext.js";
import {
  assertUserIdWellFormed,
  assertUserIdsWellFormed,
  userIdNamespace,
} from "./userIdFormat.js";

// Race-safe via the `(gameId, externalUserId)` unique index. The loser of
// a concurrent first-time create catches Prisma's P2002, lets its inner
// transaction roll back (so its candidate JunjoUser never lands), and
// re-selects the winner's mapping.
//
// MUST receive a top-level PrismaClient, not a TransactionClient: Postgres
// marks a transaction as failed after a unique-constraint violation and
// refuses subsequent statements until rollback, so the helper can only
// recover when it owns the failing transaction. Callers that need
// atomicity with downstream writes resolve the user first, then enter
// their main transaction with the resolved junjoUserId.
//
// Rejects ids that break their namespace's declared format before any
// lookup, so a non-canonical spelling can never mint a second person.
export async function findOrCreateJunjoUser(
  prisma: PrismaClient,
  gameId: string,
  externalUserId: string,
): Promise<string> {
  await assertUserIdsWellFormed(prisma, gameId, [externalUserId]);
  const existing = await prisma.externalIdentity.findUnique({
    where: { gameId_externalUserId: { gameId, externalUserId } },
    select: { junjoUserId: true },
  });
  if (existing) return existing.junjoUserId;

  try {
    return await prisma.$transaction(async (tx) => {
      // The format check above read the config without a lock. A
      // namespaced id re-checks under a share lock on the Game row, which
      // the config write path holds FOR UPDATE while it scans stored ids,
      // so a format declared concurrently cannot miss this insert.
      if (userIdNamespace(externalUserId) !== null) {
        const rows = await tx.$queryRaw<{ config: unknown }[]>(
          Prisma.sql`SELECT config FROM "Game" WHERE id = ${gameId} FOR SHARE`,
        );
        const formats = resolveGameConfig((rows[0]?.config ?? null) as PartialGameConfig | null)
          .identity.formats;
        assertUserIdWellFormed(formats, externalUserId);
      }
      const user = await tx.junjoUser.create({ data: {} });
      await tx.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId },
      });
      return user.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.externalIdentity.findUnique({
        where: { gameId_externalUserId: { gameId, externalUserId } },
        select: { junjoUserId: true },
      });
      if (winner) return winner.junjoUserId;
      // Vanishingly rare: the winner's transaction also rolled back between
      // their commit and our re-select. Retry once; further conflicts are
      // legitimate persistent failures and surface as P2002 on the next pass.
      return findOrCreateJunjoUser(prisma, gameId, externalUserId);
    }
    throw err;
  }
}

// Returns null when no ExternalIdentity row exists. Callers translate
// that into a 404 on the consuming resource (e.g. "member" not "user",
// since the user might exist for other purposes). Malformed ids in a
// declared namespace reject instead of answering "not found".
export async function findJunjoUserId(
  client: Db,
  gameId: string,
  externalUserId: string,
): Promise<string | null> {
  await assertUserIdsWellFormed(client, gameId, [externalUserId]);
  const row = await client.externalIdentity.findUnique({
    where: { gameId_externalUserId: { gameId, externalUserId } },
    select: { junjoUserId: true },
  });
  return row?.junjoUserId ?? null;
}

// =====================================================================
// Rendering: which of a person's ids a response names them by
// =====================================================================

// The canonical order of a person's ids within one game. Every rendering
// decision reads ids in this order so ties resolve the same way on every
// path.
export const IDENTITY_ORDER: Prisma.ExternalIdentityOrderByWithRelationInput[] = [
  { linkedAt: "asc" },
  { id: "asc" },
];

// `ordered` must follow IDENTITY_ORDER and be non-empty. The first listed
// namespace the person has an id in wins, earliest-linked id first;
// otherwise the earliest-linked id overall, whatever its namespace.
export function pickRenderedId(ordered: readonly string[], preferred: readonly string[]): string {
  for (const ns of preferred) {
    for (const id of ordered) {
      if (userIdNamespace(id) === ns) return id;
    }
  }
  return ordered[0] as string;
}

// junjoUserId -> rendered external id for the calling game. People with
// no id in this game are absent from the map. `preferred` defaults to
// the current request's preference.
export async function renderUserIds(
  client: Db,
  gameId: string,
  junjoUserIds: Iterable<string>,
  preferred: readonly string[] = currentPreferredNamespaces(),
): Promise<Map<string, string>> {
  const ids = [...new Set(junjoUserIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.externalIdentity.findMany({
    where: { gameId, junjoUserId: { in: ids } },
    select: { junjoUserId: true, externalUserId: true },
    orderBy: IDENTITY_ORDER,
  });
  const byPerson = new Map<string, string[]>();
  for (const row of rows) {
    const list = byPerson.get(row.junjoUserId);
    if (list) list.push(row.externalUserId);
    else byPerson.set(row.junjoUserId, [row.externalUserId]);
  }
  const out = new Map<string, string>();
  for (const [junjoUserId, ordered] of byPerson) {
    out.set(junjoUserId, pickRenderedId(ordered, preferred));
  }
  return out;
}

export interface RenderedPerson {
  // The id responses name this person by.
  userId: string;
  // The rendered id's display name; when it has none, the most recently
  // set name among the person's ids; else null.
  displayName: string | null;
}

// `renderUserIds` plus each person's display name, from the same rows.
export async function renderPeople(
  client: Db,
  gameId: string,
  junjoUserIds: Iterable<string>,
  preferred: readonly string[] = currentPreferredNamespaces(),
): Promise<Map<string, RenderedPerson>> {
  const ids = [...new Set(junjoUserIds)];
  if (ids.length === 0) return new Map();
  const rows = await client.externalIdentity.findMany({
    where: { gameId, junjoUserId: { in: ids } },
    select: {
      junjoUserId: true,
      externalUserId: true,
      displayName: true,
      displayNameUpdatedAt: true,
    },
    orderBy: IDENTITY_ORDER,
  });
  const byPerson = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byPerson.get(row.junjoUserId);
    if (list) list.push(row);
    else byPerson.set(row.junjoUserId, [row]);
  }
  const out = new Map<string, RenderedPerson>();
  for (const [junjoUserId, ordered] of byPerson) {
    const userId = pickRenderedId(
      ordered.map((r) => r.externalUserId),
      preferred,
    );
    out.set(junjoUserId, { userId, displayName: personDisplayName(ordered, userId) });
  }
  return out;
}

// The person-level display name rule over one person's identity rows.
export function personDisplayName(
  rows: readonly {
    externalUserId: string;
    displayName: string | null;
    displayNameUpdatedAt: Date | null;
  }[],
  renderedId: string,
): string | null {
  const own = rows.find((r) => r.externalUserId === renderedId)?.displayName;
  if (own) return own;
  let latest: { name: string; at: number } | null = null;
  for (const r of rows) {
    if (!r.displayName) continue;
    const at = r.displayNameUpdatedAt?.getTime() ?? 0;
    if (!latest || at > latest.at) latest = { name: r.displayName, at };
  }
  return latest?.name ?? null;
}

// Rendered id for a person the caller just resolved or created from
// `requestedId`. Falls back to `requestedId` if the person has no id in
// the game (it was unlinked concurrently).
export async function renderResolved(
  client: Db,
  gameId: string,
  junjoUserId: string,
  requestedId: string,
): Promise<string> {
  const map = await renderUserIds(client, gameId, [junjoUserId]);
  return map.get(junjoUserId) ?? requestedId;
}
