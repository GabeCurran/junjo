// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { revalidatePath } from "next/cache";

import {
  type AdminApiKey,
  type AdminApiKeyCreated,
  type AdminApiKeyInput,
  AdminDisabledError,
  createAdminApiKey,
  revokeAdminApiKey,
  updateAdminApiKey,
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

export interface UpdateApiKeyResult {
  ok: boolean;
  error?: string;
  apiKey?: AdminApiKey;
}

// The form sends namespaces as one free-text field; commas and
// whitespace both separate entries. Validation (pattern, count, repeats)
// is left to the server so the two cannot drift.
function readKeyInput(formData: FormData): AdminApiKeyInput {
  const rawName = formData.get("name");
  const rawNamespaces = formData.get("preferredNamespaces");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  const preferredNamespaces =
    typeof rawNamespaces === "string"
      ? rawNamespaces.split(/[\s,]+/).filter((ns) => ns.length > 0)
      : [];
  return { name: name.length > 0 ? name : null, preferredNamespaces };
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
    const { name, preferredNamespaces } = readKeyInput(formData);
    const apiKey = await createAdminApiKey(gameId, {
      ...(name !== null ? { name } : {}),
      ...(preferredNamespaces && preferredNamespaces.length > 0 ? { preferredNamespaces } : {}),
    });
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

// `useActionState`-compatible Server Action for renaming a key or changing
// its namespace preference. The secret is untouched, so clients holding
// the key keep working.
export async function updateApiKeyAction(
  _prevState: UpdateApiKeyResult,
  formData: FormData,
): Promise<UpdateApiKeyResult> {
  const gameId = formData.get("gameId");
  const keyId = formData.get("keyId");
  if (typeof gameId !== "string" || gameId.length === 0) {
    return { ok: false, error: "missing gameId" };
  }
  if (typeof keyId !== "string" || keyId.length === 0) {
    return { ok: false, error: "missing keyId" };
  }
  try {
    const apiKey = await updateAdminApiKey(gameId, keyId, readKeyInput(formData));
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
