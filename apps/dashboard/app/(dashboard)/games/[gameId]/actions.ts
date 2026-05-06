// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { revalidatePath } from "next/cache";

import {
  type AdminApiKey,
  type AdminApiKeyCreated,
  AdminDisabledError,
  createAdminApiKey,
  revokeAdminApiKey,
} from "../../../../lib/admin";

export interface CreateApiKeyResult {
  ok: boolean;
  error?: string;
  // The full `prefix.secret` form is returned exactly once on success so the
  // dialog can display it for copy-to-clipboard before it disappears forever.
  // The server stores only a scrypt hash; this is the only place the secret
  // ever appears on the wire.
  apiKey?: AdminApiKeyCreated;
}

export interface RevokeApiKeyResult {
  ok: boolean;
  error?: string;
  apiKey?: AdminApiKey;
}

// `useActionState`-compatible Server Action for issuing a new API key. The
// dialog client component reads the result, displays the secret on success,
// and surfaces errors inline on failure. The action also calls
// `revalidatePath` so the API keys table re-fetches and shows the new key
// (the dialog stays open until the operator closes it; closing triggers
// a `router.refresh()` belt-and-suspenders).
export async function createApiKeyAction(
  _prevState: CreateApiKeyResult,
  formData: FormData,
): Promise<CreateApiKeyResult> {
  const gameId = formData.get("gameId");
  if (typeof gameId !== "string" || gameId.length === 0) {
    return { ok: false, error: "missing gameId" };
  }
  try {
    const apiKey = await createAdminApiKey(gameId);
    revalidatePath(`/games/${gameId}`);
    return { ok: true, apiKey };
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

// `useActionState`-compatible Server Action for revoking a key. Idempotent on
// already-revoked (the server returns the unchanged row); the dialog UX
// frames revoke as terminal so an accidental double-click does no harm.
export async function revokeApiKeyAction(
  _prevState: RevokeApiKeyResult,
  formData: FormData,
): Promise<RevokeApiKeyResult> {
  const gameId = formData.get("gameId");
  const keyId = formData.get("keyId");
  if (typeof gameId !== "string" || gameId.length === 0) {
    return { ok: false, error: "missing gameId" };
  }
  if (typeof keyId !== "string" || keyId.length === 0) {
    return { ok: false, error: "missing keyId" };
  }
  try {
    const apiKey = await revokeAdminApiKey(gameId, keyId);
    revalidatePath(`/games/${gameId}`);
    return { ok: true, apiKey };
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
