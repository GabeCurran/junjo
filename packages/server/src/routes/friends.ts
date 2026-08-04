// Friend request and friendship lifecycle routes (per-game API key
// gated). Every handler reads the game's resolved GameConfig first and
// 404s on `friends.enabled = false` so feature absence is invisible.
//
// Identity contract (matches the rest of the Junjo server): path params
// and body fields named `userId` / `targetJunjoUserId` / `viewerUserId`
// / `otherUserId` carry the dev's EXTERNAL user id (Clerk sub, Supabase
// uuid, Reibu cuid, Roblox UserId-as-string, etc.). Each handler
// resolves the external id to the internal `JunjoUser.id` via
// `findOrCreateJunjoUser` (for write paths that should auto-vivify a
// missing user) or `findJunjoUserId` (for read paths that should
// surface "no relationship" without writing anything). All DB queries
// and writes use the resolved internal cuid; wire output and event
// payloads translate back to the external id so consumers see the
// same value they sent in. This matches the auto-vivify-on-first-
// reference behavior of groups, invitations, leave, kick, ban, etc.
// The wire field names retain their `*JunjoUserId` form for backwards
// compatibility with existing consumers, but the VALUES are external
// ids in v1.

import type {
  FriendBlockedEvent,
  FriendRemovedEvent,
  FriendRequestAcceptedEvent,
  FriendRequestCancelledEvent,
  FriendRequestDeclinedEvent,
  FriendRequestSentEvent,
  FriendUnblockedEvent,
  FriendshipRelationship,
  FriendshipState,
  GameId,
} from "@junjo-io/shared";
import type { PrismaClient, UserRelationship } from "@prisma/client";
import type { Handler } from "hono";
import { gameIdsInScope, loadGameConfig } from "../config/loadGameConfig.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { dispatchEvent } from "../events.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";
import {
  addBlockBody,
  listBlocksQuery,
  listFriendRequestsQuery,
  listFriendsQuery,
  sendFriendRequestBody,
} from "./friends.schema.js";
import { batchLoadExternalUserIds } from "./members.js";
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

// Externals map: junjoUserId -> externalUserId. Built from a batch
// lookup over the calling game's ExternalIdentity rows. A junjoUserId
// with no mapping in the calling game falls back to the raw cuid (the
// wire field is documented as opaque-to-consumer; this is the safest
// fallback for cross-network rows where the sibling game's mapping is
// not visible).
function externalOr(externals: Map<string, string>, junjoUserId: string): string {
  return externals.get(junjoUserId) ?? junjoUserId;
}

function toWireRequest(row: UserRelationship, externals: Map<string, string>): WireFriendRequest {
  return {
    id: row.id,
    gameId: row.gameId,
    actorJunjoUserId: externalOr(externals, row.actorJunjoUserId),
    targetJunjoUserId: externalOr(externals, row.targetJunjoUserId),
    createdAt: row.createdAt.toISOString(),
  };
}

function toWireFriendshipFromActorPOV(
  row: UserRelationship,
  externals: Map<string, string>,
): WireFriendship {
  return {
    id: row.id,
    gameId: row.gameId,
    junjoUserId: externalOr(externals, row.targetJunjoUserId),
    since: (row.respondedAt ?? row.createdAt).toISOString(),
  };
}

// =====================================================================
// Helpers
// =====================================================================

