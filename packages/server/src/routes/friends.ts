// Friend request and friendship lifecycle routes (per-game API key
// gated). Every handler reads the game's resolved GameConfig first and
// 404s on `friends.enabled = false` so feature absence is invisible.
//
// Block routes, webhook events, and scope=network query expansion land
// in the next commit. This file deliberately handles only the local
// (per-game scope) request/accept/decline/cancel/list/unfriend flow.

import type { PrismaClient, UserRelationship } from "@prisma/client";
import type { Handler } from "hono";
import { loadGameConfig } from "../config/loadGameConfig.js";
import { Errors } from "../errors.js";
import {
  addBlockBody,
  listBlocksQuery,
  listFriendRequestsQuery,
  listFriendsQuery,
  sendFriendRequestBody,
} from "./friends.schema.js";

// =====================================================================
// Wire shapes
// =====================================================================

export interface WireFriendRequest {
  id: string;
  gameId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
  createdAt: string;
}

export interface WireFriendship {
  // The relationship row from the requested user's POV. The "friend"
  // is the OTHER party (not the user in the URL path).
  id: string;
  gameId: string;
  junjoUserId: string;
  since: string; // respondedAt (or createdAt for auto-accepted rows)
}

// Only set for POST /friend-requests when requestsRequired=false (the
// request was the acceptance). The handler returns the friendship
// snapshot directly so the caller does not have to follow up with
// /friends to discover what just happened.
export interface WireFriendRequestSendResult {
  status: "pending" | "auto-accepted";
  request?: WireFriendRequest;
  friendship?: WireFriendship;
}

export interface WireFriendRequestList {
  inbound: WireFriendRequest[];
  outbound: WireFriendRequest[];
}

export interface WireFriendshipList {
  items: WireFriendship[];
  nextCursor: string | null;
}

