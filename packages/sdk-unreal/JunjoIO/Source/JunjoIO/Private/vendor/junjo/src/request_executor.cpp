// Junjo.io SDK for C++

#include "request_executor.hpp"

#include <cctype>
#include <charconv>

#include "junjo/error.hpp"

namespace junjo::detail {

namespace {

// Parses a Retry-After header value as whole seconds. The server sends
// integral seconds; HTTP-date values (also legal per RFC 9110) are
// ignored rather than guessed at, matching the TS SDK.
[[nodiscard]] std::optional<int> parse_retry_after(std::string_view raw) noexcept {
  // Trim ASCII whitespace.
  while (!raw.empty() && std::isspace(static_cast<unsigned char>(raw.front())) != 0) {
    raw.remove_prefix(1);
  }
  while (!raw.empty() && std::isspace(static_cast<unsigned char>(raw.back())) != 0) {
    raw.remove_suffix(1);
  }
  if (raw.empty()) return std::nullopt;
  for (const char c : raw) {
    if (std::isdigit(static_cast<unsigned char>(c)) == 0) return std::nullopt;
  }
  int seconds = 0;
  const auto [ptr, ec] = std::from_chars(raw.data(), raw.data() + raw.size(), seconds);
  if (ec != std::errc{} || ptr != raw.data() + raw.size()) return std::nullopt;
  return seconds;
}

// Turns a transport outcome into the classified JsonBody the surface
// layer consumes: transport failure passes through, non-2xx becomes the
// envelope error, 204 becomes an empty body, and any other 2xx must
// carry parseable JSON or it fails as InvalidWireData. Shared by every
// buffered request regardless of how the request body was encoded.
[[nodiscard]] Result<JsonBody> classify_response(Result<HttpResponse> executed) {
  if (!executed.has_value()) {
    return std::move(executed).error();
  }
  const HttpResponse& response = executed.value();

  const bool is_success = response.status >= 200 && response.status < 300;
  if (!is_success) {
    return envelope_error(response);
  }

  if (response.status == 204) {
    return JsonBody{.status = response.status, .value = std::nullopt};
  }

  std::optional<Json> parsed = parse_json(response.body);
  if (!parsed.has_value()) {
    return Error{.code = ErrorCode::InvalidWireData,
                 .message = "response body was not valid JSON",
                 .status = response.status};
  }
  return JsonBody{.status = response.status, .value = std::move(parsed)};
}

}  // namespace

// A body that is not the { code, status, message, requestId? }
// envelope (an HTML 502 from a proxy, an empty body) produces
// ErrorCode::Unknown with the transport status, never a fabricated
// server code. Known-shape envelopes with a code string this SDK does
// not recognize also map to Unknown, with the wire string preserved in
// raw_code for forward compatibility.
Error envelope_error(const HttpResponse& response) {
  Error err;
  err.code = ErrorCode::Unknown;
  err.status = response.status;

  std::optional<Json> parsed = parse_json(response.body);
  const bool is_object = parsed.has_value() && parsed->is_object();

  if (is_object) {
    if (const auto code_it = parsed->find("code");
        code_it != parsed->end() && code_it->is_string()) {
      err.raw_code = code_it->get<std::string>();
      err.code = error_code_from_wire(err.raw_code);
    }
    if (const auto status_it = parsed->find("status");
        status_it != parsed->end() && status_it->is_number_integer()) {
      err.status = status_it->get<int>();
    }
    if (const auto message_it = parsed->find("message");
        message_it != parsed->end() && message_it->is_string()) {
      err.message = message_it->get<std::string>();
    }
    if (const auto id_it = parsed->find("requestId");
        id_it != parsed->end() && id_it->is_string()) {
      err.request_id = id_it->get<std::string>();
    }
  }

  if (err.message.empty()) {
    err.message = "request failed with HTTP " + std::to_string(response.status);
  }
  if (!err.request_id.has_value()) {
    if (const auto header_id = response.header("x-request-id"); header_id.has_value()) {
      err.request_id = std::string(*header_id);
    }
  }
  if (const auto retry_after = response.header("retry-after"); retry_after.has_value()) {
    err.retry_after_seconds = parse_retry_after(*retry_after);
  }
  return err;
}

Result<JsonBody> RequestExecutor::execute_json(
    std::string_view method, std::string_view path_and_query, const std::optional<Json>& body,
    const CancellationToken& token,
    std::optional<std::chrono::milliseconds> timeout_override) const {
  // Pre-flight cancellation: a token cancelled before dispatch means
  // the transport is never invoked at all.
  if (token.is_cancelled()) {
    return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
  }

  HttpRequest request;
  request.method.assign(method);
  request.url.reserve(config_.base_url.size() + path_and_query.size());
  request.url.append(config_.base_url).append(path_and_query);

  request.headers.emplace_back("authorization", "Bearer " + config_.api_key);
  if (body.has_value()) {
    request.headers.emplace_back("content-type", "application/json");
    request.body = body->dump();
  }

  const std::chrono::milliseconds effective =
      timeout_override.has_value() ? *timeout_override : config_.timeout;
  if (effective.count() > 0) {
    request.timeout = effective;
  }

  return classify_response(config_.transport->execute(request, token));
}

Result<JsonBody> RequestExecutor::execute_raw(
    std::string_view method, std::string_view path_and_query, std::string body,
    std::string_view content_type, const CancellationToken& token,
    std::optional<std::chrono::milliseconds> timeout_override) const {
  // Pre-flight cancellation: a token cancelled before dispatch means
  // the transport is never invoked at all.
  if (token.is_cancelled()) {
    return Error{.code = ErrorCode::Cancelled, .message = "request cancelled"};
  }

  HttpRequest request;
  request.method.assign(method);
  request.url.reserve(config_.base_url.size() + path_and_query.size());
  request.url.append(config_.base_url).append(path_and_query);

  request.headers.emplace_back("authorization", "Bearer " + config_.api_key);
  request.headers.emplace_back("content-type", std::string(content_type));
  // Unlike the JSON path, the body is always sent (an empty raw body is
  // a valid payload the server parses as zero rows).
  request.body = std::move(body);

  const std::chrono::milliseconds effective =
      timeout_override.has_value() ? *timeout_override : config_.timeout;
  if (effective.count() > 0) {
    request.timeout = effective;
  }

  return classify_response(config_.transport->execute(request, token));
}

}  // namespace junjo::detail
