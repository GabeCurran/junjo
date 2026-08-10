// Junjo.io SDK for C++

#include "junjo/webhooks.hpp"

#include <cctype>
#include <cstdint>
#include <utility>

#include "junjo/error.hpp"

#include "hmac_sha256.hpp"
#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

namespace {

using detail::Json;

[[nodiscard]] Error invalid_config(std::string message) {
  return Error{.code = ErrorCode::InvalidConfig, .message = std::move(message)};
}

// Serializes a format input, rejecting Unknown (which exists only so
// newer server VALUES deserialize; it has no wire spelling).
[[nodiscard]] Result<std::string> format_to_wire(WebhookFormat format) {
  if (format == WebhookFormat::Unknown) {
    return invalid_config(
        "WebhookFormat::Unknown cannot be sent; pick Junjo, Discord, or Slack");
  }
  return std::string(to_string(format));
}

}  // namespace

// ---------------------------------------------------------------------
// WebhookEndpointsApi
// ---------------------------------------------------------------------

WebhookEndpointsApi::WebhookEndpointsApi(
    std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<WebhookEndpointWithSecret> WebhookEndpointsApi::create(
    const CreateWebhookEndpointInput& input, const RequestOptions& options,
    const CancellationToken& token) const {
  Json body = Json::object();
  body["url"] = input.url;
  // An empty vector is omitted rather than sent: the server stores an
  // omitted list and an explicit [] identically (match-all), so
  // nothing is lost and the body stays minimal like the TS SDK's.
  if (!input.events.empty()) body["events"] = input.events;
  if (input.secret.has_value()) body["secret"] = *input.secret;
  if (input.format.has_value()) {
    Result<std::string> format = format_to_wire(*input.format);
    if (!format.has_value()) return std::move(format).error();
    body["format"] = std::move(format).value();
  }
  return detail::to_value<WebhookEndpointWithSecret>(
      executor_->execute_json("POST", "/v1/webhooks", body, token, options.timeout),
      detail::deserialize_webhook_endpoint_with_secret);
}

Result<Page<WebhookEndpoint>> WebhookEndpointsApi::list(
    const ListWebhookEndpointsOptions& options, const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);

  const std::string path = "/v1/webhooks" + detail::build_query(params);
  return detail::to_page<WebhookEndpoint>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_webhook_endpoint);
}

Result<WebhookEndpoint> WebhookEndpointsApi::update(std::string_view id,
                                                    const UpdateWebhookEndpointInput& input,
                                                    const RequestOptions& options,
                                                    const CancellationToken& token) const {
  Json body = Json::object();
  if (input.url.has_value()) body["url"] = *input.url;
  if (input.events.has_value()) body["events"] = *input.events;
  if (input.disabled.has_value()) body["disabled"] = *input.disabled;
  if (input.format.has_value()) {
    Result<std::string> format = format_to_wire(*input.format);
    if (!format.has_value()) return std::move(format).error();
    body["format"] = std::move(format).value();
  }
  const std::string path = "/v1/webhooks/" + detail::percent_encode(id);
  return detail::to_value<WebhookEndpoint>(
      executor_->execute_json("PATCH", path, body, token, options.timeout),
      detail::deserialize_webhook_endpoint);
}

