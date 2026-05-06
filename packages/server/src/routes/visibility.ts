// Per-(user, game) friendsListVisibility setting + enforcement helpers.
// Stored in the UserVisibility table; reads fall back to
// `config.friends.visibility.default` when no row exists. Writes
// validate against `config.friends.visibility.allowed`.
//
// Enforcement on read paths is admin-bypassed in V1 because the only
// caller principal is the per-game API key (always admin-class). The
// `viewerJunjoUserId` query parameter on `GET /v1/users/:userId/friends`
// lets the dashboard simulate a player-perspective lookup; when supplied,
// the server applies the visibility rules. Without it, admin sees all.

import type { FriendsListVisibility, GameConfig } from "@junjo/shared";
import type { PrismaClient, UserVisibility } from "@prisma/client";
import type { Handler } from "hono";
import { z } from "zod";
import { loadGameConfig } from "../config/loadGameConfig.js";
import { friendsListVisibilitySchema } from "../config/schema.js";
import { Errors } from "../errors.js";

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
  junjoUserId: string,
  row: UserVisibility | null,
  config: GameConfig,
): WireUserVisibility {
  return {
    gameId,
    junjoUserId,
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

    const row = await prisma.userVisibility.findUnique({
      where: { gameId_junjoUserId: { gameId, junjoUserId: userId } },
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

    // Confirm the user exists; the upsert would otherwise silently
    // create rows for non-existent JunjoUsers (the FK would reject it,
    // but the error surface would be a noisy 500 instead of a clean 404).
    const exists = await prisma.junjoUser.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw Errors.notFound("user");

    const row = await prisma.userVisibility.upsert({
      where: { gameId_junjoUserId: { gameId, junjoUserId: userId } },
      create: { gameId, junjoUserId: userId, friendsListVisibility: requested },
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
