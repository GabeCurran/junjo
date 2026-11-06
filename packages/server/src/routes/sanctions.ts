import type {
  GameId,
  GameUserSanctionedEvent,
  GameUserUnsanctionedEvent,
  UserId,
} from "@junjo.io/shared";
import type { Prisma, PrismaClient, Sanction, SanctionHistory } from "@prisma/client";
import { type Context, type Handler, Hono } from "hono";
import type { Db } from "../db.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { publishStagedEvents, stageEvent } from "../events.js";
import { isActiveUntil } from "../expiry.js";
import { findJunjoUserId, findOrCreateJunjoUser, renderUserIds } from "../identity.js";
import { retryOnUniqueViolation } from "../prismaErrors.js";
import { parseBody } from "../validation.js";
import {
  assertVersion,
  bumpModerationVersion,
  lockModerationVersion,
  readIfMatch,
  readModerationVersion,
  readModerationVersions,
  setEtag,
} from "../versions.js";
import { stampStreamPosition } from "./gameEvents.js";
import {
  SANCTION_STARTED_AT_MAX_SKEW_MS,
  createSanctionBody,
  deleteSanctionBody,
  listSanctionHistoryQuery,
  listSanctionsQuery,
  sanctionTypeSchema,
} from "./sanctions.schema.js";

export interface WireSanction {
  id: string;
  userId: string;
  type: string;
  reason: string | null;
  issuer: string | null;
  issuedBy: string | null;
  startedAt: string;
  expiresAt: string | null;
  // The person's moderation version.
  version: number;
}

export function serializeSanction(
  row: Sanction,
  externalUserId: string,
  issuedBy: string | null,
  version: number,
): WireSanction {
  return {
    id: row.id,
    userId: externalUserId,
    type: row.type,
    reason: row.reason,
    issuer: row.issuer,
    issuedBy,
    startedAt: row.startedAt.toISOString(),
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    version,
  };
}

export interface WireSanctionHistoryEntry {
  id: string;
  gameId: string;
  userId: string;
  type: string;
  kind: "set" | "lifted";
  reason: string | null;
  expiresAt: string | null;
  eventAt: string;
  actorUserId: string | null;
  issuer: string | null;
}

export function serializeSanctionHistoryEntry(
  row: SanctionHistory,
  externalUserId: string,
  actorUserId: string | null,
): WireSanctionHistoryEntry {
  return {
    id: row.id,
    gameId: row.gameId,
    userId: externalUserId,
    type: row.type,
    kind: row.kind as "set" | "lifted",
    reason: row.reason,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    eventAt: row.eventAt.toISOString(),
    actorUserId,
    issuer: row.issuer,
  };
}

function activeWhere(now: Date): Prisma.SanctionWhereInput {
  return { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] };
}

// Renders the people and issuers of `rows` and attaches each person's
// moderation version.
async function serializeSanctions(
  db: Db,
  gameId: string,
  rows: Sanction[],
): Promise<WireSanction[]> {
  const people = new Set<string>();
  for (const row of rows) {
    people.add(row.junjoUserId);
    if (row.issuedByUserId) people.add(row.issuedByUserId);
  }
  const [shown, versions] = await Promise.all([
    renderUserIds(db, gameId, people),
    readModerationVersions(
      db,
      gameId,
      rows.map((r) => r.junjoUserId),
    ),
  ]);
  return rows.map((row) =>
    serializeSanction(
      row,
      shown.get(row.junjoUserId) ?? row.junjoUserId,
      row.issuedByUserId ? (shown.get(row.issuedByUserId) ?? null) : null,
      versions.get(row.junjoUserId) ?? 0,
    ),
  );
}

// A person's active sanctions, newest first.
export async function loadActiveSanctions(
  db: Db,
  gameId: string,
  junjoUserId: string,
): Promise<WireSanction[]> {
  const rows = await db.sanction.findMany({
    where: { gameId, junjoUserId, ...activeWhere(new Date()) },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
  });
  return serializeSanctions(db, gameId, rows);
}

function sameInstant(a: Date | null, b: Date | null): boolean {
  return a === null || b === null ? a === b : a.getTime() === b.getTime();
}

