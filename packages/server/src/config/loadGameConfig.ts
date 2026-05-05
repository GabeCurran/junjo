import type { GameConfig, PartialGameConfig } from "@junjo/shared";
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