// Batch-load externals for every (actor, target) pair touched by a
// page of relationship rows. Uses the calling game's mapping table.
async function externalsForRows(
  prisma: PrismaClient,
  gameId: string,
  rows: UserRelationship[],
): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const r of rows) {
    ids.add(r.actorJunjoUserId);
    ids.add(r.targetJunjoUserId);
  }
  if (ids.size === 0) return new Map();
  return batchLoadExternalUserIds(prisma, gameId, [...ids]);
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

    // Resolve external ids to internal JunjoUser cuids, auto-creating
    // both rows if absent. Mirrors how groups.create / invitations.accept
    // / leave / ban / kick auto-vivify on first reference.
    const actorJid = await findOrCreateJunjoUser(prisma, gameId, userId);
    const targetJid = await findOrCreateJunjoUser(prisma, gameId, targetJunjoUserId);

    // Block guard, scope-aware. A block in any sibling game in the
    // network silently rejects the request (404).
    const blockExists = await prisma.userRelationship.findFirst({
      where: {
        gameId: { in: visibleGameIds },
        type: "blocked",
        OR: [
          { actorJunjoUserId: actorJid, targetJunjoUserId: targetJid },
          { actorJunjoUserId: targetJid, targetJunjoUserId: actorJid },
        ],
      },
      select: { id: true },
    });
    if (blockExists) throw Errors.notFound("user");

    // Existence guards span the visible scope so a duplicate friendship
    // cannot be created from a sibling game in the same network.
    const existingForward = await existingFriendship(prisma, visibleGameIds, actorJid, targetJid);
    if (existingForward) {
      throw Errors.badRequest("already friends");
    }
    const existingOutboundReq = await existingPendingRequest(
      prisma,
      visibleGameIds,
      actorJid,
      targetJid,
    );
    if (existingOutboundReq) {
      throw Errors.badRequest("a pending friend request already exists");
    }
    const existingInboundReq = await existingPendingRequest(
      prisma,
      visibleGameIds,
      targetJid,
      actorJid,
    );
    if (existingInboundReq) {
      throw Errors.badRequest("a pending friend request from this user already exists; accept it");
    }

    await assertCapsBeforeWrite(prisma, visibleGameIds, actorJid, config.friends, "request");

    if (config.friends.requestsRequired) {
      const row = await prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: actorJid,
          targetJunjoUserId: targetJid,
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
      const externals = new Map<string, string>([
        [actorJid, userId],
        [targetJid, targetJunjoUserId],
      ]);
      return c.json<WireFriendRequestSendResult>(
        { status: "pending", request: toWireRequest(row, externals) },
        201,
      );
    }

    // Auto-accept path: write the two friend rows in one transaction.
    // The accepter cap is checked here against the target's visible
    // scope.
    const targetFriends = await prisma.userRelationship.count({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: targetJid,
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
          actorJunjoUserId: actorJid,
          targetJunjoUserId: targetJid,
          type: "friend",
          respondedAt: now,
        },
      }),
      prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: targetJid,
          targetJunjoUserId: actorJid,
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
    const externals = new Map<string, string>([
      [actorJid, userId],
      [targetJid, targetJunjoUserId],
    ]);
    return c.json<WireFriendRequestSendResult>(
      { status: "auto-accepted", friendship: toWireFriendshipFromActorPOV(actorRow, externals) },
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

    // Read-only resolve: a never-seen user has no requests by definition.
    // Skip the write that findOrCreate would do and return empty.
    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    if (!actorJid) {
      return c.json<WireFriendRequestList>({ inbound: [], outbound: [] });
    }

    const inbound =
      direction === "out"
        ? []
        : await prisma.userRelationship.findMany({
            where: {
              gameId: { in: visibleGameIds },
              targetJunjoUserId: actorJid,
              type: "request",
            },
            orderBy: { createdAt: "desc" },
          });
    const outbound =
      direction === "in"
        ? []
        : await prisma.userRelationship.findMany({
            where: {
              gameId: { in: visibleGameIds },
              actorJunjoUserId: actorJid,
              type: "request",
            },
            orderBy: { createdAt: "desc" },
          });

    const externals = await externalsForRows(prisma, gameId, [...inbound, ...outbound]);
    return c.json<WireFriendRequestList>({
      inbound: inbound.map((r) => toWireRequest(r, externals)),
      outbound: outbound.map((r) => toWireRequest(r, externals)),
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

    // Translate the request's stored JunjoUser cuids back to external
    // ids for the wire response and the dispatched event. Looks up
    // mappings in the request's originating game (not necessarily the
    // calling game; matters under scope=network).
    const externals = await batchLoadExternalUserIds(prisma, request.gameId, [
      request.actorJunjoUserId,
      request.targetJunjoUserId,
    ]);

    // Fires under the request's originating gameId so webhook
    // subscribers in that game see the lifecycle they originally saw
    // start.
    await dispatchEvent<FriendRequestAcceptedEvent>(prisma, hub, {
      type: "friend.request.accepted",
      gameId: request.gameId as GameId,
      relationshipId: promotedSender.id,
      actorJunjoUserId: externalOr(externals, request.actorJunjoUserId),
      targetJunjoUserId: externalOr(externals, request.targetJunjoUserId),
      respondedAt: now,
    });

    return c.json<WireFriendship>(toWireFriendshipFromActorPOV(promotedSender, externals));
  };
}

// Shared deletion path for decline + cancel. Returns the deleted
// request row so the route handler can dispatch the appropriate event
// with the (sender, target) ids preserved.
async function deletePendingRequest(
  prisma: PrismaClient,
  visibleGameIds: string[],
  id: string,
): Promise<UserRelationship> {
  const request = await prisma.userRelationship.findUnique({ where: { id } });
  if (!request || !visibleGameIds.includes(request.gameId) || request.type !== "request") {
    throw Errors.notFound("friend request");
  }
  await prisma.userRelationship.delete({ where: { id } });
  return request;
}

// POST /v1/friend-requests/:id/decline -- the recipient rejects.
// The URL path disambiguates this from cancel (decline is the
// recipient saying no; cancel is the sender retracting their own
// request). Fires `friend.request.declined` with the participant
// ids preserved from the original request row.
export function declineFriendRequestHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const request = await deletePendingRequest(prisma, visibleGameIds, id);

    const externals = await batchLoadExternalUserIds(prisma, request.gameId, [
      request.actorJunjoUserId,
      request.targetJunjoUserId,
    ]);
    await dispatchEvent<FriendRequestDeclinedEvent>(prisma, hub, {
      type: "friend.request.declined",
      gameId: request.gameId as GameId,
      requestId: request.id,
      actorJunjoUserId: externalOr(externals, request.actorJunjoUserId),
      targetJunjoUserId: externalOr(externals, request.targetJunjoUserId),
    });
    return c.body(null, 204);
  };
}

