// Friend tag routes. Tags are per-(user, gameId) and private to the
// owner; only the user who created the tag sees it applied to their
// friend rows. Tags only attach to the OWNER-side friend row, so each
// party tags friendships independently.
//
// Identity contract: path params `:userId` / `:otherUserId` are
// EXTERNAL user ids (see `friends.ts` header). Each handler resolves
// to internal `JunjoUser.id` via `findOrCreateJunjoUser` (writes) or
// `findJunjoUserId` (reads). Wire output's `junjoUserId` field carries
// the external id even though the field name is historical.
//
// Scope semantics: tags do NOT scope-expand under friends.scope=
// "network". A tag created in game A is invisible from game B even if
// they share a networkId. Tagging a friend whose row originated in a
// sibling game is therefore not supported in v1; the dashboard's tag
// dropdown filters its choices to tags whose gameId matches the friend
// row's gameId. Cross-network tag application is a v2+ feature.

import type { FriendTag, PrismaClient, UserRelationship } from "@prisma/client";
import type { Handler } from "hono";
import { loadGameConfig } from "../config/loadGameConfig.js";
import { Errors } from "../errors.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";
import { retryOnUniqueViolation } from "../prismaErrors.js";
import {
  createFriendTagBody,
  setFriendTagsBody,
  updateFriendTagBody,
} from "./friendTags.schema.js";
import { batchLoadExternalUserIds } from "./members.js";

// =====================================================================
// Wire shapes
// =====================================================================

export interface WireFriendTag {
  id: string;
  gameId: string;
  junjoUserId: string;
  name: string;
  color: string | null;
  createdAt: string;
}

export interface WireFriendTagList {
  items: WireFriendTag[];
}

export interface WireFriendTagAssignment {
  friendJunjoUserId: string;
  tagIds: string[];
}

function toWire(row: FriendTag, externalUserId: string): WireFriendTag {
  return {
    id: row.id,
    gameId: row.gameId,
    junjoUserId: externalUserId,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
  };
}

// =====================================================================
// Handlers
// =====================================================================

async function findOwnerFriendship(
  prisma: PrismaClient,
  gameId: string,
  ownerJunjoUserId: string,
  otherJunjoUserId: string,
): Promise<UserRelationship | null> {
  return prisma.userRelationship.findUnique({
    where: {
      gameId_actorJunjoUserId_targetJunjoUserId_type: {
        gameId,
        actorJunjoUserId: ownerJunjoUserId,
        targetJunjoUserId: otherJunjoUserId,
        type: "friend",
      },
    },
  });
}

export function listFriendTagsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled || !config.friends.tags.enabled) {
      throw Errors.notFound("resource");
    }

    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    if (!actorJid) {
      return c.json<WireFriendTagList>({ items: [] });
    }

    const tags = await prisma.friendTag.findMany({
      where: { gameId, junjoUserId: actorJid },
      orderBy: [{ name: "asc" }],
    });
    return c.json<WireFriendTagList>({ items: tags.map((t) => toWire(t, userId)) });
  };
}

export function createFriendTagHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = createFriendTagBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled || !config.friends.tags.enabled) {
      throw Errors.notFound("resource");
    }

    const actorJid = await findOrCreateJunjoUser(prisma, gameId, userId);

    // Cap check: how many tags does this user already have in this game?
    const existing = await prisma.friendTag.count({
      where: { gameId, junjoUserId: actorJid },
    });
    if (existing >= config.friends.tags.maxPerUser) {
      throw Errors.badRequest(`tag cap reached (${config.friends.tags.maxPerUser})`);
    }

    // The unique constraint catches duplicate names; surface as 400 so
    // the dashboard can show "you already have a tag named X".
    try {
      const tag = await prisma.friendTag.create({
        data: {
          gameId,
          junjoUserId: actorJid,
          name: parsed.data.name,
          color: parsed.data.color ?? null,
        },
      });
      return c.json<WireFriendTag>(toWire(tag, userId), 201);
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        throw Errors.badRequest("a tag with that name already exists");
      }
      throw err;
    }
  };
}

