// @cloud-only
//
// PATCH / GET /v1/admin/games/:gameId/config. Backs the dashboard's
// per-game settings page. Authenticated by the cross-game admin token,
// not the per-game API key (mirrors the rest of `/v1/admin/*`).

import type { GameConfig, PartialGameConfig } from "@junjo.io/shared";
import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { DEFAULT_GAME_CONFIG, mergeGameConfig, resolveGameConfig } from "../config/defaults.js";
import { adminUpdateGameConfigBody } from "../config/schema.js";
import { Errors } from "../errors.js";

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

    const existing = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true, config: true, networkId: true },
    });
    if (!existing) throw Errors.notFound("game");

    const merged: PartialGameConfig =
      parsed.data.config !== undefined
        ? mergeGameConfig(existing.config as PartialGameConfig | null, parsed.data.config)
        : ((existing.config as PartialGameConfig | null) ?? {});

    const nextNetworkId =
      parsed.data.networkId === undefined ? existing.networkId : parsed.data.networkId;

    const updated = await prisma.game.update({
      where: { id: gameId },
      data: {
        // The Prisma JSON helper type accepts plain objects; the merge
        // helper preserves shape so this is a structural pass-through.
        config: merged as object,
        networkId: nextNetworkId,
      },
      select: { id: true, config: true, networkId: true },
    });

    return c.json<WireAdminGameConfig>(toWire(updated.id, updated.config, updated.networkId));
  };
}

// Re-export the defaults so tests and the dashboard helper can share
// one source of truth without each importing the internal module path.
export { DEFAULT_GAME_CONFIG };
