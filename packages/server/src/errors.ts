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
};
