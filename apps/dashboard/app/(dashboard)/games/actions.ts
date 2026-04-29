// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { AdminDisabledError, createAdminGame } from "../../../lib/admin";

// Mirrors `createGameBody` in `packages/server/src/routes/admin.schema.ts`
// (1-200 chars). Validating client-side avoids an unnecessary network round
// trip; the server validates again for defense in depth.
const createGameSchema = z.object({
  name: z.string().trim().min(1, "name is required").max(200, "name is too long (200 char max)"),
});

export interface CreateGameResult {
  ok: boolean;
  error?: string;
  gameId?: string;
}

// `useActionState`-compatible Server Action: takes `(prevState, formData)` and
// returns `CreateGameResult`. The dialog client component uses the result to
// close on success and surface validation errors inline on failure.
export async function createGameAction(
  _prevState: CreateGameResult,
  formData: FormData,
): Promise<CreateGameResult> {
  const parsed = createGameSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "invalid name" };
  }
  try {
    const game = await createAdminGame(parsed.data.name);
    revalidatePath("/games");
    return { ok: true, gameId: game.id };
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return {
        ok: false,
        error: "JUNJO_ADMIN_TOKEN is not configured on this dashboard.",
      };
    }
    return { ok: false, error: err instanceof Error ? err.message : "unknown error" };
  }
}
