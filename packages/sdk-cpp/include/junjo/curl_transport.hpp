// Junjo.io SDK for C++
//
// The bundled libcurl transport. Only available when the library was
// built with JUNJO_BUILD_CURL_TRANSPORT (the default); this header is
// not installed otherwise.
//
// TLS: libcurl's platform defaults. When the build vendors curl via
// FetchContent on Windows, that is Schannel (the OS certificate store,
// no CA bundle to ship); a system-provided libcurl uses whatever TLS
// backend it was built with.
#pragma once

#include "junjo/cancellation.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"
#include "junjo/transport.hpp"

namespace junjo {

// Transport backed by libcurl easy handles, one per request: no shared
// mutable state, so concurrent execute() calls from multiple threads
// are safe. The cost is no cross-request connection reuse yet;
// TODO(junjo): pool easy handles (or move to the multi interface) once
// profiling justifies it.
//
// Failure classification: timeout expiry (CURLOPT_TIMEOUT_MS from
// HttpRequest::timeout) maps to ErrorCode::Timeout; cancellation is
// observed by polling the token from curl's progress callback and maps
// to ErrorCode::Cancelled; everything else curl reports maps to
// ErrorCode::NetworkError with curl's error text.
//
// Constructing the first CurlTransport performs process-wide libcurl
// initialization (curl_global_init) exactly once. The matching global
// cleanup is deliberately never called: it is unsafe while any thread
// may still use curl, and the OS reclaims everything at exit anyway.
class JUNJO_API CurlTransport final : public Transport {
 public:
  CurlTransport();

  [[nodiscard]] Result<HttpResponse> execute(const HttpRequest& request,
                                             const CancellationToken& token) override;

  // Streaming per the Transport::execute_stream contract. on_open
  // fires as soon as the final header block arrives (before any body
  // byte, so an idle SSE stream does not stall the open handshake).
  // request.timeout bounds the connect phase only
  // (CURLOPT_CONNECTTIMEOUT_MS); the body is exempt from any timeout,
  // matching the TS SDK's stream exemption. Cancellation is polled
  // from curl's progress callback, roughly once per second during
  // stalls.
  [[nodiscard]] Result<void> execute_stream(const HttpRequest& request, StreamHandler& handler,
                                            const CancellationToken& token) override;
};

}  // namespace junjo
