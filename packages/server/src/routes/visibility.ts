// Per-(user, game) friendsListVisibility setting + enforcement helpers.
// Stored in the UserVisibility table; reads fall back to
// `config.friends.visibility.default` when no row exists. Writes
// validate against `config.friends.visibility.allowed`.
//
// Identity contract: path param `:userId` is the EXTERNAL user id;
// resolved to `JunjoUser.id` via findOrCreateJunjoUser (set) or
// findJunjoUserId (get). The wire `junjoUserId` field on the response
// echoes the external id supplied by the caller for round-trip parity
// (the field name is historical; see `friends.ts` header).
//
// Enforcement on read paths is admin-bypassed in V1 because the only
// caller principal is the per-game API key (always admin-class). The
// `viewer` query parameter on `GET /v1/users/:userId/friends` lets
// the dashboard simulate a player-perspective lookup; when supplied,
// the server applies the visibility rules. Without it, admin sees all.
// `canViewFriendsList` takes internal JunjoUser ids (resolved by the
// list handler before calling) so this helper stays decoupled from
// the external-id resolution path.

import type { FriendsListVisibility, GameConfig } from "@junjo/shared";
import type { PrismaClient, UserVisibility } from "@prisma/client";
import type { Handler } from "hono";
import { z } from "zod";
import { loadGameConfig } from "../config/loadGameConfig.js";
import { friendsListVisibilitySchema } from "../config/schema.js";
import { Errors } from "../errors.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";

// =====================================================================
// Wire shapes
// =====================================================================

export interface WireUserVisibility {
  gameId: string;
  junjoUserId: string;
  friendsListVisibility: FriendsListVisibility;
  // The set the caller may switch to, surfaced so the dashboard
  // can render the right radio options without a separate config fetch.
  allowed: FriendsListVisibility[];
  updatedAt: string | null;
}

const setVisibilityBody = z
  .object({
    friendsListVisibility: friendsListVisibilitySchema,
  })
  .strict();

function toWire(
  gameId: string,
  externalUserId: string,
  row: UserVisibility | null,
  config: GameConfig,
): WireUserVisibility {
  return {
    gameId,
    junjoUserId: externalUserId,
    friendsListVisibility:
      (row?.friendsListVisibility as FriendsListVisibility) ?? config.friends.visibility.default,
    allowed: config.friends.visibility.allowed,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
  };
}

// =====================================================================
// Routes
// =====================================================================

export function getUserVisibilityHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    if (!actorJid) {
      // Never-seen user: surface the game default without writing a row.
      return c.json<WireUserVisibility>(toWire(gameId, userId, null, config));
    }

    const row = await prisma.userVisibility.findUnique({
      where: { gameId_junjoUserId: { gameId, junjoUserId: actorJid } },
    });
    return c.json<WireUserVisibility>(toWire(gameId, userId, row, config));
  };
}

export function setUserVisibilityHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = setVisibilityBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }
    const requested = parsed.data.friendsListVisibility as FriendsListVisibility;

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled) throw Errors.notFound("resource");

    if (!config.friends.visibility.allowed.includes(requested)) {
      throw Errors.badRequest(
        `visibility "${requested}" is not in this game's allowed set: ` +
          `[${config.friends.visibility.allowed.join(", ")}]`,
      );
    }

    // Auto-vivify the JunjoUser on first reference so the upsert
    // below has a valid FK target. Matches the auto-create pattern
    // on every other write path.
    const actorJid = await findOrCreateJunjoUser(prisma, gameId, userId);

    const row = await prisma.userVisibility.upsert({
      where: { gameId_junjoUserId: { gameId, junjoUserId: actorJid } },
      create: { gameId, junjoUserId: actorJid, friendsListVisibility: requested },
      update: { friendsListVisibility: requested },
    });
    return c.json<WireUserVisibility>(toWire(gameId, userId, row, config));
  };
}

// =====================================================================
// Enforcement helper (used by the friends list handler)
// =====================================================================

// Decides whether `viewer` may see `target`'s friend list in the given
// game. Returns true when:
//   - viewer is null/undefined (admin caller, V1 default; bypass)
//   - viewer === target (own data)
//   - target's visibility is "public"
//   - target's visibility is "friends-only" AND viewer is a confirmed
//     friend within the visible scope
// Returns false on "private" + non-self viewer.
//
// Takes internal `JunjoUser.id` values; the list handler resolves
// external ids to junjo ids before calling.
export async function canViewFriendsList(
  prisma: PrismaClient,
  visibleGameIds: string[],
  config: GameConfig,
  targetJunjoUserId: string,
  viewerJunjoUserId: string | null,
): Promise<boolean> {
  if (!viewerJunjoUserId) return true; // admin caller
  if (viewerJunjoUserId === targetJunjoUserId) return true;

  const row = await prisma.userVisibility.findFirst({
    where: { gameId: { in: visibleGameIds }, junjoUserId: targetJunjoUserId },
    orderBy: { updatedAt: "desc" }, // multiple rows under network scope: most-recent wins
  });
  const visibility =
    (row?.friendsListVisibility as FriendsListVisibility | undefined) ??
    config.friends.visibility.default;

  if (visibility === "public") return true;
  if (visibility === "private") return false;

  // friends-only: must be confirmed friends in the visible scope.
  const friendship = await prisma.userRelationship.findFirst({
    where: {
      gameId: { in: visibleGameIds },
      actorJunjoUserId: targetJunjoUserId,
      targetJunjoUserId: viewerJunjoUserId,
      type: "friend",
    },
    select: { id: true },
  });
  return friendship !== null;
}