// DELETE /v1/friend-requests/:id -- the original sender retracts.
// Distinct route from decline; fires `friend.request.cancelled`.
export function cancelFriendRequestHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const request = await deletePendingRequest(prisma, visibleGameIds, id);

    const externals = await batchLoadExternalUserIds(prisma, request.gameId, [
      request.actorJunjoUserId,
      request.targetJunjoUserId,
    ]);
    await dispatchEvent<FriendRequestCancelledEvent>(prisma, hub, {
      type: "friend.request.cancelled",
      gameId: request.gameId as GameId,
      requestId: request.id,
      actorJunjoUserId: externalOr(externals, request.actorJunjoUserId),
      targetJunjoUserId: externalOr(externals, request.targetJunjoUserId),
    });
    return c.body(null, 204);
  };
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

    // Read-only resolve. Unseen users have no friendships; return an
    // empty page without writing an ExternalIdentity row.
    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    if (!actorJid) {
      return c.json<WireFriendshipList>({ items: [], nextCursor: null });
    }
    // Resolve viewer if supplied. An unseen viewer falls through to
    // the public/private-visibility check (with a sentinel that won't
    // match any junjoUserId) rather than 404-ing -- a public profile
    // should still be visible to a not-yet-onboarded viewer. Without
    // a `viewer` param the caller is treated as admin (bypass).
    let viewerJid: string | null = null;
    if (viewer !== undefined) {
      const resolved = await findJunjoUserId(prisma, gameId, viewer);
      viewerJid = resolved ?? "__junjo_unseen_viewer__";
    }

    const allowed = await canViewFriendsList(
      prisma,
      visibleGameIds,
      loaded.config,
      actorJid,
      viewerJid,
    );
    if (!allowed) throw Errors.notFound("user");

    // Keyset pagination by respondedAt DESC, id DESC. Cursor is the
    // last row's respondedAt-ISO and id joined by "|".
    const cursorDate = cursor ? parseCursor(cursor) : null;

    const rows = await prisma.userRelationship.findMany({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: actorJid,
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
    const page = hasMore ? rows.slice(0, limit) : rows;
    const externals = await externalsForRows(prisma, gameId, page);
    const items = page.map((r) => toWireFriendshipFromActorPOV(r, externals));
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

    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    const otherJid = await findJunjoUserId(prisma, gameId, otherUserId);
    if (!actorJid || !otherJid) throw Errors.notFound("friendship");

    const forward = await existingFriendship(prisma, visibleGameIds, actorJid, otherJid);
    if (!forward) throw Errors.notFound("friendship");

    // Delete both rows in one transaction. Both rows scope to the
    // friendship's originating game (which may be a sibling under
    // scope=network, not necessarily the calling game).
    await prisma.$transaction([
      prisma.userRelationship.deleteMany({
        where: {
          gameId: forward.gameId,
          actorJunjoUserId: actorJid,
          targetJunjoUserId: otherJid,
          type: "friend",
        },
      }),
      prisma.userRelationship.deleteMany({
        where: {
          gameId: forward.gameId,
          actorJunjoUserId: otherJid,
          targetJunjoUserId: actorJid,
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

export interface WireFriendshipRelationship {
  state: FriendshipState;
  since: string | null;
}

// GET /v1/users/:viewerUserId/friends/:otherUserId/relationship
// Single-pair viewer-perspective probe. Priority: blocks first
// (viewer-side block wins on the both-blocked edge case), then
// friendship, then pending request direction, then "none".
export function getRelationshipHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const viewerUserId = c.req.param("viewerUserId");
    const otherUserId = c.req.param("otherUserId");
    if (!viewerUserId) throw Errors.badRequest("viewerUserId is required");
    if (!otherUserId) throw Errors.badRequest("otherUserId is required");
    if (viewerUserId === otherUserId) {
      throw Errors.badRequest("viewerUserId and otherUserId must differ");
    }

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    // Either party never-seen → no rows possible → "none". Read-only
    // resolve so the relationship probe doesn't accidentally auto-
    // vivify users that were only profile-views.
    const viewerJid = await findJunjoUserId(prisma, gameId, viewerUserId);
    const otherJid = await findJunjoUserId(prisma, gameId, otherUserId);
    if (!viewerJid || !otherJid) {
      return c.json<WireFriendshipRelationship>({ state: "none", since: null });
    }

    // One query pulls every relationship row in either direction across
    // the visible scope. Caller is per-game API key (trusted backend),
    // so no per-end-user visibility check beyond scope.
    const rows = await prisma.userRelationship.findMany({
      where: {
        gameId: { in: visibleGameIds },
        OR: [
          { actorJunjoUserId: viewerJid, targetJunjoUserId: otherJid },
          { actorJunjoUserId: otherJid, targetJunjoUserId: viewerJid },
        ],
      },
      orderBy: { createdAt: "desc" },
    });

    const result = resolveRelationship(viewerJid, otherJid, rows);
    return c.json<WireFriendshipRelationship>({
      state: result.state,
      since: result.since ? result.since.toISOString() : null,
    });
  };
}

function resolveRelationship(
  viewer: string,
  other: string,
  rows: UserRelationship[],
): FriendshipRelationship {
  let viewerBlocksOther: UserRelationship | null = null;
  let otherBlocksViewer: UserRelationship | null = null;
  let friendRow: UserRelationship | null = null;
  let outgoingRequest: UserRelationship | null = null;
  let incomingRequest: UserRelationship | null = null;

  for (const row of rows) {
    const fromViewer = row.actorJunjoUserId === viewer && row.targetJunjoUserId === other;
    const fromOther = row.actorJunjoUserId === other && row.targetJunjoUserId === viewer;
    if (row.type === "blocked") {
      if (fromViewer) viewerBlocksOther = row;
      else if (fromOther) otherBlocksViewer = row;
    } else if (row.type === "friend") {
      // Either direction's row is fine; the friendship is symmetric.
      // Prefer the row whose actor is the viewer for stable `since`
      // semantics; fall back otherwise.
      if (fromViewer || !friendRow) friendRow = row;
    } else if (row.type === "request") {
      if (fromViewer) outgoingRequest = row;
      else if (fromOther) incomingRequest = row;
    }
  }

  // Priority: viewer's block wins on the both-blocked edge case so the
  // viewer's UI shows the block they can act on.
  if (viewerBlocksOther) {
    return { state: "blocked_by_me", since: viewerBlocksOther.createdAt };
  }
  if (otherBlocksViewer) {
    return { state: "blocked_by_them", since: otherBlocksViewer.createdAt };
  }
  if (friendRow) {
    const since = friendRow.respondedAt ?? friendRow.createdAt;
    return { state: "friends", since };
  }
  if (outgoingRequest) {
    return { state: "request_outgoing", since: outgoingRequest.createdAt };
  }
  if (incomingRequest) {
    return { state: "request_incoming", since: incomingRequest.createdAt };
  }
  return { state: "none" };
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

function toWireBlockFromActorPOV(row: UserRelationship, externals: Map<string, string>): WireBlock {
  return {
    id: row.id,
    gameId: row.gameId,
    junjoUserId: externalOr(externals, row.targetJunjoUserId),
    blockedAt: row.createdAt.toISOString(),
  };
}

export function addBlockHandler(prisma: PrismaClient, hub: EventHub): Handler {
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

    const actorJid = await findOrCreateJunjoUser(prisma, gameId, userId);
    const targetJid = await findOrCreateJunjoUser(prisma, gameId, targetJunjoUserId);
    const externals = new Map<string, string>([
      [actorJid, userId],
      [targetJid, targetJunjoUserId],
    ]);

    // Idempotent across the visible scope: a sibling-game block of the
    // same target returns its row instead of creating a duplicate.
    // Idempotent calls do NOT re-fire the event (the state has not
    // changed for downstream subscribers).
    const existing = await prisma.userRelationship.findFirst({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: actorJid,
        targetJunjoUserId: targetJid,
        type: "blocked",
      },
    });
    if (existing) {
      return c.json<WireBlock>(toWireBlockFromActorPOV(existing, externals));
    }

    // Cleanup deletes spans the visible scope (a friendship from a
    // sibling game in the same network must also disappear).
    const [block] = await prisma.$transaction([
      prisma.userRelationship.create({
        data: {
          gameId,
          actorJunjoUserId: actorJid,
          targetJunjoUserId: targetJid,
          type: "blocked",
        },
      }),
      prisma.userRelationship.deleteMany({
        where: {
          gameId: { in: visibleGameIds },
          type: { in: ["friend", "request"] },
          OR: [
            { actorJunjoUserId: actorJid, targetJunjoUserId: targetJid },
            { actorJunjoUserId: targetJid, targetJunjoUserId: actorJid },
          ],
        },
      }),
    ]);

    await dispatchEvent<FriendBlockedEvent>(prisma, hub, {
      type: "friend.blocked",
      gameId: gameId as GameId,
      byJunjoUserId: userId,
      otherJunjoUserId: targetJunjoUserId,
    });

    return c.json<WireBlock>(toWireBlockFromActorPOV(block, externals), 201);
  };
}

export function removeBlockHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    const otherUserId = c.req.param("otherUserId");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!otherUserId) throw Errors.badRequest("otherUserId is required");

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.blocks.enabled) throw Errors.notFound("resource");
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    const otherJid = await findJunjoUserId(prisma, gameId, otherUserId);
    if (!actorJid || !otherJid) throw Errors.notFound("block");

    // Find the block row across the visible scope; deletion targets
    // the row by primary key so it removes the originating-game row.
    const existing = await prisma.userRelationship.findFirst({
      where: {
        gameId: { in: visibleGameIds },
        actorJunjoUserId: actorJid,
        targetJunjoUserId: otherJid,
        type: "blocked",
      },
    });
    if (!existing) throw Errors.notFound("block");

    await prisma.userRelationship.delete({ where: { id: existing.id } });

    // Fires under the block's originating gameId so the webhook
    // subscribers in that game see the lifecycle close where it
    // started (mirrors friend.removed under scope=network).
    await dispatchEvent<FriendUnblockedEvent>(prisma, hub, {
      type: "friend.unblocked",
      gameId: existing.gameId as GameId,
      byJunjoUserId: userId,
      otherJunjoUserId: otherUserId,
    });

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

    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    if (!actorJid) {
      return c.json<WireBlockList>({ items: [] });
    }

    const rows = await prisma.userRelationship.findMany({
      where: { gameId: { in: visibleGameIds }, actorJunjoUserId: actorJid, type: "blocked" },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    const externals = await externalsForRows(prisma, gameId, rows);
    return c.json<WireBlockList>({ items: rows.map((r) => toWireBlockFromActorPOV(r, externals)) });
  };
}
