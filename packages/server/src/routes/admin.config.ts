// @cloud-only
//
// PATCH / GET /v1/admin/games/:gameId/config. Backs the dashboard's
// per-game settings page. Authenticated by the cross-game admin token,
// not the per-game API key (mirrors the rest of `/v1/admin/*`).

import type { GameConfig, PartialGameConfig } from "@junjo.io/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { DEFAULT_GAME_CONFIG, mergeGameConfig, resolveGameConfig } from "../config/defaults.js";
import { adminUpdateGameConfigBody } from "../config/schema.js";
import { Errors } from "../errors.js";
import { permissionCache } from "../permissionCache.js";
import { applyPermissionModeSwitch } from "../permissionModeSwitch.js";

export interface WireAdminGameConfig {
  gameId: string;
  config: GameConfig;
  networkId: string | null;
}

function toWire(gameId: string, stored: unknown, networkId: string | null): WireAdminGameConfig {
  return {
    gameId,
    // The Prisma Json column is typed as `Prisma.JsonValue`; cast to the
    // partial shape the resolver expects. Storage path validates inputs
    // through Zod before write, so any drift is the operator's own
    // hand-edit and is treated as "ignore unrecognized branches".
    config: resolveGameConfig(stored as PartialGameConfig | null),
    networkId,
  };
}

export function getAdminGameConfigHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true, config: true, networkId: true },
    });
    if (!game) throw Errors.notFound("game");
    return c.json<WireAdminGameConfig>(toWire(game.id, game.config, game.networkId));
  };
}

export function updateAdminGameConfigHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = adminUpdateGameConfigBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }
    if (parsed.data.config === undefined && parsed.data.networkId === undefined) {
      throw Errors.badRequest("body must include `config` or `networkId`");
    }

    const body = parsed.data;
    // The Game row is locked FOR UPDATE so a permission mode switch
    // cannot interleave with key writes, which read the mode under a
    // share lock on the same row.
    const { updated, modeChanged } = await prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string; config: unknown; networkId: string | null }[]
        >(Prisma.sql`SELECT id, config, "networkId" FROM "Game" WHERE id = ${gameId} FOR UPDATE`);
        const existing = rows[0];
        if (!existing) throw Errors.notFound("game");

        const stored = existing.config as PartialGameConfig | null;
        const merged: PartialGameConfig =
          body.config !== undefined ? mergeGameConfig(stored, body.config) : (stored ?? {});
        const nextNetworkId = body.networkId === undefined ? existing.networkId : body.networkId;

        const before = resolveGameConfig(stored).permissions.mode;
        const after = resolveGameConfig(merged).permissions.mode;
        if (before !== after) {
          const rewrittenKeys = await applyPermissionModeSwitch(tx, gameId, before, after);
          await tx.auditEntry.create({
            data: {
              gameId,
              groupId: null,
              actorUserId: null,
              action: "game.permissions.mode.set",
              targetId: gameId,
              payload: { before, after, rewrittenKeys } as Prisma.InputJsonValue,
            },
          });
        }

        const row = await tx.game.update({
          where: { id: gameId },
          data: {
            // The Prisma JSON helper type accepts plain objects; the merge
            // helper preserves shape so this is a structural pass-through.
            config: merged as object,
            networkId: nextNetworkId,
          },
          select: { id: true, config: true, networkId: true },
        });
        return { updated: row, modeChanged: before !== after };
      },
      { timeout: 60_000 },
    );
    // Every cached answer for this game was computed under the old mode.
    if (modeChanged) permissionCache.clear();

    return c.json<WireAdminGameConfig>(toWire(updated.id, updated.config, updated.networkId));
  };
}

// Re-export the defaults so tests and the dashboard helper can share
// one source of truth without each importing the internal module path.
export { DEFAULT_GAME_CONFIG };
