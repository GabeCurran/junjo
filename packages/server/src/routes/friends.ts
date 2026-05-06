// Friend request and friendship lifecycle routes (per-game API key
// gated). Every handler reads the game's resolved GameConfig first and
// 404s on `friends.enabled = false` so feature absence is invisible.
//
// Block routes, webhook events, and scope=network query expansion land
// in the next commit. This file deliberately handles only the local
// (per-game scope) request/accept/decline/cancel/list/unfriend flow.

import type {
  FriendRemovedEvent,
  FriendRequestAcceptedEvent,
  FriendRequestSentEvent,
  GameId,
} from "@junjo/shared";
import type { PrismaClient, UserRelationship } from "@prisma/client";
import type { Handler } from "hono";
import { gameIdsInScope, loadGameConfig } from "../config/loadGameConfig.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { dispatchEvent } from "../events.js";
import {
  addBlockBody,
  listBlocksQuery,
  listFriendRequestsQuery,
  listFriendsQuery,
  sendFriendRequestBody,
} from "./friends.schema.js";
import { canViewFriendsList } from "./visibility.js";

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

// Scope-aware lookups: under scope="network" the friend / pending /
// block check spans every sibling game whose scope is also "network".
// Validates against the full visible state, not just the calling game,
// so a duplicate friendship cannot be created from a sibling game.
async function existingFriendship(
  prisma: PrismaClient,
  gameIds: string[],
  a: string,
  b: string,
): Promise<UserRelationship | null> {
  return prisma.userRelationship.findFirst({
    where: {
      gameId: { in: gameIds },
      actorJunjoUserId: a,
      targetJunjoUserId: b,
      type: "friend",
    },
  });
}

async function existingPendingRequest(
  prisma: PrismaClient,
  gameIds: string[],
  actor: string,
  target: string,
): Promise<UserRelationship | null> {
  return prisma.userRelationship.findFirst({
    where: {
      gameId: { in: gameIds },
      actorJunjoUserId: actor,
      targetJunjoUserId: target,
      type: "request",
    },
  });
}

// Caps are enforced across the visible scope (network-wide when
// scope=network), not per-game. Otherwise a user could max out the
// limit independently in each sibling game and overshoot the
// user-visible friend list.
async function assertCapsBeforeWrite(
  prisma: PrismaClient,
  gameIds: string[],
  actorJunjoUserId: string,
  caps: { maxFriends: number; maxPendingRequests: number },
  kind: "request" | "friend",
): Promise<void> {
  if (kind === "request") {
    const pending = await prisma.userRelationship.count({
      where: { gameId: { in: gameIds }, actorJunjoUserId, type: "request" },
    });
    if (pending >= caps.maxPendingRequests) {
      throw Errors.badRequest(`outbound friend request cap reached (${caps.maxPendingRequests})`);
    }
  }
  const friends = await prisma.userRelationship.count({
    where: { gameId: { in: gameIds }, actorJunjoUserId, type: "friend" },
  });
  if (friends >= caps.maxFriends) {
    throw Errors.badRequest(`friend cap reached (${caps.maxFriends})`);
  }
}

// =====================================================================
// Handlers
// =====================================================================

