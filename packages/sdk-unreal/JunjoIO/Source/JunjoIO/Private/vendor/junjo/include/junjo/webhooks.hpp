// Junjo.io SDK for C++
//
// Webhooks: endpoint management (Client::webhooks().endpoints()) and
// free delivery-verification functions that need no Client at all
// (verify_webhook / sign_webhook_body). The verification implements
// the same v1 scheme as the server and the TS SDK: HMAC-SHA256 over
// "<timestamp>.<body>" with the endpoint secret, hex-encoded, "v1="
// prefixed. The HMAC is computed with a bundled clean-room SHA-256; no
// crypto library dependency.
#pragma once

#include <chrono>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "junjo/cancellation.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"
#include "junjo/types.hpp"

namespace junjo {

namespace detail {
class RequestExecutor;
}  // namespace detail

class Client;
class WebhooksApi;

// Input for WebhookEndpointsApi::create.
struct CreateWebhookEndpointInput {
  // http(s) URL the worker will POST deliveries to. Loopback and
  // private hosts are rejected in production.
  std::string url;
  // Event-type strings to subscribe to ("member.joined", ...; the
  // server rejects strings it does not publish). Empty = match every
  // event type (the server default; an explicit empty list and an
  // omitted one are stored identically).
  std::vector<std::string> events;
  // Signing secret, 16..256 chars. When absent the server generates a
  // 32-byte base64url secret and returns it on the create response
  // (the only time it is ever surfaced).
  std::optional<std::string> secret;
  // Delivery format; server default is Junjo. WebhookFormat::Unknown
  // fails client-side with InvalidConfig before any request is made.
  std::optional<WebhookFormat> format;
};

// Input for WebhookEndpointsApi::update (PATCH semantics: absent
// fields stay untouched; the server requires at least one present).
// No field here is tri-state because none is nullable on the wire;
// `events` distinguishes omitted (keep) from an empty vector (match
// every event type), which optional<vector> captures exactly.
struct UpdateWebhookEndpointInput {
  std::optional<std::string> url;
  // Replaces the whole subscription list; an empty vector = match
  // every event type.
  std::optional<std::vector<std::string>> events;
  // true mutes the endpoint (sets disabled_at); false re-enables it.
  std::optional<bool> disabled;
  // WebhookFormat::Unknown fails client-side with InvalidConfig.
  std::optional<WebhookFormat> format;
};

// Options for WebhookEndpointsApi::list.
struct ListWebhookEndpointsOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  std::optional<std::chrono::milliseconds> timeout;
};