Result<void> WebhookEndpointsApi::remove(std::string_view id, const RequestOptions& options,
                                         const CancellationToken& token) const {
  const std::string path = "/v1/webhooks/" + detail::percent_encode(id);
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

// ---------------------------------------------------------------------
// WebhooksApi
// ---------------------------------------------------------------------

WebhooksApi::WebhooksApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

WebhookEndpointsApi WebhooksApi::endpoints() const noexcept {
  return WebhookEndpointsApi(executor_);
}

// ---------------------------------------------------------------------
// Delivery verification
// ---------------------------------------------------------------------

namespace {

[[nodiscard]] Error webhook_error(ErrorCode code, std::string message) {
  return Error{.code = code, .message = std::move(message)};
}

// First header whose name matches ASCII-case-insensitively.
[[nodiscard]] const std::string* pick_header(const WebhookHeaders& headers,
                                             std::string_view name) {
  for (const auto& [key, value] : headers) {
    if (key.size() != name.size()) continue;
    bool matches = true;
    for (std::size_t i = 0; i < name.size(); ++i) {
      const auto a = static_cast<unsigned char>(key[i]);
      const auto b = static_cast<unsigned char>(name[i]);
      if (std::tolower(a) != std::tolower(b)) {
        matches = false;
        break;
      }
    }
    if (matches) return &value;
  }
  return nullptr;
}

// Reads exactly `count` ASCII digits from `text` at `pos` into `out`;
// false when anything else (including end of input) is found.
[[nodiscard]] bool read_digits(std::string_view text, std::size_t& pos, int count,
                               std::int64_t& out) {
  std::int64_t value = 0;
  for (int i = 0; i < count; ++i) {
    if (pos >= text.size() || text[pos] < '0' || text[pos] > '9') return false;
    value = value * 10 + (text[pos] - '0');
    ++pos;
  }
  out = value;
  return true;
}

// Days from 1970-01-01 for a civil date (Howard Hinnant's
// days_from_civil algorithm; public-domain arithmetic).
[[nodiscard]] std::int64_t days_from_civil(std::int64_t year, std::int64_t month,
                                           std::int64_t day) {
  year -= month <= 2 ? 1 : 0;
  const std::int64_t era = (year >= 0 ? year : year - 399) / 400;
  const std::int64_t yoe = year - era * 400;
  const std::int64_t doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1;
  const std::int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097 + doe - 719468;
}

[[nodiscard]] bool is_leap_year(std::int64_t year) {
  return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

[[nodiscard]] std::int64_t days_in_month(std::int64_t year, std::int64_t month) {
  constexpr std::int64_t kDays[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
  if (month == 2 && is_leap_year(year)) return 29;
  return kDays[month - 1];
}

// Parses an ISO 8601 date-time with an explicit UTC designator or
// numeric offset ("2026-04-28T05:00:30.000Z", offsets as "+hh:mm" /
// "-hh:mm") into milliseconds since the Unix epoch. Fractional seconds
// beyond milliseconds are truncated. Anything else -> nullopt. The
// strictness is safe: this only ever sees an ALREADY AUTHENTICATED
// timestamp, and the server exclusively signs toISOString output, so
// no legitimate delivery is rejected; forms without an explicit offset
// are refused rather than guessed at.
[[nodiscard]] std::optional<std::int64_t> parse_iso8601_ms(std::string_view text) {
  std::size_t pos = 0;
  std::int64_t year = 0;
  std::int64_t month = 0;
  std::int64_t day = 0;
  std::int64_t hour = 0;
  std::int64_t minute = 0;
  std::int64_t second = 0;
  if (!read_digits(text, pos, 4, year)) return std::nullopt;
  if (pos >= text.size() || text[pos] != '-') return std::nullopt;
  ++pos;
  if (!read_digits(text, pos, 2, month)) return std::nullopt;
  if (pos >= text.size() || text[pos] != '-') return std::nullopt;
  ++pos;
  if (!read_digits(text, pos, 2, day)) return std::nullopt;
  if (pos >= text.size() || (text[pos] != 'T' && text[pos] != 't')) return std::nullopt;
  ++pos;
  if (!read_digits(text, pos, 2, hour)) return std::nullopt;
  if (pos >= text.size() || text[pos] != ':') return std::nullopt;
  ++pos;
  if (!read_digits(text, pos, 2, minute)) return std::nullopt;
  if (pos >= text.size() || text[pos] != ':') return std::nullopt;
  ++pos;
  if (!read_digits(text, pos, 2, second)) return std::nullopt;

  std::int64_t milliseconds = 0;
  if (pos < text.size() && text[pos] == '.') {
    ++pos;
    int digits = 0;
    while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') {
      if (digits < 3) {
        milliseconds = milliseconds * 10 + (text[pos] - '0');
      }
      ++digits;
      ++pos;
    }
    if (digits == 0 || digits > 9) return std::nullopt;
    // Fewer than three digits scale up ("*.5" is 500 ms).
    for (int i = digits; i < 3; ++i) milliseconds *= 10;
  }

  std::int64_t offset_minutes = 0;
  if (pos < text.size() && (text[pos] == 'Z' || text[pos] == 'z')) {
    ++pos;
  } else if (pos < text.size() && (text[pos] == '+' || text[pos] == '-')) {
    const bool negative = text[pos] == '-';
    ++pos;
    std::int64_t offset_hours = 0;
    std::int64_t offset_mins = 0;
    if (!read_digits(text, pos, 2, offset_hours)) return std::nullopt;
    if (pos >= text.size() || text[pos] != ':') return std::nullopt;
    ++pos;
    if (!read_digits(text, pos, 2, offset_mins)) return std::nullopt;
    if (offset_hours > 23 || offset_mins > 59) return std::nullopt;
    offset_minutes = offset_hours * 60 + offset_mins;
    if (negative) offset_minutes = -offset_minutes;
  } else {
    // No offset: refuse rather than guess a zone.
    return std::nullopt;
  }
  if (pos != text.size()) return std::nullopt;

  if (month < 1 || month > 12) return std::nullopt;
  if (day < 1 || day > days_in_month(year, month)) return std::nullopt;
  if (hour > 23 || minute > 59 || second > 59) return std::nullopt;

  const std::int64_t days = days_from_civil(year, month, day);
  const std::int64_t utc_seconds =
      days * 86400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
  return utc_seconds * 1000 + milliseconds;
}

}  // namespace

std::string sign_webhook_body(std::string_view secret, std::string_view body,
                              std::string_view timestamp) {
  std::string message;
  message.reserve(timestamp.size() + 1 + body.size());
  message.append(timestamp);
  message.push_back('.');
  message.append(body);
  const std::array<std::uint8_t, 32> mac = detail::hmac_sha256(secret, message);
  std::string signature(kWebhookSignatureScheme);
  signature.push_back('=');
  signature += detail::to_hex(mac.data(), mac.size());
  return signature;
}

Result<VerifiedWebhook> verify_webhook(std::string_view raw_body, const WebhookHeaders& headers,
                                       std::string_view secret,
                                       const VerifyWebhookOptions& options) {
  const std::string* signature = pick_header(headers, kWebhookSignatureHeader);
  if (signature == nullptr) {
    return webhook_error(ErrorCode::WebhookSignatureMissing,
                         "missing x-junjo-signature header");
  }
  const std::string* timestamp = pick_header(headers, kWebhookTimestampHeader);
  if (timestamp == nullptr) {
    return webhook_error(ErrorCode::WebhookTimestampMissing,
                         "missing x-junjo-timestamp header");
  }

  // The MAC is checked before the timestamp is even parsed: the
  // signature covers "<timestamp>.<body>" as raw strings, so this
  // needs no parsing, and it means unauthenticated senders get the
  // same WebhookInvalidSignature for every probe instead of an oracle
  // on the receiver's clock and tolerance settings (parity with the TS
  // SDK).
  const std::string expected = sign_webhook_body(secret, raw_body, *timestamp);
  if (!detail::constant_time_equal(*signature, expected)) {
    return webhook_error(ErrorCode::WebhookInvalidSignature,
                         "webhook signature does not match");
  }

  const std::optional<std::int64_t> timestamp_ms = parse_iso8601_ms(*timestamp);
  if (!timestamp_ms.has_value()) {
    return webhook_error(ErrorCode::WebhookTimestampInvalid,
                         "x-junjo-timestamp is not a valid timestamp");
  }

  const std::chrono::system_clock::time_point now =
      options.now ? options.now() : std::chrono::system_clock::now();
  const std::int64_t now_ms =
      std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
  const std::int64_t skew_ms =
      now_ms >= *timestamp_ms ? now_ms - *timestamp_ms : *timestamp_ms - now_ms;
  if (skew_ms > options.tolerance.count()) {
    return webhook_error(ErrorCode::WebhookTimestampOutOfTolerance,
                         "signature timestamp is outside the tolerance window");
  }

  const std::optional<Json> parsed = detail::parse_json(raw_body);
  if (!parsed.has_value() || !parsed->is_object()) {
    return webhook_error(ErrorCode::WebhookInvalidBody, "webhook body is not a JSON object");
  }
  const auto type = parsed->find("type");
  if (type == parsed->end() || !type->is_string()) {
    return webhook_error(ErrorCode::WebhookInvalidBody,
                         "webhook body is missing string field type");
  }

  VerifiedWebhook verified;
  verified.event_type = type->get<std::string>();
  if (const std::string* event_id = pick_header(headers, kWebhookEventIdHeader)) {
    verified.event_id = *event_id;
  }
  if (const std::string* delivery_id = pick_header(headers, kWebhookDeliveryIdHeader)) {
    verified.delivery_id = *delivery_id;
  }
  verified.payload_json = std::string(raw_body);
  return verified;
}

}  // namespace junjo
