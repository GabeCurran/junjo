import type { JunjoErrorCode } from "@junjo.io/shared";

export class JunjoError extends Error {
  constructor(
    readonly code: JunjoErrorCode,
    readonly status: number,
    message: string,
    // Serialized as the envelope's `details` field. Absent from the
    // envelope when undefined, so errors without it keep their shape.
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JunjoError";
  }

  toJSON(): {
    code: JunjoErrorCode;
    status: number;
    message: string;
    details?: Record<string, unknown>;
  } {
    return {
      code: this.code,
      status: this.status,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const Errors = {
  notFound: (what = "resource") => new JunjoError("not_found", 404, `${what} not found`),
  // A lift found no active ban. Same code as any other 404 so existing
  // callers keep working; `details.reason` lets a replayed lift tell
  // "already lifted" apart from a wrong group or route.
  banNotActive: () => new JunjoError("not_found", 404, "ban not found", { reason: "not_active" }),
  // The sanction counterpart of `banNotActive`, with the same contract.
  sanctionNotActive: () =>
    new JunjoError("not_found", 404, "sanction not found", { reason: "not_active" }),
  groupFull: (msg = "this group has reached its member limit") =>
    new JunjoError("group_full", 409, msg),
  groupLimitReached: (
    msg = "user has reached the membership limit for this group kind",
    details?: Record<string, unknown>,
  ) => new JunjoError("group_limit_reached", 409, msg, details),
  invalidApiKey: (msg = "invalid API key") => new JunjoError("invalid_api_key", 401, msg),
  invalidAdminToken: (msg = "invalid admin token") =>
    new JunjoError("invalid_admin_token", 401, msg),
  badRequest: (msg = "bad request") => new JunjoError("bad_request", 400, msg),
  permissionDenied: (msg = "permission denied") => new JunjoError("permission_denied", 403, msg),
  restoreWindowExpired: (msg = "restore window expired") =>
    new JunjoError("restore_window_expired", 410, msg),
  invitationExpired: (msg = "invitation expired") => new JunjoError("invitation_expired", 410, msg),
  invitationUsed: (msg = "invitation already used") => new JunjoError("invitation_used", 410, msg),
  alreadyMember: (msg = "user is already a member of this group") =>
    new JunjoError("already_member", 409, msg),
  roleHasMembers: (msg = "role has members assigned; reassign them before deleting") =>
    new JunjoError("role_has_members", 409, msg),
  roleNameTaken: (msg = "another role in this group already has that name") =>
    new JunjoError("role_name_taken", 409, msg),
  roleGroupMismatch: (msg = "role does not belong to this group") =>
    new JunjoError("role_group_mismatch", 400, msg),
  parentCycle: (msg = "setting this parent would create a cycle") =>
    new JunjoError("parent_cycle", 400, msg),
  permissionModeConflict: (
    msg = "stored permission keys would change meaning under the new mode",
  ) => new JunjoError("permission_mode_conflict", 409, msg),
  invalidUserId: (msg = "user id does not match the format declared for its namespace") =>
    new JunjoError("invalid_user_id", 400, msg),
  identityFormatConflict: (msg = "stored user ids do not match the declared format") =>
    new JunjoError("identity_format_conflict", 409, msg),
  linkCodeInvalid: (msg = "link code is invalid, expired or already used") =>
    new JunjoError("link_code_invalid", 400, msg),
  linkRefused: (
    msg = "these ids cannot be linked automatically",
    details?: Record<string, unknown>,
  ) => new JunjoError("link_refused", 409, msg, details),
  rateLimitExceeded: (msg = "rate limit exceeded") =>
    new JunjoError("rate_limit_exceeded", 429, msg),
  tooManyStreams: (msg = "too many open event streams") =>
    new JunjoError("too_many_streams", 429, msg),
  streamPositionExpired: (msg = "stream position expired") =>
    new JunjoError("stream_position_expired", 410, msg),
  banned: (msg = "user is banned") => new JunjoError("banned", 403, msg),
  idempotencyKeyReused: (msg = "this Idempotency-Key was already used with a different request") =>
    new JunjoError("idempotency_key_reused", 422, msg),
  idempotencyKeyInProgress: (msg = "a request with this Idempotency-Key is still in progress") =>
    new JunjoError("idempotency_key_in_progress", 409, msg),
  preconditionFailed: (msg = "If-Match does not match the current version") =>
    new JunjoError("precondition_failed", 412, msg),
  passcodeRequired: (msg = "this group requires a passcode to join") =>
    new JunjoError("passcode_required", 403, msg),
  passcodeInvalid: (msg = "invalid passcode") => new JunjoError("passcode_invalid", 403, msg),
};
