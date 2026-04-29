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
  ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH,
  ADMIN_ROLE_COLOR_PATTERN,
  ADMIN_ROLE_NAME_MAX_LENGTH,
  AdminDisabledError,
  type AdminGroupMember,
  type AdminGroupRelationship,
  type AdminInvitation,
  type AdminMemberPermissionOverride,
  type AdminRole,
  clearAdminGroupRelationship,
  clearAdminMemberPermissionOverride,
  createAdminGroupInvitation,
  createAdminGroupRole,
  deleteAdminRole,
  grantAdminRolePermission,
  kickAdminGroupMember,
  listAdminMemberPermissionOverrides,
  revokeAdminRolePermission,
  setAdminGroupRelationship,
  setAdminMemberPermissionOverride,
  updateAdminGroupMember,
  updateAdminRole,
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

// Phase 11.6b Server Actions backing the Roles tab dialogs (Create / Edit
// / Delete). Wired to the iter-072 cross-game roles CRUD endpoints. The
// Permissions matrix tab in 11.6c will get its own actions; the role-
// permission grant / revoke endpoints are exposed via `lib/admin.ts`
// already so 11.6c can land additively without touching this file.

function readBoolField(formData: FormData, key: string): boolean | undefined {
  const raw = formData.get(key);
  if (raw === null) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function readPriorityField(formData: FormData): { value?: number; error?: string } {
  const raw = formData.get("priority");
  if (typeof raw !== "string" || raw.length === 0) {
    return { error: "priority is required" };
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return { error: "priority must be an integer" };
  }
  return { value: parsed };
}

function readNameField(formData: FormData): { value?: string; error?: string } {
  const raw = formData.get("name");
  if (typeof raw !== "string") return { error: "name is required" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: "name is required" };
  if (trimmed.length > ADMIN_ROLE_NAME_MAX_LENGTH) {
    return { error: `name must be at most ${ADMIN_ROLE_NAME_MAX_LENGTH} characters` };
  }
  return { value: trimmed };
}

// Color is delivered as a string from a `<input type="color">` (always
// `#rrggbb`) or as the literal "" when the operator chooses to clear it.
// The empty string maps to `null` (clear); a non-empty value must match
// the hex regex. Server enforces the same regex; reproducing it here lets
// a typo like "blue" return a clear error before the round trip.
function readColorField(formData: FormData): { value?: string | null; error?: string } {
  const raw = formData.get("color");
  if (raw === null) return { value: undefined };
  if (typeof raw !== "string") return { error: "color must be a string" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { value: null };
  if (!ADMIN_ROLE_COLOR_PATTERN.test(trimmed)) {
    return { error: "color must be a 7-character hex value like #ff5050" };
  }
  return { value: trimmed };
}

export interface CreateRoleResult {
  ok: boolean;
  error?: string;
  role?: AdminRole;
}

export async function createRoleAction(
  _prev: CreateRoleResult,
  formData: FormData,
): Promise<CreateRoleResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };

  const name = readNameField(formData);
  if (name.error || name.value === undefined) return { ok: false, error: name.error };

  const priority = readPriorityField(formData);
  if (priority.error || priority.value === undefined) return { ok: false, error: priority.error };

  const color = readColorField(formData);
  if (color.error) return { ok: false, error: color.error };
  // On create, `null` (operator left the color picker empty) is
  // semantically equivalent to "no color"; we omit the field so the
  // server's default `color: null` applies. Sending `null` would also
  // work but the schema is `optional` (not `nullable`) on create.
  const colorForCreate = typeof color.value === "string" ? color.value : undefined;

  const isDefault = readBoolField(formData, "isDefault") ?? false;

  try {
    const role = await createAdminGroupRole(gameId, groupId, {
      name: name.value,
      priority: priority.value,
      color: colorForCreate,
      isDefault,
    });
    refreshGroup(gameId, groupId);
    return { ok: true, role };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface UpdateRoleResult {
  ok: boolean;
  error?: string;
  role?: AdminRole;
}

export async function updateRoleAction(
  _prev: UpdateRoleResult,
  formData: FormData,
): Promise<UpdateRoleResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  const roleId = readStringField(formData, "roleId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!roleId) return { ok: false, error: "missing roleId" };

  // Update is partial: every field is optional and only supplied fields
  // hit the wire. Validate each field as it appears; any validation error
  // short-circuits before the network call.
  const name = readNameField(formData);
  if (name.error) return { ok: false, error: name.error };

  const priority = readPriorityField(formData);
  if (priority.error || priority.value === undefined) return { ok: false, error: priority.error };

  const color = readColorField(formData);
  if (color.error) return { ok: false, error: color.error };

  const isDefault = readBoolField(formData, "isDefault") ?? false;

  try {
    // Always send all four fields; the server compares against the stored
    // row and writes audit entries only for changed fields. Sending fields
    // that match the stored value is a no-op there. Simpler than
    // computing the diff client-side and matches the per-game route's
    // documented behavior.
    const role = await updateAdminRole(gameId, roleId, {
      name: name.value,
      priority: priority.value,
      // `color` round-trips `null` verbatim to clear; `undefined` would
      // also leave alone but on this Save flow we always have either a
      // string or `null` from the form.
      color: color.value ?? null,
      isDefault,
    });
    refreshGroup(gameId, groupId);
    return { ok: true, role };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface DeleteRoleResult {
  ok: boolean;
  error?: string;
  // The deleted role's id, echoed so the dialog knows which row to remove
  // from the table without waiting for `revalidatePath` to flush.
  roleId?: string;
}

export async function deleteRoleAction(
  _prev: DeleteRoleResult,
  formData: FormData,
): Promise<DeleteRoleResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  const roleId = readStringField(formData, "roleId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!roleId) return { ok: false, error: "missing roleId" };

  try {
    await deleteAdminRole(gameId, roleId);
    refreshGroup(gameId, groupId);
    return { ok: true, roleId };
  } catch (err) {
    // The server returns 409 `role_has_members` when the role has
    // `MemberRole` rows. The error message is preserved in
    // `describeError`, so the dialog can surface it inline ("This role
    // is assigned to N members. Reassign first.").
    return { ok: false, error: describeError(err) };
  }
}

// Phase 11.6c Server Actions backing the Permissions matrix tab. Plain
// async functions (not `useFormState`-shaped) because the matrix calls
// them imperatively from per-cell `onClick` handlers and tracks per-cell
// pending state in React, mirroring `clearMemberPermissionOverrideAction`
// and `listMemberPermissionOverridesAction`. Both return the post-state
// `AdminRole` so the matrix can sync its optimistic state to authoritative
// server state without waiting for `revalidatePath` to propagate.

export interface ToggleRolePermissionResult {
  ok: boolean;
  error?: string;
  role?: AdminRole;
}

function validateRolePermissionArgs(
  gameId: string,
  groupId: string,
  roleId: string,
  permission: string,
): { ok: true; permission: string } | { ok: false; error: string } {
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!roleId) return { ok: false, error: "missing roleId" };
  const trimmed = permission.trim();
  if (trimmed.length === 0) return { ok: false, error: "permission is required" };
  if (trimmed.length > ADMIN_PERMISSION_KEY_MAX_LENGTH) {
    return {
      ok: false,
      error: `permission must be at most ${ADMIN_PERMISSION_KEY_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, permission: trimmed };
}

export async function grantRolePermissionAction(
  gameId: string,
  groupId: string,
  roleId: string,
  permission: string,
): Promise<ToggleRolePermissionResult> {
  const v = validateRolePermissionArgs(gameId, groupId, roleId, permission);
  if (!v.ok) return v;
  try {
    const role = await grantAdminRolePermission(gameId, roleId, v.permission);
    refreshGroup(gameId, groupId);
    return { ok: true, role };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export async function revokeRolePermissionAction(
  gameId: string,
  groupId: string,
  roleId: string,
  permission: string,
): Promise<ToggleRolePermissionResult> {
  const v = validateRolePermissionArgs(gameId, groupId, roleId, permission);
  if (!v.ok) return v;
  try {
    const role = await revokeAdminRolePermission(gameId, roleId, v.permission);
    refreshGroup(gameId, groupId);
    return { ok: true, role };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

// Phase 11.7b-ii Server Actions backing the Relationships tab. Wired to
// the iter-078 cross-game admin relationship endpoints. The set action
// covers both create-new and edit-type-of-existing because the underlying
// PUT is upsert-shaped (idempotent on type-equal, bumps `since` on type
// change). The clear action takes a `mutual` flag matching the wire
// query so a single call can remove both directions when the operator
// chooses.

export interface SetRelationshipResult {
  ok: boolean;
  error?: string;
  relationship?: AdminGroupRelationship;
}

// `useFormState`-shaped because the dialog wires `<form action={...}>`.
// Validates the type cap client-side so a typo returns a clear error
// without bouncing off the server. The other-group-id is delivered as
// `groupBId` (the dialog's input field) so the dialog form does not need
// to know which side is "this" group; the page passes it in via a hidden
// input.
export async function setRelationshipAction(
  _prev: SetRelationshipResult,
  formData: FormData,
): Promise<SetRelationshipResult> {
  const gameId = readStringField(formData, "gameId");
  const groupId = readStringField(formData, "groupId");
  const groupBId = readStringField(formData, "groupBId");
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (!groupBId) return { ok: false, error: "other group id is required" };
  if (groupBId === groupId) {
    return { ok: false, error: "a group cannot have a relationship with itself" };
  }

  const typeRaw = formData.get("type");
  const type = typeof typeRaw === "string" ? typeRaw.trim() : "";
  if (type.length === 0) return { ok: false, error: "relationship type is required" };
  if (type.length > ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH) {
    return {
      ok: false,
      error: `type must be at most ${ADMIN_RELATIONSHIP_TYPE_MAX_LENGTH} characters`,
    };
  }

  const mutual = readBoolField(formData, "mutual") ?? false;

  try {
    const relationship = await setAdminGroupRelationship(gameId, groupId, groupBId, {
      type,
      mutual,
    });
    refreshGroup(gameId, groupId);
    return { ok: true, relationship };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

export interface ClearRelationshipResult {
  ok: boolean;
  error?: string;
  // Echoed so the optimistic-removal logic in the dialog knows which
  // pair was cleared; the dialog removes the row from local state
  // before `revalidatePath` propagates.
  groupBId?: string;
  mutual?: boolean;
}

// Plain-call action invoked from the per-row "Clear" button. The
// Relationships table calls it imperatively from `onClick`, then on
// success removes the row optimistically before `revalidatePath`
// flushes. Mirrors the `clearMemberPermissionOverrideAction` shape from
// 11.5c-ii.
export async function clearRelationshipAction(
  gameId: string,
  groupId: string,
  groupBId: string,
  mutual: boolean,
): Promise<ClearRelationshipResult> {
  if (!gameId) return { ok: false, error: "missing gameId" };
  if (!groupId) return { ok: false, error: "missing groupId" };
  if (groupBId.length === 0) return { ok: false, error: "other group id is required" };
  if (groupBId === groupId) {
    return { ok: false, error: "a group cannot have a relationship with itself" };
  }
  try {
    await clearAdminGroupRelationship(gameId, groupId, groupBId, mutual);
    refreshGroup(gameId, groupId);
    return { ok: true, groupBId, mutual };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}