export function updateFriendTagHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = updateFriendTagBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled || !config.friends.tags.enabled) {
      throw Errors.notFound("resource");
    }

    const tag = await prisma.friendTag.findUnique({ where: { id } });
    if (!tag || tag.gameId !== gameId) throw Errors.notFound("tag");

    const data: { name?: string; color?: string | null } = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.color !== undefined) data.color = parsed.data.color;

    try {
      const updated = await prisma.friendTag.update({ where: { id }, data });
      // Translate the owner's internal id back to the external form so
      // the response matches what the caller would have sent to create
      // / list this tag.
      const externals = await batchLoadExternalUserIds(prisma, gameId, [updated.junjoUserId]);
      const ownerExternalId = externals.get(updated.junjoUserId) ?? updated.junjoUserId;
      return c.json<WireFriendTag>(toWire(updated, ownerExternalId));
    } catch (err) {
      if (
        err &&
        typeof err === "object" &&
        "code" in err &&
        (err as { code: string }).code === "P2002"
      ) {
        throw Errors.badRequest("a tag with that name already exists");
      }
      throw err;
    }
  };
}

export function deleteFriendTagHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.badRequest("id is required");

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled || !config.friends.tags.enabled) {
      throw Errors.notFound("resource");
    }

    const tag = await prisma.friendTag.findUnique({ where: { id } });
    if (!tag || tag.gameId !== gameId) throw Errors.notFound("tag");

    // The cascade on UserRelationshipTag clears the joins automatically.
    await prisma.friendTag.delete({ where: { id } });
    return c.body(null, 204);
  };
}

export function setFriendTagsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    const otherUserId = c.req.param("otherUserId");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!otherUserId) throw Errors.badRequest("otherUserId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = setFriendTagsBody.safeParse(json);
    if (!parsed.success) throw Errors.badRequest("invalid body");
    const requestedTagIds = Array.from(new Set(parsed.data.tagIds));

    const gameId = c.var.gameId;
    const { config } = await loadGameConfig(prisma, gameId);
    if (!config.friends.enabled || !config.friends.tags.enabled) {
      throw Errors.notFound("resource");
    }

    const actorJid = await findJunjoUserId(prisma, gameId, userId);
    const otherJid = await findJunjoUserId(prisma, gameId, otherUserId);
    if (!actorJid || !otherJid) throw Errors.notFound("friendship");

    const friendship = await findOwnerFriendship(prisma, gameId, actorJid, otherJid);
    if (!friendship) throw Errors.notFound("friendship");

    // Validate every requested tag exists and belongs to this user in
    // this game. Tags from a different game (even via networkId) are
    // not allowed; cross-network tagging is a v2+ feature.
    if (requestedTagIds.length > 0) {
      const owned = await prisma.friendTag.findMany({
        where: { id: { in: requestedTagIds }, gameId, junjoUserId: actorJid },
        select: { id: true },
      });
      if (owned.length !== requestedTagIds.length) {
        throw Errors.badRequest("one or more tags do not belong to this user in this game");
      }
    }

    // Replace the tag set in one transaction: delete all existing
    // joins for this friendship row, then create the new ones.
    // retryOnUniqueViolation: two concurrent set calls can interleave
    // so the loser's creates collide with the winner's committed rows
    // (P2002); the rerun deletes those and applies this call's set,
    // which is the last-writer-wins outcome a sequential second call
    // produces.
    await retryOnUniqueViolation(() =>
      prisma.$transaction([
        prisma.userRelationshipTag.deleteMany({
          where: { userRelationshipId: friendship.id },
        }),
        ...requestedTagIds.map((tagId) =>
          prisma.userRelationshipTag.create({
            data: { userRelationshipId: friendship.id, friendTagId: tagId },
          }),
        ),
      ]),
    );

    return c.json<WireFriendTagAssignment>({
      friendJunjoUserId: otherUserId,
      tagIds: requestedTagIds,
    });
  };
}
