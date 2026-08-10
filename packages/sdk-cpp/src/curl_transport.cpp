// Junjo.io SDK for C++
//
// libcurl transport implementation. One easy handle per request keeps
// the type trivially thread-safe; see curl_transport.hpp for the
// classification and TLS notes.

#include "junjo/curl_transport.hpp"

#include <cstddef>
#include <mutex>
#include <string>
#include <string_view>
#include <utility>

#include <curl/curl.h>

#include "junjo/error.hpp"

namespace junjo {

namespace {

// curl_global_init is not thread-safe and must run before any easy
// handle exists. The matching curl_global_cleanup is deliberately
// never called: it is unsafe while other threads may still touch curl,
// and the OS reclaims everything at process exit.
void ensure_curl_global_init() {
  static std::once_flag once;
  std::call_once(once, [] { curl_global_init(CURL_GLOBAL_DEFAULT); });
}

// Owns a CURL easy handle and its header list for one request.
class EasyHandle {
 public:
  EasyHandle() : handle_(curl_easy_init()) {}
  EasyHandle(const EasyHandle&) = delete;
  EasyHandle& operator=(const EasyHandle&) = delete;
  ~EasyHandle() {
    if (header_list_ != nullptr) curl_slist_free_all(header_list_);
    if (handle_ != nullptr) curl_easy_cleanup(handle_);
  }

  [[nodiscard]] CURL* get() const noexcept { return handle_; }

  void append_header(const std::string& line) {
    header_list_ = curl_slist_append(header_list_, line.c_str());
  }
  [[nodiscard]] curl_slist* header_list() const noexcept { return header_list_; }

