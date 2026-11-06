// @license All Rights Reserved (see apps/dashboard/LICENSE)
import "server-only";

import { revalidateTag } from "next/cache";

import { ADMIN_GAMES_TAG, adminGameTag } from "./admin";

// Drops the cached admin reads a write to `gameId` can change: the games
// list, whose rows carry each game's name and counts, and the game's own
// cached reads. Every other admin read is uncached and needs nothing.
export function revalidateGameData(gameId: string): void {
  revalidateTag(ADMIN_GAMES_TAG);
  revalidateTag(adminGameTag(gameId));
}