// Webhook endpoint management. Cheap to copy (shares the client's
// executor); thread-safe to the same degree as the Client it came
// from.
class JUNJO_API WebhookEndpointsApi {
 public:
  // POST /v1/webhooks. The returned secret is surfaced exactly once,
  // here; persist it immediately (list and update never return it).
  [[nodiscard]] Result<WebhookEndpointWithSecret> create(
      const CreateWebhookEndpointInput& input, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // GET /v1/webhooks: cursor-paginated listing, newest first. Drain
  // with junjo::paginate (junjo/pagination.hpp).
  [[nodiscard]] Result<Page<WebhookEndpoint>> list(
      const ListWebhookEndpointsOptions& options = {},
      const CancellationToken& token = {}) const;

  // PATCH /v1/webhooks/:id. Absent input fields stay untouched.
  [[nodiscard]] Result<WebhookEndpoint> update(std::string_view id,
                                               const UpdateWebhookEndpointInput& input,
                                               const RequestOptions& options = {},
                                               const CancellationToken& token = {}) const;

  // DELETE /v1/webhooks/:id. Hard delete; pending deliveries cascade.
  // Named remove because delete is a C++ keyword.
  [[nodiscard]] Result<void> remove(std::string_view id, const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

 private:
  friend class WebhooksApi;
  explicit WebhookEndpointsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

// The Webhooks subsystem. Endpoint CRUD lives under endpoints();
// delivery verification is the free verify_webhook below, which needs
// no client (a receiver only holds the endpoint secret).
class JUNJO_API WebhooksApi {
 public:
  // The endpoint-management surface. The returned value shares this
  // client's internals and remains valid after the WebhooksApi (and
  // Client) are destroyed.
  [[nodiscard]] WebhookEndpointsApi endpoints() const noexcept;

 private:
  friend class Client;
  explicit WebhooksApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

// ---------------------------------------------------------------------
// Delivery verification (no Client needed)
// ---------------------------------------------------------------------

// Signature scheme version prefixed onto every signature ("v1=<hex>").
// Kept in lockstep with the server's signing worker.
inline constexpr std::string_view kWebhookSignatureScheme = "v1";

// Default clock-skew tolerance for verify_webhook: 5 minutes in either
// direction.
inline constexpr std::chrono::milliseconds kWebhookDefaultTolerance{5 * 60 * 1000};

// The delivery headers verify_webhook reads (matched
// ASCII-case-insensitively).
inline constexpr std::string_view kWebhookSignatureHeader = "x-junjo-signature";
inline constexpr std::string_view kWebhookTimestampHeader = "x-junjo-timestamp";
inline constexpr std::string_view kWebhookEventIdHeader = "x-junjo-event-id";
inline constexpr std::string_view kWebhookDeliveryIdHeader = "x-junjo-delivery-id";

// Header list shape for verify_webhook: ordered name/value pairs, the
// same shape HttpRequest / HttpResponse use. Build it from whatever
// your HTTP framework hands you; names are matched
// ASCII-case-insensitively and the first match wins.
using WebhookHeaders = std::vector<std::pair<std::string, std::string>>;

// Options for verify_webhook.
struct VerifyWebhookOptions {
  // Maximum allowed clock skew in either direction. Raise only if your
  // receiver's clock and Junjo's are known to drift.
  std::chrono::milliseconds tolerance = kWebhookDefaultTolerance;
  // Wall-clock override for tests. Null = std::chrono::system_clock.
  std::function<std::chrono::system_clock::time_point()> now;
};

// A verified webhook delivery.
struct VerifiedWebhook {
  // The event's `type` field ("member.joined", ...). Returned verbatim
  // so event types this SDK version predates still verify; dispatch on
  // it yourself and ignore (while 2xx-acknowledging) types you do not
  // handle. This differs from the TS SDK, which deserializes into a
  // typed event union and therefore must reject unknown types
  // (unknown_event_type); modeling that union here is deferred.
  std::string event_type;
  // From x-junjo-event-id: stable per event, shared by every delivery
  // (and retry) of that event. The right key for dedupe. Absent only
  // when an intermediary stripped the header.
  std::optional<std::string> event_id;
  // From x-junjo-delivery-id: unique per delivery attempt.
  std::optional<std::string> delivery_id;
  // The raw request body, byte-for-byte as received (it is already
  // authenticated at this point). Parse with the JSON library of your
  // choice.
  std::string payload_json;
};

// HMAC-SHA256 of "<timestamp>.<body>" with `secret`, lowercase hex,
// prefixed with the scheme version ("v1=<64 hex chars>"). Mirrors the
// server's signWebhookBody; exposed for building test fixtures and
// custom verification flows.
[[nodiscard]] JUNJO_API std::string sign_webhook_body(std::string_view secret,
                                                      std::string_view body,
                                                      std::string_view timestamp);

// Verifies a webhook delivery against the endpoint secret. Pass the
// RAW request body exactly as received; re-serialized JSON will not
// match the signature.
//
// Verification order (parity with the TS SDK): the MAC is checked
// FIRST, over the raw header strings, before the timestamp is even
// parsed; unauthenticated senders get the same WebhookInvalidSignature
// for every probe instead of an oracle on the receiver's clock or
// tolerance settings. Only after the MAC passes: the timestamp must
// parse as ISO 8601 with an explicit UTC offset (the server only ever
// signs ISO strings), sit within `options.tolerance` of now in either
// direction, and the body must be a JSON object with a string `type`.
//
// Failures use the ErrorCode::Webhook* codes; no exceptions, no I/O.
[[nodiscard]] JUNJO_API Result<VerifiedWebhook> verify_webhook(
    std::string_view raw_body, const WebhookHeaders& headers, std::string_view secret,
    const VerifyWebhookOptions& options = {});

}  // namespace junjo