 private:
  CURL* handle_ = nullptr;
  curl_slist* header_list_ = nullptr;
};

// Whether a raw header-callback line is the blank line terminating a
// header block.
[[nodiscard]] bool is_header_block_end(std::string_view line) noexcept {
  return line == "\r\n" || line == "\n";
}

// Folds one raw header-callback line into `response`. A new status
// line (interim 1xx block, or a redirect's header block if a caller
// ever enables redirects) resets the collection so only the final
// response block survives.
void collect_header_line(std::string_view line, HttpResponse& response) {
  if (line.rfind("HTTP/", 0) == 0) {
    response.headers.clear();
    return;
  }
  const size_t colon = line.find(':');
  if (colon == std::string_view::npos) {
    return;  // Blank end-of-block line or malformed; skip.
  }
  std::string_view name = line.substr(0, colon);
  std::string_view value = line.substr(colon + 1);
  const auto is_ws = [](char c) noexcept {
    return c == ' ' || c == '\t' || c == '\r' || c == '\n';
  };
  while (!value.empty() && is_ws(value.front())) value.remove_prefix(1);
  while (!value.empty() && is_ws(value.back())) value.remove_suffix(1);
  response.headers.emplace_back(std::string(name), std::string(value));
}

// Per-request state the buffered-path C callbacks write into.
struct CallbackState {
  HttpResponse response;
};

// Per-request state the streaming-path C callbacks write into.
struct StreamCallbackState {
  CURL* handle = nullptr;
  StreamHandler* handler = nullptr;
  // Status and headers for on_open; body stays empty.
  HttpResponse head;
  bool opened = false;
  // The handler asked to stop (on_open or on_data returned false);
  // the resulting CURLE_WRITE_ERROR is a success, not a failure.
  bool handler_stopped = false;
};

extern "C" {

size_t junjo_curl_write_body(char* data, size_t size, size_t nmemb, void* userdata) {
  auto* state = static_cast<CallbackState*>(userdata);
  const size_t total = size * nmemb;
  state->response.body.append(data, total);
  return total;
}

size_t junjo_curl_write_header(char* data, size_t size, size_t nmemb, void* userdata) {
  auto* state = static_cast<CallbackState*>(userdata);
  const size_t total = size * nmemb;
  collect_header_line(std::string_view(data, total), state->response);
  return total;
}

// Progress callback used purely as a cancellation poll. curl invokes
// it frequently during transfer and at least about once per second
// while stalled. A nonzero return aborts the transfer with
// CURLE_ABORTED_BY_CALLBACK, which maps to Cancelled.
int junjo_curl_progress(void* userdata, curl_off_t, curl_off_t, curl_off_t, curl_off_t) {
  const auto* token = static_cast<const CancellationToken*>(userdata);
  return token->is_cancelled() ? 1 : 0;
}

// Streaming header callback: collects lines like the buffered path,
// and fires StreamHandler::on_open when the final (non-1xx) header
// block completes, BEFORE any body byte, so a caller blocked on the
// open handshake is released even when the server sends no body bytes
// for a while (an idle SSE stream heartbeats every 30s at best).
size_t junjo_curl_stream_header(char* data, size_t size, size_t nmemb, void* userdata) {
  auto* state = static_cast<StreamCallbackState*>(userdata);
  const size_t total = size * nmemb;
  if (state->opened) {
    return total;  // Chunked-trailer lines after the body; not headers.
  }
  const std::string_view line(data, total);
  if (is_header_block_end(line)) {
    long status = 0;
    curl_easy_getinfo(state->handle, CURLINFO_RESPONSE_CODE, &status);
    if (status >= 100 && status < 200) {
      return total;  // Interim block; the real one follows.
    }
    state->head.status = static_cast<int>(status);
    state->opened = true;
    if (!state->handler->on_open(state->head)) {
      state->handler_stopped = true;
      return total + 1;  // Wrong size aborts the transfer.
    }
    return total;
  }
  collect_header_line(line, state->head);
  return total;
}

size_t junjo_curl_stream_write(char* data, size_t size, size_t nmemb, void* userdata) {
  auto* state = static_cast<StreamCallbackState*>(userdata);
  const size_t total = size * nmemb;
  if (!state->handler->on_data(std::string_view(data, total))) {
    state->handler_stopped = true;
    return total + 1;  // Wrong size aborts the transfer.
  }
  return total;
}

}  // extern "C"

[[nodiscard]] Error curl_failure(CURLcode code, const char* errbuf) {
  Error err;
  switch (code) {
    case CURLE_OPERATION_TIMEDOUT:
      err.code = ErrorCode::Timeout;
      err.message = "request timed out";
      return err;
    case CURLE_ABORTED_BY_CALLBACK:
      err.code = ErrorCode::Cancelled;
      err.message = "request cancelled";
      return err;
    default:
      err.code = ErrorCode::NetworkError;
      err.message = "network error: ";
      err.message += (errbuf != nullptr && errbuf[0] != '\0') ? errbuf
                                                             : curl_easy_strerror(code);
      return err;
  }
}

}  // namespace

CurlTransport::CurlTransport() { ensure_curl_global_init(); }

Result<HttpResponse> CurlTransport::execute(const HttpRequest& request,
                                            const CancellationToken& token) {
  // Fast path: no point standing up a handle for a dead request.
  if (token.is_cancelled()) {
    return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
  }

  EasyHandle easy;
  if (easy.get() == nullptr) {
    return Error{.code = ErrorCode::NetworkError,
                 .message = "network error: curl_easy_init failed"};
  }
  CURL* h = easy.get();

  CallbackState state;
  char errbuf[CURL_ERROR_SIZE] = {0};

  curl_easy_setopt(h, CURLOPT_URL, request.url.c_str());
  curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, request.method.c_str());
  // No signals: required for timeouts to be thread-safe on POSIX; a
  // no-op on Windows.
  curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
  // Redirects are NOT followed: the API never redirects, and silently
  // following one could re-send the authorization header elsewhere.
  curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 0L);
  // TLS verification pinned on explicitly rather than inherited from
  // the linked curl's build defaults.
  curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 1L);
  curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 2L);
  curl_easy_setopt(h, CURLOPT_ERRORBUFFER, errbuf);

  if (request.body.has_value()) {
    // The HttpRequest outlives curl_easy_perform, so pointing curl at
    // its buffer without copying is safe.
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, request.body->c_str());
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE_LARGE,
                     static_cast<curl_off_t>(request.body->size()));
  }

  for (const auto& [name, value] : request.headers) {
    easy.append_header(name + ": " + value);
  }
  if (easy.header_list() != nullptr) {
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, easy.header_list());
  }

  if (request.timeout.has_value()) {
    curl_easy_setopt(h, CURLOPT_TIMEOUT_MS, static_cast<long>(request.timeout->count()));
  }

  curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, junjo_curl_write_body);
  curl_easy_setopt(h, CURLOPT_WRITEDATA, &state);
  curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, junjo_curl_write_header);
  curl_easy_setopt(h, CURLOPT_HEADERDATA, &state);
  curl_easy_setopt(h, CURLOPT_XFERINFOFUNCTION, junjo_curl_progress);
  curl_easy_setopt(h, CURLOPT_XFERINFODATA, const_cast<CancellationToken*>(&token));
  curl_easy_setopt(h, CURLOPT_NOPROGRESS, 0L);

  const CURLcode result = curl_easy_perform(h);
  if (result != CURLE_OK) {
    return curl_failure(result, errbuf);
  }

  long status = 0;
  curl_easy_getinfo(h, CURLINFO_RESPONSE_CODE, &status);
  state.response.status = static_cast<int>(status);
  return std::move(state.response);
}

