// @cloud-only
//
// Runs a request authenticated by the admin token as if a per-game API
// key for the path's `:gameId` had authenticated it. Mount after
// `adminAuthMiddleware`. It sets what the per-game handlers read from a
// key request: `c.var.gameId`, and the game's declared id formats on the
// request context. The context keeps `apiKeyId` null and no preferred
// namespaces, so audit rows written through it carry no API key, the
// same attribution as every other admin-token write. `c.var.apiKeyPrefix`
// stays unset; routes that read it are not registered on this mount.

import type { PartialGameConfig } from "@junjo.io/shared";
import type { PrismaClient } from "@prisma/client";
import type { MiddlewareHandler } from "hono";
import { resolveGameConfig } from "../config/defaults.js";
import { Errors } from "../errors.js";
import { currentRequestContext } from "../requestContext.js";

export function adminAsGameMiddleware(prisma: PrismaClient): MiddlewareHandler {
  return async (c, next) => {
    const gameId = c.req.param("gameId");
    const game = gameId
      ? await prisma.game.findUnique({ where: { id: gameId }, select: { id: true, config: true } })
      : null;
    if (!game) throw Errors.notFound("game");

    c.set("gameId", game.id);
    const ctx = currentRequestContext();
    if (ctx) {
      ctx.apiKeyId = null;
      ctx.preferredNamespaces = [];
      ctx.idFormats.set(
        game.id,
        resolveGameConfig(game.config as PartialGameConfig | null).identity.formats,
      );
    }
    await next();
  };
}
