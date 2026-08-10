// Junjo.io SDK for C++
//
// Internal JSON facade. nlohmann/json is a PRIVATE dependency: it is
// compiled into the library and must never appear in a public header,
// so consumers are free to use any JSON library (or a different
// nlohmann version) without ODR or ABI friction. Every internal
// translation unit includes it through this header so the exception
// policy (parse errors as values, never thrown across the API
// boundary) is configured in exactly one place.
#pragma once

#include <optional>
#include <string_view>

#include <nlohmann/json.hpp>

namespace junjo::detail {

using Json = nlohmann::json;

// Parses `text`, returning nullopt instead of throwing on malformed
// input. Callers translate nullopt into the appropriate ErrorCode
// (InvalidWireData for 2xx bodies, Unknown for non-envelope error
// bodies).
[[nodiscard]] inline std::optional<Json> parse_json(std::string_view text) {
  Json parsed = Json::parse(text, /*cb=*/nullptr, /*allow_exceptions=*/false);
  if (parsed.is_discarded()) return std::nullopt;
  return parsed;
}

}  // namespace junjo::detail