function toWireRequest(row: UserRelationship): WireFriendRequest {
  return {
    id: row.id,
    gameId: row.gameId,
    actorJunjoUserId: row.actorJunjoUserId,
    targetJunjoUserId: row.targetJunjoUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

function toWireFriendshipFromActorPOV(row: UserRelationship): WireFriendship {
  return {
    id: row.id,
    gameId: row.gameId,
    junjoUserId: row.targetJunjoUserId,
    since: (row.respondedAt ?? row.createdAt).toISOString(),
  };
}

// =====================================================================
// Helpers
// =====================================================================

async function ensureUserExists(prisma: PrismaClient, junjoUserId: string): Promise<void> {
  const user = await prisma.junjoUser.findUnique({
    where: { id: junjoUserId },
    select: { id: true },
  });
  if (!user) throw Errors.notFound("user");
}

async function existingFriendship(
  prisma: PrismaClient,
  gameId: string,
  a: string,
  b: string,
): Promise<UserRelationship | null> {
  return prisma.userRelationship.findUnique({
    where: {
      gameId_actorJunjoUserId_targetJunjoUserId_type: {
        gameId,
        actorJunjoUserId: a,
        targetJunjoUserId: b,
        type: "friend",
      },
    },
  });
}

async function existingPendingRequest(
  prisma: PrismaClient,
  gameId: string,
  actor: string,
  target: string,
): Promise<UserRelationship | null> {
  return prisma.userRelationship.findUnique({
    where: {
      gameId_actorJunjoUserId_targetJunjoUserId_type: {
        gameId,
        actorJunjoUserId: actor,
        targetJunjoUserId: target,
        type: "request",
      },
    },
  });
}

// Throws 409 / 400 errors when the actor cannot take on another
// outgoing request or another friendship within this game's caps.
async function assertCapsBeforeWrite(
  prisma: PrismaClient,
  gameId: string,
  actorJunjoUserId: string,
  caps: { maxFriends: number; maxPendingRequests: number },
  kind: "request" | "friend",
): Promise<void> {
  if (kind === "request") {
    const pending = await prisma.userRelationship.count({
      where: { gameId, actorJunjoUserId, type: "request" },
    });
    if (pending >= caps.maxPendingRequests) {
      throw Errors.badRequest(`outbound friend request cap reached (${caps.maxPendingRequests})`);
    }
  }
  // Friend cap applies to both directions of the request flow: the
  // actor that sends the request must have headroom, and on accept the
  // accepter is checked too (in the accept handler).
  const friends = await prisma.userRelationship.count({
    where: { gameId, actorJunjoUserId, type: "friend" },
  });
  if (friends >= caps.maxFriends) {
    throw Errors.badRequest(`friend cap reached (${caps.maxFriends})`);
  }
}

// =====================================================================
// Handlers
// =====================================================================

export function sendFriendRequestHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = sendFriendRequestBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }
    const { targetJunjoUserId } = parsed.data;
    if (targetJunjoUserId === userId) {
      throw Errors.badRequest("cannot send a friend request to yourself");
    }

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    await ensureUserExists(prisma, userId);
    await ensureUserExists(prisma, targetJunjoUserId);

    // Block guard. If either party has blocked the other, the request
    // is silently rejected with 404 (matching the "block makes me
    // invisible" privacy contract). The blocking party also sees a 404
    // for symmetry; they should not receive an explicit signal that
    // their own block is what failed the request.
    const blockExists = await prisma.userRelationship.findFirst({
      where: {
        gameId,
        type: "blocked",
        OR: [
          { actorJunjoUserId: userId, targetJunjoUserId },
          { actorJunjoUserId: targetJunjoUserId, targetJunjoUserId: userId },
        ],
      },
      select: { id: true },
    });
    if (blockExists) throw Errors.notFound("user");

    // Reject if already friends in either direction.
    const existingForward = await existingFriendship(prisma, gameId, userId, targetJunjoUserId);
    if (existingForward) {
      throw Errors.badRequest("already friends");
    }
    // Reject if a request is already pending in either direction; the
    // user who got the inbound request should accept it instead of
    // sending their own.
    const existingOutboundReq = await existingPendingRequest(
      prisma,
      gameId,
      userId,
      targetJunjoUserId,
    );
    if (existingOutboundReq) {
      throw Errors.badRequest("a pending friend request already exists");
    }
    const existingInboundReq = await existingPendingRequest(
      prisma,
      gameId,
      targetJunjoUserId,
      userId,
    );
    if (existingInboundReq) {
      throw Errors.badRequest("a pending friend request from this user already exists; accept it");
    }

    await assertCapsBeforeWrite(prisma, gameId, userId, config.friends, "request");

    if (config.friends.requestsRequired) {
      const row = await prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId,
          type: "request",
        },
      });
      return c.json<WireFriendRequestSendResult>(
        { status: "pending", request: toWireRequest(row) },
        201,
      );
    }

    // Auto-accept path: write the two friend rows in one transaction.
    // Same shape as POST /accept, just without an intermediate request
    // row. The accepter cap is checked here against the target side.
    const targetFriends = await prisma.userRelationship.count({
      where: { gameId, actorJunjoUserId: targetJunjoUserId, type: "friend" },
    });
    if (targetFriends >= config.friends.maxFriends) {
      throw Errors.badRequest(
        `target user has reached the friend cap (${config.friends.maxFriends})`,
      );
    }

    const now = new Date();
    const [actorRow] = await prisma.$transaction([
      prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId,
          type: "friend",
          respondedAt: now,
        },
      }),
      prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: targetJunjoUserId,
          targetJunjoUserId: userId,
          type: "friend",
          respondedAt: now,
        },
      }),
    ]);
    return c.json<WireFriendRequestSendResult>(
      { status: "auto-accepted", friendship: toWireFriendshipFromActorPOV(actorRow) },
      201,
    );
  };
}

export function listFriendRequestsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const queryRaw = c.req.query();
    const parsedQ = listFriendRequestsQuery.safeParse(queryRaw);
    if (!parsedQ.success) throw Errors.badRequest("invalid query");
    const { direction } = parsedQ.data;

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    const inbound =
      direction === "out"
        ? []
        : await prisma.userRelationship.findMany({
            where: { gameId, targetJunjoUserId: userId, type: "request" },
            orderBy: { createdAt: "desc" },
          });
    const outbound =
      direction === "in"
        ? []
        : await prisma.userRelationship.findMany({
            where: { gameId, actorJunjoUserId: userId, type: "request" },
            orderBy: { createdAt: "desc" },
          });

    return c.json<WireFriendRequestList>({
      inbound: inbound.map(toWireRequest),
      outbound: outbound.map(toWireRequest),
    });
  };
}

