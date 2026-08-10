// Junjo.io SDK for C++
//
// Transport abstraction. The Client speaks to the Junjo API through
// this interface; the bundled libcurl transport (curl_transport.hpp)
// is the default, and tests or embedders with their own HTTP stack can
// substitute any implementation.
#pragma once

#include <chrono>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "junjo/cancellation.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"

namespace junjo {

// A single HTTP request, fully specified by the caller. Plain data:
// the transport must not need any hidden client state to execute it.
struct HttpRequest {
  // Uppercase verb: "GET", "POST", "PATCH", "PUT", "DELETE".
  std::string method;
  // Absolute URL including any query string, already percent-encoded.
  std::string url;
  // Ordered name/value pairs, sent verbatim. Names are expected in
  // lowercase by convention; HTTP header names are case-insensitive on
  // the wire so transports must not care.
  std::vector<std::pair<std::string, std::string>> headers;
  // Request body; absent means "send no body" (distinct from an empty
  // body).
  std::optional<std::string> body;
  // Whole-request deadline. Absent means the transport imposes no
  // timeout of its own. Timeout expiry must surface as
  // ErrorCode::Timeout, never as NetworkError.
  std::optional<std::chrono::milliseconds> timeout;
};

// A complete HTTP response. The transport buffers the full body;
// streaming responses go through execute_stream instead.
struct JUNJO_API HttpResponse {
  int status = 0;
  // Response headers in arrival order. Names keep their wire casing;
  // use header() for lookups.
  std::vector<std::pair<std::string, std::string>> headers;
  std::string body;

  // First header whose name matches `name` ASCII-case-insensitively,
  // or nullopt. The returned view points into `headers` and is
  // invalidated by mutating or destroying this response.
  [[nodiscard]] std::optional<std::string_view> header(std::string_view name) const noexcept;
};

// Receives a streaming response incrementally. Implemented by the SDK
// for SSE subscriptions (junjo/events.hpp) and by tests; a custom
// handler works too. All callbacks arrive on the thread that called
// execute_stream, strictly ordered: on_open at most once, then
// on_data zero or more times, then on_complete exactly once.
// Callbacks must not throw (they are invoked from inside transport
// machinery that cannot unwind, e.g. libcurl's C callbacks).
class JUNJO_API StreamHandler {
 public:
  StreamHandler() = default;
  StreamHandler(const StreamHandler&) = delete;
  StreamHandler& operator=(const StreamHandler&) = delete;
  virtual ~StreamHandler();

  // Called once when the response header block is complete, before any
  // body data: `head` carries the status and headers with an empty
  // body. Not called when the connection fails before a response
  // (on_complete still is). Return false to stop the stream; the
  // transport then finishes with a SUCCESS on_complete (the handler
  // knows why it stopped).
  [[nodiscard]] virtual bool on_open(const HttpResponse& head);

  // One chunk of response body, in arrival order. Chunk boundaries are
  // transport-determined and carry no meaning; the view is only valid
  // for the duration of the call. Return false to stop the stream
  // (SUCCESS on_complete, as with on_open).
  [[nodiscard]] virtual bool on_data(std::string_view chunk) = 0;

  // The terminal outcome, exactly once, as the last callback and
  // always before execute_stream returns (which returns the same
  // result): success for a server-ended stream or a handler-requested
  // stop, Cancelled for the token, Timeout for a connect-phase
  // timeout, NetworkError for a mid-stream drop.
  virtual void on_complete(const Result<void>& result) = 0;
};

// Executes HTTP requests. Implementations must be safe to call from
// multiple threads concurrently (the Client may be shared across
// threads) and must classify failures precisely:
//   - ErrorCode::Timeout when request.timeout elapsed,
//   - ErrorCode::Cancelled when the token was observed cancelled,
//   - ErrorCode::NetworkError for everything else that prevented a
//     response (DNS, refused connection, TLS failure).
// Any received response, whatever its status code, is a SUCCESS at
// this layer; HTTP-level error handling is the Client's job.
// Implementations should poll `token` at their natural progress points
// (see cancellation.hpp for the delivery guarantees).
class JUNJO_API Transport {
 public:
  Transport() = default;
  Transport(const Transport&) = delete;
  Transport& operator=(const Transport&) = delete;
  virtual ~Transport();

  [[nodiscard]] virtual Result<HttpResponse> execute(const HttpRequest& request,
                                                     const CancellationToken& token) = 0;

  // Executes `request` delivering the response incrementally to
  // `handler` (see StreamHandler for the callback contract). Blocks
  // until the stream ends; the returned result is the same one passed
  // to on_complete.
  //
  // Timeout semantics differ from execute on purpose: when
  // request.timeout is set it bounds the CONNECT phase only, never the
  // body. A stream stays open indefinitely by design (mirroring the TS
  // SDK, whose openStream is exempt from the request timeout); ending
  // one is the token's job (or the handler returning false).
  //
  // The base implementation fails with InvalidConfig ("streaming not
  // supported") after an on_complete carrying the same error, so
  // Transport implementations written before this method existed stay
  // source-compatible; override it to support SSE subscriptions.
  [[nodiscard]] virtual Result<void> execute_stream(const HttpRequest& request,
                                                    StreamHandler& handler,
                                                    const CancellationToken& token);
};

}  // namespace junjo
