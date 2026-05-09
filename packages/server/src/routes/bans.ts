import type { GameId, GameUserBannedEvent, GameUserUnbannedEvent } from "@junjo/shared";
import type { GameBan, Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { dispatchEvent } from "../events.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";
import { createGameBanBody, listGameBansQuery } from "./bans.schema.js";
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

    // Auto-create the JunjoUser + ExternalIdentity if the dev hasn't
    // seen this user before. Lets a moderator preemptively ban a user
    // who hasn't yet joined any group.
    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);

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
            },
          });
      await tx.auditEntry.create({
        data: {
          gameId,
          // Game-scoped event: no per-group context. Drops out of
          // per-group audit feeds; appears in the per-game and recent
          // /admin/audit feeds.
          groupId: null,
          actorUserId: null,
          action: "game.user.banned",
          targetId: userId,
          payload: {
            gameBanId: result.id,
            reason: reasonValue,
            expiresAt: expiresAtValue ? expiresAtValue.toISOString() : null,
          } as Prisma.InputJsonValue,
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
    return c.json(serializeGameBan(ban, userId, null), 201);
  });

  // DELETE /v1/bans/:userId
  // 404 when no ban row exists or when the user has never been seen
  // in this game (no ExternalIdentity).
  r.delete("/:userId", async (c) => {
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("ban");
    const existing = await prisma.gameBan.findUnique({
      where: { gameId_junjoUserId: { gameId, junjoUserId } },
    });
    if (!existing) throw Errors.notFound("ban");

    await prisma.$transaction(async (tx) => {
      await tx.gameBan.delete({ where: { id: existing.id } });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: null,
          actorUserId: null,
          action: "game.user.unbanned",
          targetId: userId,
          payload: { gameBanId: existing.id } as Prisma.InputJsonValue,
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
    const junjoUserIds = sliced.map((row) => row.junjoUserId);
    const externalMap = await batchLoadExternalUserIds(prisma, gameId, junjoUserIds);

    return c.json({
      items: sliced.map((row) => {
        const ext = externalMap.get(row.junjoUserId);
        if (!ext) {
          // Defensive: a GameBan should always have a matching
          // ExternalIdentity (we enforce both via findOrCreateJunjoUser
          // at write time). If a deletion races us, fall back to the
          // internal id rather than 500.
          return serializeGameBan(row, row.junjoUserId, null);
        }
        return serializeGameBan(row, ext, null);
      }),
      nextCursor,
    });
  });

  return r;
}