export function acceptFriendRequestHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    const request = await prisma.userRelationship.findUnique({ where: { id } });
    // Game-scoping: the request must belong to the calling API key's
    // game. A cross-game lookup attempt returns 404 (not 403) so the
    // existence of foreign request IDs is not leaked.
    if (!request || request.gameId !== gameId || request.type !== "request") {
      throw Errors.notFound("friend request");
    }

    // Cap check for the accepter. The original sender was bounded at
    // request time, but their headroom may have shrunk between then
    // and now (other accepted requests).
    const accepterFriends = await prisma.userRelationship.count({
      where: { gameId, actorJunjoUserId: request.targetJunjoUserId, type: "friend" },
    });
    if (accepterFriends >= config.friends.maxFriends) {
      throw Errors.badRequest(`friend cap reached (${config.friends.maxFriends})`);
    }
    const senderFriends = await prisma.userRelationship.count({
      where: { gameId, actorJunjoUserId: request.actorJunjoUserId, type: "friend" },
    });
    if (senderFriends >= config.friends.maxFriends) {
      throw Errors.badRequest(`sender friend cap reached (${config.friends.maxFriends})`);
    }

    const now = new Date();
    const [promotedSender] = await prisma.$transaction([
      // Promote the original request row to "friend" so its createdAt
      // becomes the audit-quality "request originated at" timestamp;
      // respondedAt records the accept time.
      prisma.userRelationship.update({
        where: { id },
        data: { type: "friend", respondedAt: now },
      }),
      // Write the mirror row so "is X a friend of Y?" is a single-row
      // read on either side. The mirror's createdAt is the accept time
      // (the friendship from the accepter's POV begins now).
      prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: request.targetJunjoUserId,
          targetJunjoUserId: request.actorJunjoUserId,
          type: "friend",
          respondedAt: now,
        },
      }),
    ]);

    return c.json<WireFriendship>(toWireFriendshipFromActorPOV(promotedSender));
  };
}

export function declineFriendRequestHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    const request = await prisma.userRelationship.findUnique({ where: { id } });
    if (!request || request.gameId !== gameId || request.type !== "request") {
      throw Errors.notFound("friend request");
    }
    await prisma.userRelationship.delete({ where: { id } });
    return c.body(null, 204);
  };
}

export function cancelFriendRequestHandler(prisma: PrismaClient): Handler {
  // Same wire path as decline (DELETE /v1/friend-requests/:id) — the
  // outbound sender's "I changed my mind" flow. Distinguished from
  // decline by who is calling: V1 has no per-user auth so the handler
  // accepts either party deleting a pending request. The dashboard's
  // UX surfaces them as separate affordances; the wire-level result is
  // identical.
  return declineFriendRequestHandler(prisma);
}

