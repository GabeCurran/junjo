// Junjo.io SDK for C++
//
// Error model. Failed SDK operations are reported as junjo::Error values
// carried inside junjo::Result<T>; the SDK never throws for API or
// transport failures (see result.hpp for the exception policy).
#pragma once

#include <optional>
#include <string>
#include <string_view>

#include "junjo/export.hpp"

namespace junjo {

// Every failure code the SDK can produce.
//
// The first block mirrors the server's canonical error-envelope codes
// (the wire strings in packages/shared JUNJO_ERROR_CODES, e.g.
// "not_found" -> ErrorCode::NotFound). The second block is SDK-side:
// transport failures and client-side validation that never reached the
// server, kept distinct so a caller can tell "the server rejected it"
// apart from "the request never got there" without string-matching.
//
// Forward compatibility: a newer server may send codes this SDK version
// does not know. Those map to ErrorCode::Unknown with the wire string
// preserved in Error::raw_code, so switches over ErrorCode must keep a
// default branch.
enum class ErrorCode {
  // Server envelope codes.
  BadRequest,
  InvalidApiKey,
  InvalidAdminToken,
  PermissionDenied,
  NotFound,
  AlreadyMember,
  RoleHasMembers,
  RoleNameTaken,
  RoleGroupMismatch,
  ParentCycle,
  Banned,
  PasscodeRequired,
  PasscodeInvalid,
  InvitationExpired,
  InvitationUsed,
  RestoreWindowExpired,
  RateLimitExceeded,
  Internal,

  // SDK-side codes.
  // The transport failed before a response arrived: DNS failure,
  // connection refused, TLS error. The request may or may not have
  // reached the server.
  NetworkError,
  // The configured timeout (or a per-request override) elapsed before
  // the response arrived.
  Timeout,
  // The caller's CancellationToken was cancelled.
  Cancelled,
  // A 2xx response carried a body the SDK could not parse or that
  // failed wire validation.
  InvalidWireData,
  // Client construction options were invalid; no request was made.
  InvalidConfig,
  // An SSE subscription's unterminated frame buffer exceeded the 1 MiB
  // cap (junjo/events.hpp): a broken or hostile stream that never sent
  // a frame delimiter. The subscription is closed before on_error
  // reports this. Wire-name parity with the TS SDK's stream_overflow.
  StreamOverflow,

  // Webhook verification failures, produced only by verify_webhook
  // (junjo/webhooks.hpp). Local checks on an inbound delivery; no
  // request is involved. The names mirror the TS SDK's webhook_* codes.
  // The signature header (x-junjo-signature) is absent.
  WebhookSignatureMissing,
  // The timestamp header (x-junjo-timestamp) is absent.
  WebhookTimestampMissing,
  // The signature does not match the expected HMAC for this secret,
  // timestamp, and body. Also covers a wrong scheme prefix.
  WebhookInvalidSignature,
  // The (authenticated) timestamp header did not parse as a timestamp.
  WebhookTimestampInvalid,
  // The (authenticated) timestamp is outside the tolerance window in
  // either direction: a replay or a badly skewed clock.
  WebhookTimestampOutOfTolerance,
  // The (authenticated) body is not a JSON object with a string `type`
  // field.
  WebhookInvalidBody,
  // A non-2xx response that did not carry the Junjo error envelope
  // (e.g. an HTML 502 from an intermediary proxy), or an envelope code
  // this SDK version does not know (see Error::raw_code).
  Unknown,
};

// A failed SDK operation. Plain value type: copyable, movable, no
// ownership subtleties.
struct Error {
  ErrorCode code = ErrorCode::Unknown;
  // Human-readable description. Worth logging; not worth branching on
  // (branch on `code` instead).
  std::string message;
  // HTTP status, set only when a response was actually received.
  std::optional<int> status;
  // Correlation id matching the server's x-request-id header; present
  // on server errors that carried one. Worth quoting in bug reports.
  std::optional<std::string> request_id;
  // Set on rate-limited responses carrying an integral Retry-After
  // header. The SDK never retries automatically; honor this in your
  // own backoff.
  std::optional<int> retry_after_seconds;
  // The wire code string exactly as the server sent it, preserved for
  // forward compatibility when `code == ErrorCode::Unknown` (a newer
  // server may send codes this SDK version does not map). Empty when
  // the failure did not come from a server envelope.
  std::string raw_code;
};

// Stable name for an ErrorCode: the server's wire string for envelope
// codes ("not_found"), snake_case for SDK-side codes ("network_error").
// The returned view points at a string literal with static storage
// duration.
[[nodiscard]] JUNJO_API std::string_view to_string(ErrorCode code) noexcept;

// Maps a server wire code string to the matching ErrorCode. Unknown
// wire strings map to ErrorCode::Unknown; callers should preserve the
// original string in Error::raw_code.
[[nodiscard]] JUNJO_API ErrorCode error_code_from_wire(std::string_view wire) noexcept;

}  // namespace junjo