export function sendFriendRequestHandler(prisma: PrismaClient, hub: EventHub): Handler {
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
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const config = loaded.config;
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    await ensureUserExists(prisma, userId);
    await ensureUserExists(prisma, targetJunjoUserId);

    // Block guard, scope-aware. A block in any sibling game in the
    // network silently rejects the request (404).
    const blockExists = await prisma.userRelationship.findFirst({
      where: {
        gameId: { in: visibleGameIds },
        type: "blocked",
        OR: [
          { actorJunjoUserId: userId, targetJunjoUserId },
          { actorJunjoUserId: targetJunjoUserId, targetJunjoUserId: userId },
        ],
      },
      select: { id: true },
    });
    if (blockExists) throw Errors.notFound("user");

    // Existence guards span the visible scope so a duplicate friendship
    // cannot be created from a sibling game in the same network.
    const existingForward = await existingFriendship(
      prisma,
      visibleGameIds,
      userId,
      targetJunjoUserId,
    );
    if (existingForward) {
      throw Errors.badRequest("already friends");
    }
    const existingOutboundReq = await existingPendingRequest(
      prisma,
      visibleGameIds,
      userId,
      targetJunjoUserId,
    );
    if (existingOutboundReq) {
      throw Errors.badRequest("a pending friend request already exists");
    }
    const existingInboundReq = await existingPendingRequest(
      prisma,
      visibleGameIds,
      targetJunjoUserId,
      userId,
    );
    if (existingInboundReq) {
      throw Errors.badRequest("a pending friend request from this user already exists; accept it");
    }

    await assertCapsBeforeWrite(prisma, visibleGameIds, userId, config.friends, "request");

    if (config.friends.requestsRequired) {
      const row = await prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId,
          type: "request",
        },
      });
      await dispatchEvent<FriendRequestSentEvent>(prisma, hub, {
        type: "friend.request.sent",
        gameId: gameId as GameId,
        requestId: row.id,
        actorJunjoUserId: userId,
        targetJunjoUserId,
      });
      return c.json<WireFriendRequestSendResult>(
        { status: "pending", request: toWireRequest(row) },
        201,
      );
    }

    // Auto-accept path: write the two friend rows in one transaction.
    // The accepter cap is checked here against the target's visible
    // scope.
    const targetFriends = await prisma.userRelationship.count({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: targetJunjoUserId,
        type: "friend",
      },
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
    // Auto-accept: both parties get the accepted-event because neither
    // explicitly chose to accept (the request WAS the acceptance).
    await dispatchEvent<FriendRequestAcceptedEvent>(prisma, hub, {
      type: "friend.request.accepted",
      gameId: gameId as GameId,
      relationshipId: actorRow.id,
      actorJunjoUserId: userId,
      targetJunjoUserId,
      respondedAt: now,
    });
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
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const inbound =
      direction === "out"
        ? []
        : await prisma.userRelationship.findMany({
            where: { gameId: { in: visibleGameIds }, targetJunjoUserId: userId, type: "request" },
            orderBy: { createdAt: "desc" },
          });
    const outbound =
      direction === "in"
        ? []
        : await prisma.userRelationship.findMany({
            where: { gameId: { in: visibleGameIds }, actorJunjoUserId: userId, type: "request" },
            orderBy: { createdAt: "desc" },
          });

    return c.json<WireFriendRequestList>({
      inbound: inbound.map(toWireRequest),
      outbound: outbound.map(toWireRequest),
    });
  };
}

export function acceptFriendRequestHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const config = loaded.config;
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const request = await prisma.userRelationship.findUnique({ where: { id } });
    // Scope-aware: a request from a sibling game in the same network
    // can be accepted from this game's API key. A request from outside
    // the visible scope returns 404.
    if (!request || !visibleGameIds.includes(request.gameId) || request.type !== "request") {
      throw Errors.notFound("friend request");
    }

    // Cap checks span the visible scope (network-wide when applicable).
    const accepterFriends = await prisma.userRelationship.count({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: request.targetJunjoUserId,
        type: "friend",
      },
    });
    if (accepterFriends >= config.friends.maxFriends) {
      throw Errors.badRequest(`friend cap reached (${config.friends.maxFriends})`);
    }
    const senderFriends = await prisma.userRelationship.count({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: request.actorJunjoUserId,
        type: "friend",
      },
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
      // read on either side. The mirror's gameId matches the request's
      // originating gameId (not the calling game's gameId) so a sibling
      // game accepting a request keeps the friendship anchored to its
      // origin.
      prisma.userRelationship.create({
        data: {
          gameId: request.gameId,
          actorJunjoUserId: request.targetJunjoUserId,
          targetJunjoUserId: request.actorJunjoUserId,
          type: "friend",
          respondedAt: now,
        },
      }),
    ]);

    // Fires under the request's originating gameId so webhook
    // subscribers in that game see the lifecycle they originally saw
    // start.
    await dispatchEvent<FriendRequestAcceptedEvent>(prisma, hub, {
      type: "friend.request.accepted",
      gameId: request.gameId as GameId,
      relationshipId: promotedSender.id,
      actorJunjoUserId: request.actorJunjoUserId,
      targetJunjoUserId: request.targetJunjoUserId,
      respondedAt: now,
    });

    return c.json<WireFriendship>(toWireFriendshipFromActorPOV(promotedSender));
  };
}

