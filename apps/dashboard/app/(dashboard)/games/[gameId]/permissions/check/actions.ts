// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import {
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  AdminDisabledError,
  type AdminPermissionCheckResult,
  fetchAdminPermissionCheck,
} from "../../../../../../lib/admin";

// Result type matches the `useActionState` shape used by every other
// Server Action in the dashboard (`{ ok: false }` initial state, then
// `{ ok: true, result }` on success or `{ ok: false, error }` on
// failure). `inputs` echo back whatever the operator submitted so the
// tester form can re-render with the values that produced this result;
// without the echo a successful Run would redirect the form to its
// initial empty state and lose context for re-testing.
export type CheckPermissionResult =
  | { ok: false; error?: string; inputs?: CheckPermissionInputs }
  | { ok: true; result: AdminPermissionCheckResult; inputs: CheckPermissionInputs };

export interface CheckPermissionInputs {
  userId: string;
  groupId: string;
  permission: string;
}

const INPUT_MAX_LENGTH = 1024;

function readField(formData: FormData, key: string): string {
  const raw = formData.get(key);
  if (typeof raw !== "string") return "";
  return raw.trim();
}

function validateInputs(inputs: CheckPermissionInputs): string | null {
  if (inputs.userId.length === 0) return "User id is required.";
  if (inputs.userId.length > INPUT_MAX_LENGTH) return "User id is too long.";
  if (inputs.groupId.length === 0) return "Group id is required.";
  if (inputs.groupId.length > INPUT_MAX_LENGTH) return "Group id is too long.";
  if (inputs.permission.length === 0) return "Permission key is required.";
  if (inputs.permission.length > ADMIN_PERMISSION_KEY_MAX_LENGTH) {
    return `Permission key must be ${ADMIN_PERMISSION_KEY_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

export async function checkPermissionAction(
  _prevState: CheckPermissionResult,
  formData: FormData,
): Promise<CheckPermissionResult> {
  const gameId = readField(formData, "gameId");
  if (gameId.length === 0) {
    return { ok: false, error: "Game id is missing from the form." };
  }

  const inputs: CheckPermissionInputs = {
    userId: readField(formData, "userId"),
    groupId: readField(formData, "groupId"),
    permission: readField(formData, "permission"),
  };

  const validationError = validateInputs(inputs);
  if (validationError !== null) {
    return { ok: false, error: validationError, inputs };
  }

  try {
    const result = await fetchAdminPermissionCheck(gameId, inputs);
    return { ok: true, result, inputs };
  } catch (err) {
    if (err instanceof AdminDisabledError) {
      return {
        ok: false,
        error: "JUNJO_ADMIN_TOKEN is not configured on this dashboard.",
        inputs,
      };
    }
    const message = err instanceof Error ? err.message : "unknown error";
    return { ok: false, error: message, inputs };
  }
}
