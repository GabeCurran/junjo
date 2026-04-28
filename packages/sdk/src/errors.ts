// Thrown to the caller for any non-2xx response. Mirrors the server's
// canonical envelope ({ code, status, message }) so callers can branch
// on `error.code` rather than parsing strings.

export class JunjoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JunjoError";
  }
}