export function listFriendsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const parsedQ = listFriendsQuery.safeParse(c.req.query());
    if (!parsedQ.success) throw Errors.badRequest("invalid query");
    const { limit, cursor } = parsedQ.data;

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    // Keyset pagination by respondedAt DESC, id DESC. The cursor is the
    // last-row's respondedAt-ISO and id joined by "|". For rows with
    // null respondedAt (auto-accept paths created before respondedAt
    // was always set, theoretical only — every "friend" row gets a
    // respondedAt in current code) the createdAt is the fallback.
    const cursorDate = cursor ? parseCursor(cursor) : null;

    const rows = await prisma.userRelationship.findMany({
      where: {
        gameId,
        actorJunjoUserId: userId,
        type: "friend",
        ...(cursorDate
          ? {
              OR: [
                { respondedAt: { lt: cursorDate.respondedAt } },
                {
                  respondedAt: cursorDate.respondedAt,
                  id: { lt: cursorDate.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ respondedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map(toWireFriendshipFromActorPOV);
    const last = hasMore ? rows[limit - 1] : null;
    const nextCursor = last?.respondedAt ? formatCursor(last.respondedAt, last.id) : null;

    return c.json<WireFriendshipList>({ items, nextCursor });
  };
}

export function unfriendHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    const otherUserId = c.req.param("otherUserId");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!otherUserId) throw Errors.badRequest("otherUserId is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    const forward = await existingFriendship(prisma, gameId, userId, otherUserId);
    if (!forward) throw Errors.notFound("friendship");

    // Delete both rows in one transaction. The mirror's existence is
    // guaranteed by the accept path's two-row write; if it is missing
    // (manual DB tampering) the transaction still succeeds because
    // deleteMany silently returns 0 for an absent row.
    await prisma.$transaction([
      prisma.userRelationship.deleteMany({
        where: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId: otherUserId,
          type: "friend",
        },
      }),
      prisma.userRelationship.deleteMany({
        where: {
          gameId,
          actorJunjoUserId: otherUserId,
          targetJunjoUserId: userId,
          type: "friend",
        },
      }),
    ]);

    return c.body(null, 204);
  };
}

// =====================================================================
// Cursor encoding (private)
// =====================================================================

function formatCursor(respondedAt: Date, id: string): string {
  return `${respondedAt.toISOString()}|${id}`;
}

function parseCursor(raw: string): { respondedAt: Date; id: string } | null {
  const idx = raw.indexOf("|");
  if (idx === -1) return null;
  const ts = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return null;
  return { respondedAt: date, id };
}

// =====================================================================
// Block wire shapes + handlers
// =====================================================================

export interface WireBlock {
  id: string;
  gameId: string;
  // The OTHER party from the requesting user's POV; matches the
  // friendship wire shape's `junjoUserId` field for symmetry.
  junjoUserId: string;
  blockedAt: string;
}

export interface WireBlockList {
  items: WireBlock[];
}

function toWireBlockFromActorPOV(row: UserRelationship): WireBlock {
  return {
    id: row.id,
    gameId: row.gameId,
    junjoUserId: row.targetJunjoUserId,
    blockedAt: row.createdAt.toISOString(),
  };
}

export function addBlockHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = addBlockBody.safeParse(json);
    if (!parsed.success) throw Errors.badRequest("invalid body");
    const { targetJunjoUserId } = parsed.data;
    if (targetJunjoUserId === userId) {
      throw Errors.badRequest("cannot block yourself");
    }

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.blocks.enabled) throw Errors.notFound("resource");

    await ensureUserExists(prisma, userId);
    await ensureUserExists(prisma, targetJunjoUserId);

    // Idempotent: if a block already exists, just return it. The
    // dashboard's UX may surface "block" as a tappable affordance and
    // a stray double-click should not produce a 409.
    const existing = await prisma.userRelationship.findUnique({
      where: {
        gameId_actorJunjoUserId_targetJunjoUserId_type: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId,
          type: "blocked",
        },
      },
    });
    if (existing) {
      return c.json<WireBlock>(toWireBlockFromActorPOV(existing));
    }

    // Block-implicit-cleanup: a single transaction creates the block
    // row AND removes any friendship rows in either direction AND
    // removes any pending friend requests in either direction. Done
    // in one tx so no observer can see a half-applied state where the
    // block exists but the friendship still does.
    const [block] = await prisma.$transaction([
      prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId,
          type: "blocked",
        },
      }),
      prisma.userRelationship.deleteMany({
        where: {
          gameId,
          type: { in: ["friend", "request"] },
          OR: [
            { actorJunjoUserId: userId, targetJunjoUserId },
            { actorJunjoUserId: targetJunjoUserId, targetJunjoUserId: userId },
          ],
        },
      }),
    ]);

    return c.json<WireBlock>(toWireBlockFromActorPOV(block), 201);
  };
}

export function removeBlockHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    const otherUserId = c.req.param("otherUserId");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!otherUserId) throw Errors.badRequest("otherUserId is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.blocks.enabled) throw Errors.notFound("resource");

    const existing = await prisma.userRelationship.findUnique({
      where: {
        gameId_actorJunjoUserId_targetJunjoUserId_type: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId: otherUserId,
          type: "blocked",
        },
      },
    });
    if (!existing) throw Errors.notFound("block");

    await prisma.userRelationship.delete({ where: { id: existing.id } });
    return c.body(null, 204);
  };
}

export function listBlocksHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const parsedQ = listBlocksQuery.safeParse(c.req.query());
    if (!parsedQ.success) throw Errors.badRequest("invalid query");
    const { limit } = parsedQ.data;

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.blocks.enabled) throw Errors.notFound("resource");

    const rows = await prisma.userRelationship.findMany({
      where: { gameId, actorJunjoUserId: userId, type: "blocked" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return c.json<WireBlockList>({ items: rows.map(toWireBlockFromActorPOV) });
  };
}