export function declineFriendRequestHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const request = await prisma.userRelationship.findUnique({ where: { id } });
    if (!request || !visibleGameIds.includes(request.gameId) || request.type !== "request") {
      throw Errors.notFound("friend request");
    }
    await prisma.userRelationship.delete({ where: { id } });
    return c.body(null, 204);
  };
}

export function cancelFriendRequestHandler(prisma: PrismaClient): Handler {
  // Same wire path as decline (DELETE /v1/friend-requests/:id); the
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
    const { limit, cursor, tagId, viewer } = parsedQ.data;

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");

    // Tag filtering bounds visibility to the calling game (tags are
    // per-game; see listFriendsQuery doc). Otherwise the visible scope
    // expands per friends.scope.
    const useTagFilter = tagId !== undefined;
    if (useTagFilter && !loaded.config.friends.tags.enabled) {
      throw Errors.notFound("resource");
    }
    const visibleGameIds = useTagFilter ? [gameId] : await gameIdsInScope(prisma, loaded);

    // Visibility enforcement. Bypassed when no `viewer` is supplied
    // (admin caller); applied when the dashboard provides one.
    const allowed = await canViewFriendsList(
      prisma,
      visibleGameIds,
      loaded.config,
      userId,
      viewer ?? null,
    );
    if (!allowed) throw Errors.notFound("user");

    // Keyset pagination by respondedAt DESC, id DESC. Cursor is the
    // last row's respondedAt-ISO and id joined by "|".
    const cursorDate = cursor ? parseCursor(cursor) : null;

    const rows = await prisma.userRelationship.findMany({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: userId,
        type: "friend",
        ...(useTagFilter
          ? {
              relationshipTags: { some: { friendTagId: tagId } },
            }
          : {}),
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

export function unfriendHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    const otherUserId = c.req.param("otherUserId");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!otherUserId) throw Errors.badRequest("otherUserId is required");

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const forward = await existingFriendship(prisma, visibleGameIds, userId, otherUserId);
    if (!forward) throw Errors.notFound("friendship");

    // Delete both rows in one transaction. Both rows scope to the
    // friendship's originating game (which may be a sibling under
    // scope=network, not necessarily the calling game).
    await prisma.$transaction([
      prisma.userRelationship.deleteMany({
        where: {
          gameId: forward.gameId,
          actorJunjoUserId: userId,
          targetJunjoUserId: otherUserId,
          type: "friend",
        },
      }),
      prisma.userRelationship.deleteMany({
        where: {
          gameId: forward.gameId,
          actorJunjoUserId: otherUserId,
          targetJunjoUserId: userId,
          type: "friend",
        },
      }),
    ]);

    // Fires under the friendship's originating gameId so the webhook
    // subscribers in that game see the removal even when the action
    // was triggered from a sibling game.
    await dispatchEvent<FriendRemovedEvent>(prisma, hub, {
      type: "friend.removed",
      gameId: forward.gameId as GameId,
      removedByJunjoUserId: userId,
      otherJunjoUserId: otherUserId,
    });

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
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.blocks.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    await ensureUserExists(prisma, userId);
    await ensureUserExists(prisma, targetJunjoUserId);

    // Idempotent across the visible scope: a sibling-game block of the
    // same target returns its row instead of creating a duplicate.
    const existing = await prisma.userRelationship.findFirst({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: userId,
        targetJunjoUserId,
        type: "blocked",
      },
    });
    if (existing) {
      return c.json<WireBlock>(toWireBlockFromActorPOV(existing));
    }

    // Cleanup deletes spans the visible scope (a friendship from a
    // sibling game in the same network must also disappear).
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
          gameId: { in: visibleGameIds },
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
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.blocks.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    // Find the block row across the visible scope; deletion targets
    // the row by primary key so it removes the originating-game row.
    const existing = await prisma.userRelationship.findFirst({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: userId,
        targetJunjoUserId: otherUserId,
        type: "blocked",
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
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.blocks.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const rows = await prisma.userRelationship.findMany({
      where: { gameId: { in: visibleGameIds }, actorJunjoUserId: userId, type: "blocked" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return c.json<WireBlockList>({ items: rows.map(toWireBlockFromActorPOV) });
  };
}
