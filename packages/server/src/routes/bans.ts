import type { GameId, GameUserBannedEvent, GameUserUnbannedEvent } from "@junjo.io/shared";
import type { BanHistory, GameBan, Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { dispatchEvent } from "../events.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";
import {
  createGameBanBody,
  deleteGameBanBody,
  listBanHistoryQuery,
  listGameBansQuery,
} from "./bans.schema.js";
import { batchLoadExternalUserIds } from "./members.js";

export interface WireGameBan {
  id: string;
  gameId: string;
  // The dev's external user id, NOT the internal junjoUserId.
  userId: string;
  bannedAt: string;
  expiresAt: string | null;
  reason: string | null;
  bannedBy: string | null;
}

export function serializeGameBan(
  ban: GameBan,
  externalUserId: string,
  externalActorUserId: string | null = null,
): WireGameBan {
  return {
    id: ban.id,
    gameId: ban.gameId,
    userId: externalUserId,
    bannedAt: ban.bannedAt.toISOString(),
    expiresAt: ban.expiresAt ? ban.expiresAt.toISOString() : null,
    reason: ban.reason,
    bannedBy: externalActorUserId,
  };
}

export interface WireBanHistoryEntry {
  id: string;
  gameId: string;
  userId: string;
  scope: "game" | "group";
  groupId: string | null;
  kind: "set" | "lifted";
  reason: string | null;
  expiresAt: string | null;
  eventAt: string;
  actorUserId: string | null;
}

export function serializeBanHistoryEntry(
  row: BanHistory,
  externalUserId: string,
  externalActorUserId: string | null = null,
): WireBanHistoryEntry {
  return {
    id: row.id,
    gameId: row.gameId,
    userId: externalUserId,
    scope: row.scope as "game" | "group",
    groupId: row.groupId,
    kind: row.kind as "set" | "lifted",
    reason: row.reason,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    eventAt: row.eventAt.toISOString(),
    actorUserId: externalActorUserId,
  };
}

export function bansRouter(prisma: PrismaClient, hub: EventHub): Hono {
  const r = new Hono();

  // POST /v1/bans
  // Idempotent on a still-active ban for the same user (returns the
  // existing row); replaces an expired ban with a fresh one. The
  // upsert keeps the original `bannedAt` only when extending an active
  // ban -- expired -> active counts as a new ban event.
  r.post("/", async (c) => {
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = createGameBanBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { userId } = parsed.data;
    const reasonValue = parsed.data.reason ?? null;
    const expiresAtValue = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    const actorExternalId = parsed.data.actorUserId ?? null;

    // Auto-create the JunjoUser + ExternalIdentity if the dev hasn't
    // seen this user before. Lets a moderator preemptively ban a user
    // who hasn't yet joined any group.
    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);
    // Same upsert for the actor (when supplied). Symmetric: a backend
    // admin tool's moderator may have never joined a group either.
    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    const now = new Date();
    const ban = await prisma.$transaction(async (tx) => {
      const existing = await tx.gameBan.findUnique({
        where: { gameId_junjoUserId: { gameId, junjoUserId } },
      });
      const isExistingActive = existing
        ? existing.expiresAt === null || existing.expiresAt > now
        : false;
      // GameBan row carries bannedAt + reason + bannedByUserId by
      // design; the audit row below is the same event in the generic
      // /admin/audit feed (filterable by `actions=game.user.banned`).
      const result = existing
        ? await tx.gameBan.update({
            where: { id: existing.id },
            data: {
              expiresAt: expiresAtValue,
              reason: reasonValue,
              bannedByUserId: actorJunjoUserId,
              // Refresh `bannedAt` only when re-banning after expiry;
              // an in-place edit of an active ban keeps the original
              // timestamp so the timeline reads cleanly.
              ...(isExistingActive ? {} : { bannedAt: now }),
            },
          })
        : await tx.gameBan.create({
            data: {
              gameId,
              junjoUserId,
              expiresAt: expiresAtValue,
              reason: reasonValue,
              bannedAt: now,
              bannedByUserId: actorJunjoUserId,
            },
          });
      await tx.auditEntry.create({
        data: {
          gameId,
          // Game-scoped event: no per-group context. Drops out of
          // per-group audit feeds; appears in the per-game and recent
          // /admin/audit feeds.
          groupId: null,
          actorUserId: actorJunjoUserId,
          action: "game.user.banned",
          targetId: userId,
          payload: {
            gameBanId: result.id,
            reason: reasonValue,
            expiresAt: expiresAtValue ? expiresAtValue.toISOString() : null,
          } as Prisma.InputJsonValue,
        },
      });
      // BanHistory append: structured ban-only timeline. Distinct from
      // the audit row above (which is the generic event log) and from
      // GameBan (which only carries current state).
      await tx.banHistory.create({
        data: {
          gameId,
          junjoUserId,
          scope: "game",
          groupId: null,
          kind: "set",
          reason: reasonValue,
          expiresAt: expiresAtValue,
          actorJunjoUserId,
        },
      });
      return result;
    });

    await dispatchEvent<GameUserBannedEvent>(prisma, hub, {
      type: "game.user.banned",
      gameId: gameId as GameId,
      junjoUserId,
      reason: reasonValue,
      expiresAt: expiresAtValue,
    });
    return c.json(serializeGameBan(ban, userId, actorExternalId), 201);
  });

  // DELETE /v1/bans/:userId
  // 404 when no ban row exists or when the user has never been seen
  // in this game (no ExternalIdentity). Accepts an optional body
  // `{ actorUserId }` to attribute the unban (mirrors POST).
  r.delete("/:userId", async (c) => {
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    // Body is genuinely optional on DELETE -- callers without an actor
    // to attribute can omit it entirely. Don't 400 on a missing body.
    const json = await c.req.json().catch(() => null);
    const parsed = deleteGameBanBody.safeParse(json ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const actorExternalId = parsed.data.actorUserId ?? null;

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("ban");
    const existing = await prisma.gameBan.findUnique({
      where: { gameId_junjoUserId: { gameId, junjoUserId } },
    });
    if (!existing) throw Errors.notFound("ban");

    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    await prisma.$transaction(async (tx) => {
      await tx.gameBan.delete({ where: { id: existing.id } });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: null,
          actorUserId: actorJunjoUserId,
          action: "game.user.unbanned",
          targetId: userId,
          payload: { gameBanId: existing.id } as Prisma.InputJsonValue,
        },
      });
      await tx.banHistory.create({
        data: {
          gameId,
          junjoUserId,
          scope: "game",
          groupId: null,
          kind: "lifted",
          reason: null,
          expiresAt: null,
          actorJunjoUserId,
        },
      });
    });

    await dispatchEvent<GameUserUnbannedEvent>(prisma, hub, {
      type: "game.user.unbanned",
      gameId: gameId as GameId,
      junjoUserId,
    });
    return c.body(null, 204);
  });

  // GET /v1/bans
  // Default: only active (unexpired) bans, newest-first. Cursor pagination
  // keys off `(bannedAt, id)` like other list routes.
  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    const parsed = listGameBansQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      includeExpired: c.req.query("includeExpired"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, includeExpired } = parsed.data;

    let cursorRow: { id: string; bannedAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.gameBan.findFirst({
        where: { id: cursor, gameId },
        select: { id: true, bannedAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const now = new Date();
    const conditions: Prisma.GameBanWhereInput[] = [];
    if (!includeExpired) {
      conditions.push({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    }
    if (cursorRow) {
      conditions.push({
        OR: [
          { bannedAt: { lt: cursorRow.bannedAt } },
          { bannedAt: cursorRow.bannedAt, id: { lt: cursorRow.id } },
        ],
      });
    }

    const where: Prisma.GameBanWhereInput = {
      gameId,
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    };

    const rows = await prisma.gameBan.findMany({
      where,
      orderBy: [{ bannedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    // Resolve internal junjoUserIds back to external ids for the wire.
    // One batch covers BOTH the target userIds and the actor userIds
    // (when present); they're the same kind of lookup against the same
    // game's ExternalIdentity rows.
    const junjoUserIds = new Set<string>();
    for (const row of sliced) {
      junjoUserIds.add(row.junjoUserId);
      if (row.bannedByUserId) junjoUserIds.add(row.bannedByUserId);
    }
    const externalMap = await batchLoadExternalUserIds(prisma, gameId, [...junjoUserIds]);

    return c.json({
      items: sliced.map((row) => {
        const ext = externalMap.get(row.junjoUserId);
        const actorExt = row.bannedByUserId ? (externalMap.get(row.bannedByUserId) ?? null) : null;
        if (!ext) {
          // Defensive: a GameBan should always have a matching
          // ExternalIdentity (we enforce both via findOrCreateJunjoUser
          // at write time). If a deletion races us, fall back to the
          // internal id rather than 500.
          return serializeGameBan(row, row.junjoUserId, actorExt);
        }
        return serializeGameBan(row, ext, actorExt);
      }),
      nextCursor,
    });
  });

  // GET /v1/bans/:userId
  // Single active game-level ban for the user. 404 when no row exists,
  // when the user has never been seen in this game, OR when the row
  // exists but its expiresAt has elapsed (lazy expiry: same contract as
  // the ban-check enforcement). Use GET /v1/bans?includeExpired=true to
  // see the underlying row in that case.
  r.get("/:userId", async (c) => {
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("ban");
    const ban = await prisma.gameBan.findUnique({
      where: { gameId_junjoUserId: { gameId, junjoUserId } },
    });
    if (!ban) throw Errors.notFound("ban");
    const isActive = ban.expiresAt === null || ban.expiresAt > new Date();
    if (!isActive) throw Errors.notFound("ban");
    let actorExt: string | null = null;
    if (ban.bannedByUserId) {
      const map = await batchLoadExternalUserIds(prisma, gameId, [ban.bannedByUserId]);
      actorExt = map.get(ban.bannedByUserId) ?? null;
    }
    return c.json(serializeGameBan(ban, userId, actorExt));
  });

  // GET /v1/bans/:userId/history
  // Append-only ban-event timeline for one user in this game. Includes
  // both game-scope and group-scope rows by default. ?scope filters to
  // one surface; ?groupId narrows to one group (and forces scope=group).
  r.get("/:userId/history", async (c) => {
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    const parsed = listBanHistoryQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      scope: c.req.query("scope"),
      groupId: c.req.query("groupId"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, scope, groupId } = parsed.data;
    if (groupId && scope === "game") {
      throw Errors.badRequest("scope=game is incompatible with a groupId filter");
    }
    const effectiveScope = groupId ? "group" : scope;

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    // No identity = no history. Distinct from "user has identity but
    // no events" (which returns an empty page).
    if (!junjoUserId) {
      return c.json({ items: [] as WireBanHistoryEntry[], nextCursor: null });
    }

    let cursorRow: { id: string; eventAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.banHistory.findFirst({
        where: { id: cursor, gameId, junjoUserId },
        select: { id: true, eventAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const conditions: Prisma.BanHistoryWhereInput[] = [];
    if (effectiveScope) conditions.push({ scope: effectiveScope });
    if (groupId) conditions.push({ groupId });
    if (cursorRow) {
      conditions.push({
        OR: [
          { eventAt: { lt: cursorRow.eventAt } },
          { eventAt: cursorRow.eventAt, id: { lt: cursorRow.id } },
        ],
      });
    }

    const where: Prisma.BanHistoryWhereInput = {
      gameId,
      junjoUserId,
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    };

    const rows = await prisma.banHistory.findMany({
      where,
      orderBy: [{ eventAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    // Resolve actor junjoUserIds to external ids (only when populated).
    const actorIds = sliced.map((r) => r.actorJunjoUserId).filter((v): v is string => v !== null);
    const actorMap =
      actorIds.length > 0
        ? await batchLoadExternalUserIds(prisma, gameId, actorIds)
        : new Map<string, string>();

    return c.json({
      items: sliced.map((row) => {
        const actorExt = row.actorJunjoUserId ? (actorMap.get(row.actorJunjoUserId) ?? null) : null;
        return serializeBanHistoryEntry(row, userId, actorExt);
      }),
      nextCursor,
    });
  });

  return r;
}
