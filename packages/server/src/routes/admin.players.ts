// @cloud-only
//
// GET /v1/admin/games/:gameId/players. Lists the people who hold at
// least one id in a game, one row per JunjoUser, for the dashboard's
// player browser. Authenticated by the cross-game admin token.

import { Prisma, type PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { IDENTITY_ORDER } from "../identity.js";
import { userIdNamespace } from "../userIdFormat.js";
import { type AdminPlayerSortField, listAdminPlayersQuery } from "./admin.schema.js";

export interface WireAdminPlayerId {
  userId: string;
  namespace: string | null;
  displayName: string | null;
  linkedAt: string;
}

export interface WireAdminPlayerBan {
  reason: string | null;
  expiresAt: string | null;
}

export interface WireAdminPlayerSanction {
  type: string;
  expiresAt: string | null;
}

export interface WireAdminPlayer {
  personId: string;
  userIds: WireAdminPlayerId[];
  displayName: string | null;
  firstSeenAt: string;
  lastActivityAt: string | null;
  activeGroupCount: number;
  ban: WireAdminPlayerBan | null;
  sanctions: WireAdminPlayerSanction[];
}

export interface WireAdminPlayerList {
  items: WireAdminPlayer[];
  total: number;
  limit: number;
  offset: number;
}

interface PageRow {
  total: number;
  personId: string | null;
  displayName: string | null;
  firstSeenAt: Date | null;
  lastActivityAt: Date | null;
}

// Newest first among a person's display names: the most recently set
// one wins, and the identity id breaks ties.
function displayNameOrderSql(alias: string): Prisma.Sql {
  const i = Prisma.raw(alias);
  return Prisma.sql`${i}."displayNameUpdatedAt" DESC NULLS LAST, ${i}.id DESC`;
}

// One person's display name in the game, or null.
function personDisplayNameSql(gameId: string, alias: string): Prisma.Sql {
  const p = Prisma.raw(alias);
  return Prisma.sql`(
    SELECT dn."displayName" FROM "ExternalIdentity" dn
    WHERE dn."gameId" = ${gameId} AND dn."junjoUserId" = ${p}."personId"
      AND dn."displayName" IS NOT NULL
    ORDER BY ${displayNameOrderSql("dn")}
    LIMIT 1
  )`;
}

// Ties break on the person id so a given offset returns the same rows on
// every call. People with no activity sort last in either direction.
function orderBySql(sort: AdminPlayerSortField, order: "asc" | "desc", alias: string): Prisma.Sql {
  const p = Prisma.raw(alias);
  const dir = Prisma.raw(order === "asc" ? "ASC" : "DESC");
  switch (sort) {
    case "name":
      return Prisma.sql`${p}."sortName" ${dir}, ${p}."personId" ASC`;
    case "lastActivity":
      return Prisma.sql`${p}."lastActivityAt" ${dir} NULLS LAST, ${p}."personId" ASC`;
    default:
      return Prisma.sql`${p}."firstSeenAt" ${dir}, ${p}."personId" ASC`;
  }
}

// One query aggregates the game's identities per person, applies every
// filter, counts the matches and slices the page. A second round of four
// batched queries over the page's people fills in ids, memberships, bans
// and sanctions.
export function listAdminPlayersHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const game = await prisma.game.findUnique({ where: { id: gameId }, select: { id: true } });
    if (!game) throw Errors.notFound("game");

    const parsed = listAdminPlayersQuery.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      q: c.req.query("q"),
      namespace: c.req.query("namespace"),
      standing: c.req.query("standing"),
      sort: c.req.query("sort"),
      order: c.req.query("order"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, offset, q, namespace, standing, sort, order } = parsed.data;
    const now = new Date();

    const qCondition =
      q === undefined
        ? Prisma.empty
        : Prisma.sql`AND bool_or(
            strpos(lower(i."externalUserId"), lower(${q})) > 0
            OR strpos(lower(coalesce(i."displayName", '')), lower(${q})) > 0
          )`;
    const namespaceCondition =
      namespace === undefined
        ? Prisma.empty
        : Prisma.sql`AND bool_or(starts_with(i."externalUserId", ${`${namespace}:`}))`;
    let standingCondition = Prisma.empty;
    if (standing === "banned") {
      standingCondition = Prisma.sql`AND EXISTS (
        SELECT 1 FROM "GameBan" b
        WHERE b."gameId" = ${gameId} AND b."junjoUserId" = p."personId"
          AND (b."expiresAt" IS NULL OR b."expiresAt" > ${now})
      )`;
    } else if (standing === "sanctioned") {
      standingCondition = Prisma.sql`AND EXISTS (
        SELECT 1 FROM "Sanction" sn
        WHERE sn."gameId" = ${gameId} AND sn."junjoUserId" = p."personId"
          AND (sn."expiresAt" IS NULL OR sn."expiresAt" > ${now})
      )`;
    }

    // Only the name sort's key is built for every person; the page looks
    // up the display name for its own rows only. Last activity is the
    // newest of the person's stored per-id values, read from the rows the
    // aggregate already scans.
    const nameColumn =
      sort === "name"
        ? Prisma.sql`, lower(coalesce(
            (array_agg(i."displayName" ORDER BY ${displayNameOrderSql("i")})
              FILTER (WHERE i."displayName" IS NOT NULL))[1],
            (array_agg(i."externalUserId" ORDER BY i."linkedAt" ASC, i.id ASC))[1]
          )) AS "sortName"`
        : Prisma.empty;
    const pageSortName = sort === "name" ? Prisma.sql`, s."sortName"` : Prisma.empty;

    const query = Prisma.sql`
      WITH people AS (
        SELECT i."junjoUserId" AS "personId", min(i."createdAt") AS "firstSeenAt",
          max(i."lastActivityAt") AS "lastActivityAt" ${nameColumn}
        FROM "ExternalIdentity" i
        WHERE i."gameId" = ${gameId}
        GROUP BY i."junjoUserId"
        HAVING true ${qCondition} ${namespaceCondition}
      ),
      matched AS (
        SELECT p.*
        FROM people p
        WHERE true ${standingCondition}
      )
      SELECT t.total, pg."personId", pg."displayName", pg."firstSeenAt", pg."lastActivityAt"
      FROM (SELECT count(*)::int AS total FROM matched) t
      LEFT JOIN LATERAL (
        SELECT s."personId", s."firstSeenAt", s."lastActivityAt" ${pageSortName},
          ${personDisplayNameSql(gameId, "s")} AS "displayName"
        FROM (
          SELECT * FROM matched m
          ORDER BY ${orderBySql(sort, order, "m")}
          LIMIT ${limit} OFFSET ${offset}
        ) s
      ) pg ON true
      ORDER BY ${orderBySql(sort, order, "pg")}
    `;
    // The estimated cost grows with the game's people and crosses the JIT
    // threshold long before compiling pays for itself on a query this
    // short, so JIT is off for this transaction only.
    const [, rows] = await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL jit = off`,
      prisma.$queryRaw<PageRow[]>(query),
    ]);

    const total = rows[0]?.total ?? 0;
    const page = rows.filter(
      (r): r is PageRow & { personId: string; firstSeenAt: Date } => r.personId !== null,
    );
    if (page.length === 0) {
      return c.json<WireAdminPlayerList>({ items: [], total, limit, offset });
    }

    const personIds = page.map((r) => r.personId);
    const [identities, groupCounts, bans, sanctions] = await Promise.all([
      prisma.externalIdentity.findMany({
        where: { gameId, junjoUserId: { in: personIds } },
        select: { junjoUserId: true, externalUserId: true, displayName: true, linkedAt: true },
        orderBy: IDENTITY_ORDER,
      }),
      prisma.$queryRaw<{ personId: string; count: number }[]>(Prisma.sql`
        SELECT gm."junjoUserId" AS "personId", count(*)::int AS count
        FROM "GroupMember" gm
        JOIN "Group" g ON g.id = gm."groupId"
        WHERE gm."junjoUserId" IN (${Prisma.join(personIds)})
          AND gm.status = 'active'
          AND g."gameId" = ${gameId}
          AND g."softDeletedAt" IS NULL
        GROUP BY gm."junjoUserId"
      `),
      prisma.gameBan.findMany({
        where: {
          gameId,
          junjoUserId: { in: personIds },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { junjoUserId: true, reason: true, expiresAt: true },
      }),
      prisma.sanction.findMany({
        where: {
          gameId,
          junjoUserId: { in: personIds },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { junjoUserId: true, type: true, expiresAt: true },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      }),
    ]);

    const idsByPerson = new Map<string, WireAdminPlayerId[]>();
    for (const row of identities) {
      const wire: WireAdminPlayerId = {
        userId: row.externalUserId,
        namespace: userIdNamespace(row.externalUserId),
        displayName: row.displayName,
        linkedAt: row.linkedAt.toISOString(),
      };
      const list = idsByPerson.get(row.junjoUserId);
      if (list) list.push(wire);
      else idsByPerson.set(row.junjoUserId, [wire]);
    }
    const countByPerson = new Map(groupCounts.map((r) => [r.personId, r.count]));
    const banByPerson = new Map(
      bans.map((b) => [
        b.junjoUserId,
        { reason: b.reason, expiresAt: b.expiresAt ? b.expiresAt.toISOString() : null },
      ]),
    );
    const sanctionsByPerson = new Map<string, WireAdminPlayerSanction[]>();
    for (const s of sanctions) {
      const wire = { type: s.type, expiresAt: s.expiresAt ? s.expiresAt.toISOString() : null };
      const list = sanctionsByPerson.get(s.junjoUserId);
      if (list) list.push(wire);
      else sanctionsByPerson.set(s.junjoUserId, [wire]);
    }

    const items: WireAdminPlayer[] = page.map((r) => ({
      personId: r.personId,
      userIds: idsByPerson.get(r.personId) ?? [],
      displayName: r.displayName,
      firstSeenAt: r.firstSeenAt.toISOString(),
      lastActivityAt: r.lastActivityAt ? r.lastActivityAt.toISOString() : null,
      activeGroupCount: countByPerson.get(r.personId) ?? 0,
      ban: banByPerson.get(r.personId) ?? null,
      sanctions: sanctionsByPerson.get(r.personId) ?? [],
    }));

    return c.json<WireAdminPlayerList>({ items, total, limit, offset });
  };
}
