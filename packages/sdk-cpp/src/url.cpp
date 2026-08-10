// Junjo.io SDK for C++

#include "url.hpp"

namespace junjo::detail {

namespace {

[[nodiscard]] constexpr bool is_unreserved(unsigned char c) noexcept {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' ||
         c == '.' || c == '_' || c == '~';
}

constexpr char kHex[] = "0123456789ABCDEF";

}  // namespace

std::string percent_encode(std::string_view input) {
  std::string out;
  out.reserve(input.size());
  for (const char ch : input) {
    const auto byte = static_cast<unsigned char>(ch);
    if (is_unreserved(byte)) {
      out.push_back(ch);
    } else {
      out.push_back('%');
      out.push_back(kHex[byte >> 4]);
      out.push_back(kHex[byte & 0x0F]);
    }
  }
  return out;
}

std::string build_query(
    const std::vector<std::pair<std::string_view, std::string_view>>& params) {
  if (params.empty()) return {};
  std::string out;
  out.push_back('?');
  bool first = true;
  for (const auto& [key, value] : params) {
    if (!first) out.push_back('&');
    first = false;
    out += percent_encode(key);
    out.push_back('=');
    out += percent_encode(value);
  }
  return out;
}

}  // namespace junjo::detail