export function sanctionsRouter(prisma: PrismaClient, hub: EventHub): Hono {
  const r = new Hono();

  // POST /v1/sanctions
  // Creates (201) or, when the person already has an active sanction of
  // the type, replaces its reason, expiry, issuer and actor (200). A
  // request that would store exactly what is stored answers 200 with no
  // write, no event and no version step. An expired row counts as no
  // sanction and is replaced by a new one (201).
  r.post("/", async (c) => {
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const body = parseBody(createSanctionBody, json);
    const { userId, type } = body;
    const reasonValue = body.reason ?? null;
    const expiresAtValue = body.expiresAt ? new Date(body.expiresAt) : null;
    const issuerValue = body.issuer ?? null;
    const actorExternalId = body.actorUserId ?? null;
    const startedAtInput = body.startedAt ? new Date(body.startedAt) : null;
    if (startedAtInput && startedAtInput.getTime() > Date.now() + SANCTION_STARTED_AT_MAX_SKEW_MS) {
      throw Errors.badRequest("startedAt must not be in the future");
    }
    const ifMatch = readIfMatch(c);

    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);
    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    const now = new Date();
    // retryOnUniqueViolation: two concurrent first sanctions of one type
    // both miss the findUnique; the rerun takes the update branch.
    const outcome = await retryOnUniqueViolation(() =>
      prisma.$transaction(async (tx) => {
        const current = await lockModerationVersion(tx, gameId, junjoUserId, ifMatch);
        const existing = await tx.sanction.findUnique({
          where: { gameId_junjoUserId_type: { gameId, junjoUserId, type } },
        });
        const wasActive = existing !== null && isActiveUntil(existing.expiresAt, now);
        if (
          existing &&
          wasActive &&
          existing.reason === reasonValue &&
          sameInstant(existing.expiresAt, expiresAtValue) &&
          existing.issuer === issuerValue &&
          existing.issuedByUserId === actorJunjoUserId &&
          (startedAtInput === null || sameInstant(existing.startedAt, startedAtInput))
        ) {
          return { row: existing, version: current, created: false, event: null };
        }

        const fields = {
          reason: reasonValue,
          expiresAt: expiresAtValue,
          issuer: issuerValue,
          issuedByUserId: actorJunjoUserId,
        };
        const row = existing
          ? await tx.sanction.update({
              where: { id: existing.id },
              data: {
                ...fields,
                // A replacement keeps the start of the sanction it
                // replaces unless the caller states one; a lapsed row
                // starts a new sanction.
                ...(startedAtInput
                  ? { startedAt: startedAtInput }
                  : wasActive
                    ? {}
                    : { startedAt: now }),
              },
            })
          : await tx.sanction.create({
              data: { gameId, junjoUserId, type, startedAt: startedAtInput ?? now, ...fields },
            });
        const version = await bumpModerationVersion(tx, gameId, junjoUserId);
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: null,
            actorUserId: actorJunjoUserId,
            action: "game.user.sanctioned",
            targetId: userId,
            payload: {
              sanctionId: row.id,
              type,
              reason: reasonValue,
              expiresAt: expiresAtValue ? expiresAtValue.toISOString() : null,
            } as Prisma.InputJsonValue,
          },
        });
        await tx.sanctionHistory.create({
          data: {
            gameId,
            junjoUserId,
            type,
            kind: "set",
            reason: reasonValue,
            expiresAt: expiresAtValue,
            actorJunjoUserId,
            issuer: issuerValue,
            eventAt: wasActive ? (startedAtInput ?? now) : row.startedAt,
          },
        });
        const event = await stageEvent<GameUserSanctionedEvent>(tx, {
          type: "game.user.sanctioned",
          gameId: gameId as GameId,
          userId: userId as UserId,
          sanctionType: type,
          reason: reasonValue,
          expiresAt: expiresAtValue,
          moderationVersion: version,
        });
        return { row, version, created: !wasActive, event };
      }),
    );

    if (outcome.event) publishStagedEvents(hub, outcome.event);
    setEtag(c, outcome.version);
    const shown = await renderUserIds(
      prisma,
      gameId,
      outcome.row.issuedByUserId ? [junjoUserId, outcome.row.issuedByUserId] : [junjoUserId],
    );
    return c.json(
      serializeSanction(
        outcome.row,
        shown.get(junjoUserId) ?? userId,
        outcome.row.issuedByUserId ? (shown.get(outcome.row.issuedByUserId) ?? null) : null,
        outcome.version,
      ),
      outcome.created ? 201 : 200,
    );
  });

  // DELETE /v1/sanctions/:userId/:type
  // Lifts the active sanction. Nothing active to lift (an unknown person,
  // no row, or a lapsed row) is 404 with `details.reason: "not_active"`,
  // answered before the precondition so a replayed lift reads as done.
  r.delete("/:userId/:type", async (c) => {
    const gameId = c.var.gameId;
    const userId = c.req.param("userId");
    const type = parseBody(sanctionTypeSchema, c.req.param("type"), "invalid sanction type");

    const json = await c.req.json().catch(() => null);
    const actorExternalId = parseBody(deleteSanctionBody, json ?? {}).actorUserId ?? null;
    const ifMatch = readIfMatch(c);

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.sanctionNotActive();
    const existing = await prisma.sanction.findUnique({
      where: { gameId_junjoUserId_type: { gameId, junjoUserId, type } },
    });
    if (!existing || !isActiveUntil(existing.expiresAt, new Date())) {
      throw Errors.sanctionNotActive();
    }

    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    const { event, version } = await prisma.$transaction(async (tx) => {
      const current = await lockModerationVersion(tx, gameId, junjoUserId, null);
      const now = new Date();
      // Guarded delete: a racing lift, or expiry since the read above,
      // matches zero rows and answers like a sequential second caller.
      const deleted = await tx.sanction.deleteMany({
        where: { id: existing.id, ...activeWhere(now) },
      });
      if (deleted.count === 0) throw Errors.sanctionNotActive();
      assertVersion(ifMatch, current);
      const version = await bumpModerationVersion(tx, gameId, junjoUserId);
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: null,
          actorUserId: actorJunjoUserId,
          action: "game.user.unsanctioned",
          targetId: userId,
          payload: { sanctionId: existing.id, type } as Prisma.InputJsonValue,
        },
      });
      await tx.sanctionHistory.create({
        data: {
          gameId,
          junjoUserId,
          type,
          kind: "lifted",
          reason: null,
          expiresAt: null,
          actorJunjoUserId,
          eventAt: now,
        },
      });
      const staged = await stageEvent<GameUserUnsanctionedEvent>(tx, {
        type: "game.user.unsanctioned",
        gameId: gameId as GameId,
        userId: userId as UserId,
        sanctionType: type,
        moderationVersion: version,
      });
      return { event: staged, version };
    });

    publishStagedEvents(hub, event);
    setEtag(c, version);
    return c.body(null, 204);
  });

  // GET /v1/sanctions
  // Active sanctions in the game, newest first, keyset paged on
  // (startedAt, id) like `GET /v1/bans`.
  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    await stampStreamPosition(c, prisma, gameId);
    const { type, limit, cursor } = parseBody(
      listSanctionsQuery,
      { type: c.req.query("type"), limit: c.req.query("limit"), cursor: c.req.query("cursor") },
      "invalid query",
    );

    const conditions: Prisma.SanctionWhereInput[] = [activeWhere(new Date())];
    if (type) conditions.push({ type });
    if (cursor) {
      const row = await prisma.sanction.findFirst({
        where: { id: cursor, gameId },
        select: { id: true, startedAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      conditions.push({
        OR: [
          { startedAt: { lt: row.startedAt } },
          { startedAt: row.startedAt, id: { lt: row.id } },
        ],
      });
    }
    const rows = await prisma.sanction.findMany({
      where: { gameId, AND: conditions },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    return c.json({
      items: await serializeSanctions(prisma, gameId, sliced),
      nextCursor: hasMore && last ? last.id : null,
    });
  });

  return r;
}

// GET /v1/users/:userId/sanctions
// The person's active sanctions, newest first, with the moderation
// version as ETag. A person never seen in this game has none.
export function listUserSanctionsHandler(prisma: PrismaClient): Handler {
  return async (c: Context) => {
    const gameId = c.var.gameId;
    const userId = c.req.param("userId") ?? "";
    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) {
      setEtag(c, 0);
      return c.json({ items: [] as WireSanction[] });
    }
    const [items, version] = await Promise.all([
      loadActiveSanctions(prisma, gameId, junjoUserId),
      readModerationVersion(prisma, gameId, junjoUserId),
    ]);
    setEtag(c, version);
    return c.json({ items });
  };
}

// GET /v1/users/:userId/sanctions/history
// Every set and lift, newest first, keyset paged on (eventAt, id).
export function listUserSanctionHistoryHandler(prisma: PrismaClient): Handler {
  return async (c: Context) => {
    const gameId = c.var.gameId;
    const userId = c.req.param("userId") ?? "";
    const { type, limit, cursor } = parseBody(
      listSanctionHistoryQuery,
      { type: c.req.query("type"), limit: c.req.query("limit"), cursor: c.req.query("cursor") },
      "invalid query",
    );

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) {
      return c.json({ items: [] as WireSanctionHistoryEntry[], nextCursor: null });
    }

    const conditions: Prisma.SanctionHistoryWhereInput[] = [];
    if (type) conditions.push({ type });
    if (cursor) {
      const row = await prisma.sanctionHistory.findFirst({
        where: { id: cursor, gameId, junjoUserId },
        select: { id: true, eventAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      conditions.push({
        OR: [{ eventAt: { lt: row.eventAt } }, { eventAt: row.eventAt, id: { lt: row.id } }],
      });
    }
    const rows = await prisma.sanctionHistory.findMany({
      where: { gameId, junjoUserId, ...(conditions.length > 0 ? { AND: conditions } : {}) },
      orderBy: [{ eventAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];

    const actors = sliced.map((r) => r.actorJunjoUserId).filter((v): v is string => v !== null);
    const shown = await renderUserIds(prisma, gameId, [junjoUserId, ...actors]);
    const target = shown.get(junjoUserId) ?? userId;
    return c.json({
      items: sliced.map((row) =>
        serializeSanctionHistoryEntry(
          row,
          target,
          row.actorJunjoUserId ? (shown.get(row.actorJunjoUserId) ?? null) : null,
        ),
      ),
      nextCursor: hasMore && last ? last.id : null,
    });
  };
}
