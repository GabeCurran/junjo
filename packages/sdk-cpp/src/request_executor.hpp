// Junjo.io SDK for C++
//
// Internal request pipeline shared by every API surface: URL assembly,
// auth header, timeout selection, cancellation pre-flight, and the
// response classification rules that mirror the TS SDK's HttpClient
// (packages/sdk/src/http.ts). Not installed.
#pragma once

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "junjo/cancellation.hpp"
#include "junjo/result.hpp"
#include "junjo/transport.hpp"

#include "json.hpp"

namespace junjo::detail {

// A classified 2xx response body.
struct JsonBody {
  // HTTP status of the successful response.
  int status = 0;
  // Absent exactly for 204 No Content; present (and valid JSON) for
  // every other success.
  std::optional<Json> value;
};

// Immutable after construction; therefore safe to share across threads
// (the transport carries its own thread-safety contract).
class RequestExecutor {
 public:
  struct Config {
    std::string api_key;
    // Already normalized: no trailing slash.
    std::string base_url;
    // Already normalized: no trailing slash. Absent when the caller did
    // not configure it; GroupsApi::invite_by_link fails with
    // InvalidConfig in that case.
    std::optional<std::string> invite_base_url;
    // <= 0 means "no client-level timeout".
    std::chrono::milliseconds timeout{0};
    std::shared_ptr<Transport> transport;
  };

  explicit RequestExecutor(Config config) : config_(std::move(config)) {}

  // Sends `method path_and_query` and classifies the response:
  //   - cancellation observed before dispatch -> Cancelled (the
  //     transport is never called),
  //   - transport failure -> its error, passed through,
  //   - 2xx with 204 -> JsonBody{204, nullopt},
  //   - 2xx with a body that fails to parse -> InvalidWireData,
  //   - non-2xx -> Error from the envelope: known code string mapped
  //     via error_code_from_wire, unknown code or non-envelope body ->
  //     ErrorCode::Unknown, with raw_code preserving the wire string,
  //     status from the envelope (transport status as fallback),
  //     request_id from the body or the x-request-id header, and
  //     retry_after_seconds from an integral Retry-After header.
  //
  // `path_and_query` must start with '/' and be fully percent-encoded.
  // `timeout_override`, when set, replaces the client-level timeout
  // for this request (<= 0 disables it).
  [[nodiscard]] Result<JsonBody> execute_json(
      std::string_view method, std::string_view path_and_query,
      const std::optional<Json>& body, const CancellationToken& token,
      std::optional<std::chrono::milliseconds> timeout_override = std::nullopt) const;

  // As execute_json, but sends `body` verbatim under `content_type`
  // rather than a serialized JSON object; the body is always sent, even
  // when empty. The response is classified identically (2xx JSON body,
  // 204 -> empty JsonBody, non-2xx -> envelope error). For routes whose
  // request payload is not JSON.
  [[nodiscard]] Result<JsonBody> execute_raw(
      std::string_view method, std::string_view path_and_query, std::string body,
      std::string_view content_type, const CancellationToken& token,
      std::optional<std::chrono::milliseconds> timeout_override = std::nullopt) const;

  // For surfaces that speak to the transport directly (the SSE
  // subscription layer builds a streaming request itself).
  [[nodiscard]] const Config& config() const noexcept { return config_; }

 private:
  Config config_;
};

// Builds the Error for a non-2xx response per the envelope contract:
// known code strings map via error_code_from_wire, an unknown code or
// a non-envelope body (an HTML 502 from a proxy) maps to
// ErrorCode::Unknown, raw_code preserves the wire string, request_id
// comes from the body or the x-request-id header, and
// retry_after_seconds from an integral Retry-After header. Shared by
// the buffered pipeline and the SSE open handshake.
[[nodiscard]] Error envelope_error(const HttpResponse& response);

}  // namespace junjo::detail
