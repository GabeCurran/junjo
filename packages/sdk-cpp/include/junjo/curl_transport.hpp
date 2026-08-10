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

#include <memory>

#include "junjo/cancellation.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"
#include "junjo/transport.hpp"

namespace junjo {

// Transport backed by libcurl easy handles, one per request. Each
// request still creates, owns, and destroys its own easy handle for the
// duration of the call, so a request holds no shared mutable state of
// its own and concurrent execute() calls from multiple threads are
// safe. The handles are attached to a single per-transport CURLSH share
// whose connection cache (CURL_LOCK_DATA_CONNECT), DNS cache
// (CURL_LOCK_DATA_DNS), and TLS-session cache (CURL_LOCK_DATA_SSL_SESSION)
// are shared, so per-request handles reuse pooled keep-alive
// connections to the same host across requests and threads instead of
// paying a fresh TCP and TLS handshake every call. The share is the
// only cross-request state; it is safe for concurrent use because its
// lock and unlock callbacks serialize access to each cache through a
// dedicated mutex per lock-data kind. The share and its mutexes outlive
// every easy handle that references them.
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
  // Cleans up the share after no easy handle can reference it. Every
  // execute call is synchronous and owns its handle for the call's
  // duration, so destroying the transport while a call is in flight is
  // a use-after-free the caller must not commit, exactly as for any
  // object with methods in progress.
  ~CurlTransport() override;

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

 private:
  // Holds the CURLSH share and the mutexes that back its lock and
  // unlock callbacks. Defined in the translation unit so no libcurl
  // type appears in this installed header. Held by unique_ptr so the
  // share and its mutexes have a stable address for the whole
  // transport lifetime and outlive every easy handle that references
  // them.
  struct Shared;
  std::unique_ptr<Shared> shared_;
};

}  // namespace junjo
