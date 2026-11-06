// @cloud-only
//
// PATCH / GET /v1/admin/games/:gameId/config. Backs the dashboard's
// per-game settings page. Authenticated by the cross-game admin token,
// not the per-game API key (mirrors the rest of `/v1/admin/*`).

import type {
  GameConfig,
  GameId,
  PartialGameConfig,
  PermissionsConfigUpdatedEvent,
} from "@junjo.io/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { DEFAULT_GAME_CONFIG, mergeGameConfig, resolveGameConfig } from "../config/defaults.js";
import { adminUpdateGameConfigBody } from "../config/schema.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { publishStagedEvents, stageEvent } from "../events.js";
import { permissionCache } from "../permissionCache.js";
import { applyPermissionModeSwitch } from "../permissionModeSwitch.js";
import { type DeclaredFormats, findFormatConflicts } from "../userIdFormat.js";

// Key order is not significant in the stored JSON, so configs compare
// in a canonical form.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameFormats(a: DeclaredFormats, b: DeclaredFormats): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

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

// A change to the resolved permission mode or context inheritance stages
// `permissions.config.updated` on the write's transaction, so it commits
// with the config and takes the next game stream position.
export function updateAdminGameConfigHandler(prisma: PrismaClient, hub: EventHub): Handler {
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
    const { updated, cacheStale, event } = await prisma.$transaction(
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

        // Declaring or changing a namespace's format is refused while any
        // stored id in it would stop matching. The row lock above holds
        // off first-time identity creates, which share-lock this row.
        const formatsBefore = resolveGameConfig(stored).identity.formats;
        const formatsAfter = resolveGameConfig(merged).identity.formats;
        const conflicts = await findFormatConflicts(tx, gameId, formatsBefore, formatsAfter);
        if (conflicts.length > 0) {
          throw Errors.identityFormatConflict(
            `stored user ids do not match the declared format: ${conflicts.join(", ")}`,
          );
        }
        const formatsChanged = !sameFormats(formatsBefore, formatsAfter);

        const permissionsBefore = resolveGameConfig(stored).permissions;
        const permissionsAfter = resolveGameConfig(merged).permissions;
        const before = permissionsBefore.mode;
        const after = permissionsAfter.mode;
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

        // Context inheritance changes which entries apply to a check.
        const contextsChanged =
          canonicalJson(permissionsBefore.contexts) !== canonicalJson(permissionsAfter.contexts);

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
        const event =
          before !== after || contextsChanged
            ? await stageEvent<PermissionsConfigUpdatedEvent>(tx, {
                type: "permissions.config.updated",
                gameId: gameId as GameId,
                mode: permissionsAfter.mode,
                contexts: permissionsAfter.contexts,
              })
            : null;
        return {
          updated: row,
          cacheStale: before !== after || formatsChanged || contextsChanged,
          event,
        };
      },
      { timeout: 60_000 },
    );
    // Every cached answer for this game was computed under the old mode
    // or context inheritance, or for id spellings that a newly declared
    // format now rejects.
    if (cacheStale) permissionCache.clear();
    if (event) publishStagedEvents(hub, event);

    return c.json<WireAdminGameConfig>(toWire(updated.id, updated.config, updated.networkId));
  };
}

// Re-export the defaults so tests and the dashboard helper can share
// one source of truth without each importing the internal module path.
export { DEFAULT_GAME_CONFIG };
