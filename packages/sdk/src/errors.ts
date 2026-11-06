import type { MemberImportRowError, JunjoErrorCode as ServerErrorCode } from "@junjo.io/shared";

/**
 * Codes the SDK itself can produce, on top of the server's canonical
 * envelope codes. Transport failures get their own codes so a caller
 * can tell "the request never reached the server" (network_error,
 * timeout, cancelled) apart from "the server rejected it" without
 * string-matching messages.
 */
export const JUNJO_SDK_ERROR_CODES = [
  // fetch itself rejected: DNS failure, connection refused, TLS error,
  // offline. The request may or may not have reached the server.
  "network_error",
  // The configured timeoutMs (or a per-request override) elapsed
  // before the response arrived.
  "timeout",
  // The caller's AbortSignal aborted the request.
  "cancelled",
  // Client construction or adapter options were invalid; no request
  // was made.
  "invalid_config",
  // A 2xx response carried a body the SDK could not parse or that
  // failed wire validation (malformed JSON, invalid timestamps,
  // missing SSE body).
  "invalid_wire_data",
  // An SSE frame exceeded the buffer cap; the stream is closed.
  "stream_overflow",
  // An event carried a type this SDK version does not know.
  "unknown_event_type",
  // Webhook verification failures, from most to least specific.
  "webhook_signature_missing",
  "webhook_timestamp_missing",
  "webhook_timestamp_invalid",
  "webhook_timestamp_out_of_tolerance",
  "webhook_invalid_signature",
  "webhook_invalid_body",
  "webhook_verification_failed",
  // A non-2xx response that did not carry the Junjo error envelope
  // (e.g. an HTML 502 from an intermediary proxy).
  "unknown",
] as const;

/** One of the SDK-side error codes in {@link JUNJO_SDK_ERROR_CODES}. */
export type JunjoSdkErrorCode = (typeof JUNJO_SDK_ERROR_CODES)[number];

/**
 * The known values of `JunjoError.code`: the server's canonical
 * envelope codes plus the SDK-side codes above. Typed as a union so a
 * typo'd comparison (`err.code === "not_foud"`) fails to compile.
 * Forward-compat caveat: a NEWER server may introduce codes this SDK
 * version does not know; they pass through at runtime, so an
 * exhaustive switch over `err.code` must keep a default branch.
 */
export type JunjoErrorCode = ServerErrorCode | JunjoSdkErrorCode;

/**
 * Thrown for any failed SDK operation: non-2xx responses (mirroring
 * the server's { code, status, message } envelope), transport
 * failures, and client-side verification failures. Branch on
 * `error.code` (keep a default branch: newer servers may send codes
 * this SDK version does not know). `status` is set only when an HTTP
 * response was actually received. `requestId` (when present) matches
 * the server's x-request-id and is worth quoting in bug reports.
 * `retryAfterSeconds` is set on rate-limited responses and on
 * `idempotency_key_in_progress`; the SDK never retries automatically,
 * so honor it in your own backoff. `details` carries the envelope's
 * structured detail when the server sent one (see
 * {@link memberImportErrors} and {@link isNotActive}).
 */
export class JunjoError extends Error {
  readonly requestId?: string;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    readonly code: JunjoErrorCode,
    readonly status?: number,
    opts?: {
      requestId?: string;
      retryAfterSeconds?: number;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "JunjoError";
    if (opts?.requestId !== undefined) this.requestId = opts.requestId;
    if (opts?.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
    if (opts?.details !== undefined) this.details = opts.details;
  }
}

/**
 * True when `err` is a ban lift's "no active ban" answer: `not_found`
 * with `details.reason === "not_active"`. Any other `not_found` (an
 * unknown group, for one) is false. A replayed lift has nothing left
 * to do in that case, so the outcome is the one the lift wanted.
 */
export function isNotActive(err: unknown): boolean {
  return (
    err instanceof JunjoError && err.code === "not_found" && err.details?.reason === "not_active"
  );
}

/**
 * The failing rows of a rejected member import, read from
 * `details.rows`. Empty for any other error, including an import that
 * failed for a reason not tied to rows. Entries are passed through as
 * the server sent them; `code` may hold a value newer than this SDK.
 */
export function memberImportErrors(err: unknown): MemberImportRowError[] {
  const rows = err instanceof JunjoError ? err.details?.rows : undefined;
  return Array.isArray(rows) ? (rows as MemberImportRowError[]) : [];
}