Result<void> CurlTransport::execute_stream(const HttpRequest& request, StreamHandler& handler,
                                           const CancellationToken& token) {
  // The single terminal report: on_complete, then the same result back
  // to the caller, on every path out of this function.
  const auto finish = [&handler](Result<void> result) -> Result<void> {
    handler.on_complete(result);
    return result;
  };

  if (token.is_cancelled()) {
    return finish(Error{.code = ErrorCode::Cancelled, .message = "request cancelled"});
  }

  EasyHandle easy;
  if (easy.get() == nullptr) {
    return finish(Error{.code = ErrorCode::NetworkError,
                        .message = "network error: curl_easy_init failed"});
  }
  CURL* h = easy.get();

  StreamCallbackState state;
  state.handle = h;
  state.handler = &handler;
  char errbuf[CURL_ERROR_SIZE] = {0};

  curl_easy_setopt(h, CURLOPT_URL, request.url.c_str());
  curl_easy_setopt(h, CURLOPT_CUSTOMREQUEST, request.method.c_str());
  curl_easy_setopt(h, CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(h, CURLOPT_FOLLOWLOCATION, 0L);
  // TLS verification pinned on explicitly rather than inherited from
  // the linked curl's build defaults.
  curl_easy_setopt(h, CURLOPT_SSL_VERIFYPEER, 1L);
  curl_easy_setopt(h, CURLOPT_SSL_VERIFYHOST, 2L);
  curl_easy_setopt(h, CURLOPT_ERRORBUFFER, errbuf);

  if (request.body.has_value()) {
    curl_easy_setopt(h, CURLOPT_POSTFIELDS, request.body->c_str());
    curl_easy_setopt(h, CURLOPT_POSTFIELDSIZE_LARGE,
                     static_cast<curl_off_t>(request.body->size()));
  }

  for (const auto& [name, value] : request.headers) {
    easy.append_header(name + ": " + value);
  }
  if (easy.header_list() != nullptr) {
    curl_easy_setopt(h, CURLOPT_HTTPHEADER, easy.header_list());
  }

  // Streams are exempt from the whole-request timeout by design (an
  // event stream stays open indefinitely; the TS SDK's openStream has
  // the same exemption). request.timeout, when set, bounds the CONNECT
  // phase only, so a black-holed connection attempt still surfaces as
  // Timeout while an idle open stream does not.
  if (request.timeout.has_value()) {
    curl_easy_setopt(h, CURLOPT_CONNECTTIMEOUT_MS,
                     static_cast<long>(request.timeout->count()));
  }

  curl_easy_setopt(h, CURLOPT_WRITEFUNCTION, junjo_curl_stream_write);
  curl_easy_setopt(h, CURLOPT_WRITEDATA, &state);
  curl_easy_setopt(h, CURLOPT_HEADERFUNCTION, junjo_curl_stream_header);
  curl_easy_setopt(h, CURLOPT_HEADERDATA, &state);
  curl_easy_setopt(h, CURLOPT_XFERINFOFUNCTION, junjo_curl_progress);
  curl_easy_setopt(h, CURLOPT_XFERINFODATA, const_cast<CancellationToken*>(&token));
  curl_easy_setopt(h, CURLOPT_NOPROGRESS, 0L);

  const CURLcode result = curl_easy_perform(h);

  // A handler-requested stop travels as a wrong-size callback return
  // (CURLE_WRITE_ERROR, or CURLE_ABORTED_BY_CALLBACK depending on the
  // phase); either way it is a success here, the handler knows why it
  // stopped. A token cancellation aborts via the progress callback.
  if (state.handler_stopped) {
    return finish(Result<void>::ok());
  }
  if (result == CURLE_OK) {
    return finish(Result<void>::ok());
  }
  if (result == CURLE_ABORTED_BY_CALLBACK || token.is_cancelled()) {
    return finish(Error{.code = ErrorCode::Cancelled, .message = "request cancelled"});
  }
  if (result == CURLE_OPERATION_TIMEDOUT) {
    return finish(Error{.code = ErrorCode::Timeout, .message = "connect timed out"});
  }
  Error err;
  err.code = ErrorCode::NetworkError;
  err.message = "network error: ";
  err.message += (errbuf[0] != '\0') ? errbuf : curl_easy_strerror(result);
  return finish(std::move(err));
}

}  // namespace junjo
