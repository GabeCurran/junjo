// Server-side error type. Routes throw `JunjoError` and the error
// middleware turns it into a JSON response with the same shape the SDK
// expects: { code, status, message }.

export class JunjoError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "JunjoError";
  }

  toJSON(): { code: string; status: number; message: string } {
    return { code: this.code, status: this.status, message: this.message };
  }
}

export const Errors = {
  notFound: (what = "resource") => new JunjoError("not_found", 404, `${what} not found`),
  invalidApiKey: (msg = "invalid API key") => new JunjoError("invalid_api_key", 401, msg),
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
};
