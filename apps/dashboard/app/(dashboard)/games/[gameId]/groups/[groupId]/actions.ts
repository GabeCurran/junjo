// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { revalidatePath } from "next/cache";

import {
  ADMIN_MEMBER_KICK_REASON_MAX_LENGTH,
  ADMIN_MEMBER_NOTES_MAX_LENGTH,
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  AdminDisabledError,
  type AdminGroupMember,
  type AdminMemberPermissionOverride,
  clearAdminMemberPermissionOverride,
  kickAdminGroupMember,
  listAdminMemberPermissionOverrides,
  setAdminMemberPermissionOverride,
  updateAdminGroupMember,
} from "../../../../../../lib/admin";

// Phase 11.5c-ii Server Actions wired to the iter-068 cross-game admin
// row-action endpoints. The four `useFormState`-shaped actions back the
// dialogs (kick, edit notes, set override). The two plain-function
// actions (`listMemberPermissionOverridesAction`,
// `clearMemberPermissionOverrideAction`) are called from inside the
// view-overrides dialog where the data flows through React state, not a
// form submission.

function refreshGroup(gameId: string, groupId: string) {
  // Targeted revalidation. The MembersTable is rendered inside this route's
  // Suspense boundary, so refreshing this path expires the 60s cache that
  // `fetchAdminGroupMembers` uses on the server.
  revalidatePath(`/games/${gameId}/groups/${groupId}`);
}

function describeError(err: unknown): string {
  if (err instanceof AdminDisabledError) {
    return "JUNJO_ADMIN_TOKEN is not configured on this dashboard.";
  }
  return err instanceof Error ? err.message : "unknown error";
}

function readStringField(formData: FormData, key: string): string | null {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw.length === 0) return null;
  return raw;
}

export interface KickMemberResult {
  ok: boolean;
  error?: string;
  member?: AdminGroupMember;
}

export async function kickMemberAction(
  _prev: KickMemberResult,
  formData: FormData,
): Promise<KickMemberResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  const userId = readStringField(formData, "userId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!userId) return { ok: false, error: "missing userId" };

  const reasonRaw = formData.get("reason");
  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length > ADMIN_MEMBER_KICK_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `reason must be at most ${ADMIN_MEMBER_KICK_REASON_MAX_LENGTH} characters`,
    };
  }

  try {
    const member = await kickAdminGroupMember(
      gameId,
      groupId,
      userId,
      reason.length > 0 ? { reason } : {},
    );
    refreshGroup(gameId, groupId);
    return { ok: true, member };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface UpdateMemberNotesResult {
  ok: boolean;
  error?: string;
  member?: AdminGroupMember;
}

// Whitespace-only / empty textarea content is normalized to `null` so the
// stored value is "no note" rather than an empty string. The server
// distinguishes the two on the wire (null clears, "" stores empty), and
// operators almost always mean "clear" when they wipe a textarea.
function normalizeNotesField(formData: FormData, key: string): string | null | undefined {
  const raw = formData.get(key);
  if (raw === null) return undefined;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : raw;
}

export async function updateMemberNotesAction(
  _prev: UpdateMemberNotesResult,
  formData: FormData,
): Promise<UpdateMemberNotesResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  const userId = readStringField(formData, "userId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!userId) return { ok: false, error: "missing userId" };

  const notesPublic = normalizeNotesField(formData, "notesPublic");
  const notesPrivate = normalizeNotesField(formData, "notesPrivate");
  if (typeof notesPublic === "string" && notesPublic.length > ADMIN_MEMBER_NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: `notesPublic must be at most ${ADMIN_MEMBER_NOTES_MAX_LENGTH} characters`,
    };
  }
  if (typeof notesPrivate === "string" && notesPrivate.length > ADMIN_MEMBER_NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: `notesPrivate must be at most ${ADMIN_MEMBER_NOTES_MAX_LENGTH} characters`,
    };
  }

  if (notesPublic === undefined && notesPrivate === undefined) {
    return { ok: false, error: "at least one notes field is required" };
  }

  try {
    const member = await updateAdminGroupMember(gameId, groupId, userId, {
      notesPublic,
      notesPrivate,
    });
    refreshGroup(gameId, groupId);
    return { ok: true, member };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface SetPermissionOverrideResult {
  ok: boolean;
  error?: string;
  override?: AdminMemberPermissionOverride;
}

export async function setPermissionOverrideAction(
  _prev: SetPermissionOverrideResult,
  formData: FormData,
): Promise<SetPermissionOverrideResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  const userId = readStringField(formData, "userId");
  const permissionRaw = readStringField(formData, "permission");
  const grantRaw = formData.get("grant");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!userId) return { ok: false, error: "missing userId" };
  if (!permissionRaw) return { ok: false, error: "permission is required" };

  const permission = permissionRaw.trim();
  if (permission.length === 0) {
    return { ok: false, error: "permission must not be empty" };
  }
  if (permission.length > ADMIN_PERMISSION_KEY_MAX_LENGTH) {
    return {
      ok: false,
      error: `permission must be at most ${ADMIN_PERMISSION_KEY_MAX_LENGTH} characters`,
    };
  }

  // Grant is delivered as a radio with values "true" / "false"; reject
  // anything else so a stale form posting an empty string can't silently
  // become a "revoke".
  if (grantRaw !== "true" && grantRaw !== "false") {
    return { ok: false, error: "grant must be true or false" };
  }
  const grant = grantRaw === "true";

  try {
    const override = await setAdminMemberPermissionOverride(gameId, groupId, userId, permission, {
      grant,
    });
    refreshGroup(gameId, groupId);
    return { ok: true, override };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface ListPermissionOverridesResult {
  ok: boolean;
  error?: string;
  overrides?: AdminMemberPermissionOverride[];
}

// Plain-call action (not `useFormState`-shaped). Invoked from a `useEffect`
// inside the view-overrides dialog when it opens; the dialog manages the
// fetched list in local React state.
export async function listMemberPermissionOverridesAction(
  gameId: string,
  groupId: string,
  userId: string,
): Promise<ListPermissionOverridesResult> {
  try {
    const overrides = await listAdminMemberPermissionOverrides(gameId, groupId, userId);
    return { ok: true, overrides };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface ClearPermissionOverrideResult {
  ok: boolean;
  error?: string;
}

// Plain-call action used from the per-row clear button inside the
// view-overrides dialog. The dialog re-fetches the list after a successful
// clear, so we don't return the post-state here.
export async function clearMemberPermissionOverrideAction(
  gameId: string,
  groupId: string,
  userId: string,
  permission: string,
): Promise<ClearPermissionOverrideResult> {
  if (permission.length === 0) return { ok: false, error: "permission must not be empty" };
  try {
    await clearAdminMemberPermissionOverride(gameId, groupId, userId, permission);
    refreshGroup(gameId, groupId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
