// Junjo.io SDK for C++: percent-encoding and query building.
#include <doctest/doctest.h>

#include <string>

#include "url.hpp"

using junjo::detail::build_query;
using junjo::detail::percent_encode;

TEST_CASE("percent_encode passes RFC 3986 unreserved characters through") {
  CHECK(percent_encode("abcXYZ019-._~") == "abcXYZ019-._~");
  CHECK(percent_encode("") == "");
}

TEST_CASE("percent_encode escapes reserved and special characters") {
  CHECK(percent_encode("a/b") == "a%2Fb");
  CHECK(percent_encode("a b+c") == "a%20b%2Bc");
  CHECK(percent_encode("id?x=1&y=2") == "id%3Fx%3D1%26y%3D2");
  CHECK(percent_encode("100%") == "100%25");
  CHECK(percent_encode("#frag") == "%23frag");
}

TEST_CASE("percent_encode encodes UTF-8 byte-by-byte with uppercase hex") {
  // U+00E9 LATIN SMALL LETTER E WITH ACUTE = 0xC3 0xA9 in UTF-8.
  CHECK(percent_encode("caf\xC3\xA9") == "caf%C3%A9");
  // High bytes must not sign-extend into garbage indices.
  CHECK(percent_encode("\xFF") == "%FF");
}

TEST_CASE("build_query renders and encodes pairs") {
  CHECK(build_query({}) == "");
  CHECK(build_query({{"viewer", "user_1"}}) == "?viewer=user_1");
  CHECK(build_query({{"viewer", "a b&c"}, {"limit", "10"}}) == "?viewer=a%20b%26c&limit=10");
}
