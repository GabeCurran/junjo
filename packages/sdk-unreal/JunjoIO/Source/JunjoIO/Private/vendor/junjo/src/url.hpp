// Junjo.io SDK for C++
//
// Internal URL utilities. Not installed; tests include this header
// directly from the source tree.
#pragma once

#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace junjo::detail {

// Percent-encodes `input` for use as a URL path segment or query
// value, RFC 3986 strict: unreserved characters (ALPHA / DIGIT /
// "-" / "." / "_" / "~") pass through, every other byte becomes %XX
// with uppercase hex. Encodes UTF-8 input byte-by-byte, which is
// exactly what the server expects.
[[nodiscard]] std::string percent_encode(std::string_view input);

// Builds "?k=v&k2=v2" (keys and values percent-encoded) from `params`,
// or an empty string when `params` is empty. Keys are expected to be
// literal ASCII; they are encoded anyway for safety.
[[nodiscard]] std::string build_query(
    const std::vector<std::pair<std::string_view, std::string_view>>& params);

}  // namespace junjo::detail
