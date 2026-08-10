// Junjo.io SDK for C++

#include "junjo/transport.hpp"

#include <cctype>

#include "junjo/error.hpp"

namespace junjo {

namespace {

[[nodiscard]] bool ascii_iequals(std::string_view a, std::string_view b) noexcept {
  if (a.size() != b.size()) return false;
  for (std::size_t i = 0; i < a.size(); ++i) {
    const auto lower = [](unsigned char c) noexcept {
      return static_cast<unsigned char>(std::tolower(c));
    };
    if (lower(static_cast<unsigned char>(a[i])) != lower(static_cast<unsigned char>(b[i]))) {
      return false;
    }
  }
  return true;
}

}  // namespace

std::optional<std::string_view> HttpResponse::header(std::string_view name) const noexcept {
  for (const auto& [key, value] : headers) {
    if (ascii_iequals(key, name)) return std::string_view(value);
  }
  return std::nullopt;
}

// Out-of-line so the vtable and key function live in exactly one
// translation unit.
Transport::~Transport() = default;

StreamHandler::~StreamHandler() = default;

bool StreamHandler::on_open(const HttpResponse&) { return true; }

Result<void> Transport::execute_stream(const HttpRequest&, StreamHandler& handler,
                                       const CancellationToken&) {
  // Deliberately not pure virtual: Transport implementations written
  // before streaming existed must stay source-compatible. InvalidConfig
  // (not NetworkError) because nothing was attempted on the wire; the
  // configuration lacks a capability.
  Result<void> result = Error{
      .code = ErrorCode::InvalidConfig,
      .message = "this transport does not support streaming (execute_stream not overridden); "
                 "SSE subscriptions need a streaming-capable transport"};
  handler.on_complete(result);
  return result;
}

}  // namespace junjo
