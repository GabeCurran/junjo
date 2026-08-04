import type { GameConfig, PartialGameConfig } from "@junjo-io/shared";
import type { PrismaClient } from "@prisma/client";
import { Errors } from "../errors.js";
import { resolveGameConfig } from "./defaults.js";

export interface LoadedGameConfig {
  gameId: string;
  config: GameConfig;
  networkId: string | null;
}

// Loads a game's resolved config + networkId. 404 if the game does not
// exist. Used by every route that gates on `friends.enabled` or
// related toggles before doing any other work.
export async function loadGameConfig(
  prisma: PrismaClient,
  gameId: string,
): Promise<LoadedGameConfig> {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: { id: true, config: true, networkId: true },
  });
  if (!game) throw Errors.notFound("game");
  return {
    gameId: game.id,
    config: resolveGameConfig(game.config as PartialGameConfig | null),
    networkId: game.networkId,
  };
}

// 404 (not 403) when friends are disabled: feature absence is invisible
// to callers, mirroring the auth-token gate's intentional ambiguity.
export function assertFriendsEnabled(config: GameConfig): void {
  if (!config.friends.enabled) throw Errors.notFound("resource");
}

// Resolves the list of gameIds whose UserRelationship rows should be
// visible from `current.gameId`'s perspective.
//
// - When `current.config.friends.scope = "per-game"` (or `networkId` is
//   null), returns just the calling game's id.
// - When `current.config.friends.scope = "network"` AND `networkId` is
//   set, returns the calling game's id plus every sibling game that
//   ALSO has `scope = "network"` and shares the same `networkId`.
//   Both sides must opt in: a sibling game pinning `scope = "per-game"`
//   stays isolated even if its networkId matches.
//
// Reads (list friends, list blocks, suggestions, validation lookups)
// expand. Writes always pin to the originating gameId so flipping a
// game's scope back to per-game narrows visibility on read without
// dropping data.
export async function gameIdsInScope(
  prisma: PrismaClient,
  current: LoadedGameConfig,
): Promise<string[]> {
  if (current.config.friends.scope !== "network" || !current.networkId) {
    return [current.gameId];
  }

  const peers = await prisma.game.findMany({
    where: { networkId: current.networkId },
    select: { id: true, config: true },
  });

  const ids: string[] = [];
  for (const peer of peers) {
    const peerConfig = resolveGameConfig(peer.config as PartialGameConfig | null);
    if (peerConfig.friends.scope === "network") ids.push(peer.id);
  }
  // The current game might have its own scope=network but not be in the
  // returned set (defensive: an outside-the-network query should still
  // include the caller). Add it if absent.
  if (!ids.includes(current.gameId)) ids.push(current.gameId);
  return ids;
}
