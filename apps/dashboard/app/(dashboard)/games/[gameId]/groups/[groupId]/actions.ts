// @license All Rights Reserved (see apps/dashboard/LICENSE)
"use server";

import { revalidatePath } from "next/cache";

import {
  ADMIN_INVITATION_EXPIRES_IN_PATTERN,
  ADMIN_INVITATION_ROLE_ID_MAX_LENGTH,
  ADMIN_INVITATION_USER_ID_MAX_LENGTH,
  ADMIN_MEMBER_KICK_REASON_MAX_LENGTH,
  ADMIN_MEMBER_NOTES_MAX_LENGTH,
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  AdminDisabledError,
  type AdminGroupMember,
  type AdminInvitation,
  type AdminMemberPermissionOverride,
  clearAdminMemberPermissionOverride,
  createAdminGroupInvitation,
  kickAdminGroupMember,
  listAdminMemberPermissionOverrides,
  setAdminMemberPermissionOverride,
  updateAdminGroupMember,
} from "../../../../../../lib/admin";
import { getInviteBaseUrl } from "../../../../../../lib/junjo";

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

// Phase 11.5d-ii invite-member action backing the three-tab dialog
// (by-userId / by-code / by-link). The form's hidden `mode` field selects
// the variant; the same Server Action handles all three because the
// underlying server endpoint takes the same body shape regardless. The
// only mode-specific behavior is whether `targetUserId` is required (mode
// = "userId") and whether the result includes a constructed
// `inviteUrl` (mode = "link").
export const INVITE_MODES = ["userId", "code", "link"] as const;
export type InviteMode = (typeof INVITE_MODES)[number];

export interface InviteMemberResult {
  ok: boolean;
  error?: string;
  // The created invitation. Always set on success regardless of mode; the
  // dialog reads `code` from here for the by-code result panel.
  invitation?: AdminInvitation;
  // The constructed invite URL. Only set when mode === "link".
  inviteUrl?: string;
  // Echoed so the dialog knows which result panel to render after success
  // (the by-userId tab closes immediately; the others show a copy-able
  // result).
  mode?: InviteMode;
}

export async function inviteMemberAction(
  _prev: InviteMemberResult,
  formData: FormData,
): Promise<InviteMemberResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };

  const modeRaw = formData.get("mode");
  if (typeof modeRaw !== "string" || !(INVITE_MODES as readonly string[]).includes(modeRaw)) {
    return { ok: false, error: "mode must be one of userId, code, link" };
  }
  const mode = modeRaw as InviteMode;

  const targetUserIdRaw = formData.get("targetUserId");
  const targetUserId = typeof targetUserIdRaw === "string" ? targetUserIdRaw.trim() : "";
  if (mode === "userId") {
    if (targetUserId.length === 0) {
      return { ok: false, error: "user id is required for direct invitations", mode };
    }
    if (targetUserId.length > ADMIN_INVITATION_USER_ID_MAX_LENGTH) {
      return {
        ok: false,
        error: `user id must be at most ${ADMIN_INVITATION_USER_ID_MAX_LENGTH} characters`,
        mode,
      };
    }
  }

  const roleIdRaw = formData.get("roleId");
  const roleId = typeof roleIdRaw === "string" ? roleIdRaw.trim() : "";
  if (roleId.length > ADMIN_INVITATION_ROLE_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `role id must be at most ${ADMIN_INVITATION_ROLE_ID_MAX_LENGTH} characters`,
      mode,
    };
  }

  const expiresInRaw = formData.get("expiresIn");
  const expiresIn = typeof expiresInRaw === "string" ? expiresInRaw.trim() : "";
  if (expiresIn.length > 0 && !ADMIN_INVITATION_EXPIRES_IN_PATTERN.test(expiresIn)) {
    return {
      ok: false,
      error: "expires-in must look like 7d, 24h, 30m, or 60s",
      mode,
    };
  }

  try {
    const invitation = await createAdminGroupInvitation(gameId, groupId, {
      targetUserId: mode === "userId" ? targetUserId : undefined,
      roleId: roleId.length > 0 ? roleId : undefined,
      expiresIn: expiresIn.length > 0 ? expiresIn : undefined,
    });
    refreshGroup(gameId, groupId);
    if (mode === "link") {
      const inviteUrl = `${getInviteBaseUrl()}/invite/${encodeURIComponent(invitation.code)}`;
      return { ok: true, invitation, inviteUrl, mode };
    }
    return { ok: true, invitation, mode };
  } catch (err) {
    return { ok: false, error: describeError(err), mode };
  }
}
