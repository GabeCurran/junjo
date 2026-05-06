// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { revalidatePath } from "next/cache";
import {
  type AdminGameConfigPatch,
  fetchAdminGameConfig,
  updateAdminGameConfig,
} from "../../../../../lib/admin";

export interface UpdateGameConfigResult {
  ok: boolean;
  error?: string;
}

export async function updateGameConfigAction(
  gameId: string,
  patch: AdminGameConfigPatch,
): Promise<UpdateGameConfigResult> {
  try {
    await updateAdminGameConfig(gameId, patch);
    revalidatePath(`/games/${gameId}/settings`);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

// Re-fetch helper exposed as a Server Action so the form can refresh
// after a successful PATCH without going through the full router cycle.
export async function reloadGameConfigAction(gameId: string) {
  return fetchAdminGameConfig(gameId, { revalidate: 0 });
}
