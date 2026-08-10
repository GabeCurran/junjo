// Junjo.io SDK for C++
//
// Internal clean-room SHA-256 (FIPS 180-4) and HMAC-SHA256 (RFC 2104),
// used only by webhook signature verification. Deliberately no OpenSSL
// or platform-crypto dependency: the input is a single short message
// per delivery, so a straightforward portable implementation is
// plenty, and it keeps the library's dependency story unchanged.
// Validated against the FIPS / RFC 4231 test vectors in the test
// suite. Not installed.
#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>

namespace junjo::detail {

// SHA-256 digest of `data`.
[[nodiscard]] std::array<std::uint8_t, 32> sha256(const std::uint8_t* data, std::size_t size);

// HMAC-SHA256 of `message` under `key` (RFC 2104: keys longer than the
// 64-byte block are hashed first; shorter keys are zero-padded).
[[nodiscard]] std::array<std::uint8_t, 32> hmac_sha256(std::string_view key,
                                                       std::string_view message);

// Lowercase hex encoding.
[[nodiscard]] std::string to_hex(const std::uint8_t* bytes, std::size_t size);

// Equal-length string comparison without short-circuiting on the first
// differing byte, so a signature comparison's timing does not leak how
// much of a guess was right. A length mismatch returns false
// immediately; the length of the expected MAC is not a secret.
[[nodiscard]] bool constant_time_equal(std::string_view a, std::string_view b) noexcept;

}  // namespace junjo::detail
