// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import {
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  AdminDisabledError,
  type AdminPermissionCheckResult,
  type AdminPermissionContext,
  fetchAdminGroupRoles,
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
  | {
      ok: true;
      result: AdminPermissionCheckResult;
      inputs: CheckPermissionInputs;
      // The deciding role's name and color, when a role decided.
      role?: { name: string; color: string | null };
    };

export interface CheckPermissionInputs {
  userId: string;
  groupId: string;
  permission: string;
  // As typed: comma-separated key=value pairs.
  context: string;
}

const INPUT_MAX_LENGTH = 1024;

// "world=pvp, server=lobby" to a context; the server validates keys and
// values and its message is shown as is.
function parseContext(text: string): AdminPermissionContext | string {
  const context: AdminPermissionContext = {};
  for (const part of text.split(",")) {
    const pair = part.trim();
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0 || eq === pair.length - 1) {
      return `Write each context as key=value; "${pair}" is not.`;
    }
    const key = pair.slice(0, eq).trim();
    if (key in context) return `The context key "${key}" is given twice.`;
    context[key] = pair.slice(eq + 1).trim();
  }
  return context;
}

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
    context: readField(formData, "context"),
  };

  const validationError = validateInputs(inputs);
  if (validationError !== null) {
    return { ok: false, error: validationError, inputs };
  }

  const context = parseContext(inputs.context);
  if (typeof context === "string") {
    return { ok: false, error: context, inputs };
  }

  try {
    const result = await fetchAdminPermissionCheck(gameId, {
      userId: inputs.userId,
      groupId: inputs.groupId,
      permission: inputs.permission,
      context,
    });
    let role: { name: string; color: string | null } | undefined;
    if (result.viaRoleId) {
      const roles = await fetchAdminGroupRoles(gameId, inputs.groupId).catch(() => []);
      const found = roles.find((r) => r.id === result.viaRoleId);
      if (found) role = { name: found.name, color: found.color };
    }
    return { ok: true, result, inputs, role };
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
