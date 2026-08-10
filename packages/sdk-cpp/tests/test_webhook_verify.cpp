// Junjo.io SDK for C++: webhook signature verification: the
// clean-room SHA-256 / HMAC-SHA256 against published FIPS 180-4 and
// RFC 4231 vectors, cross-SDK parity vectors (computed with node's
// crypto over the SAME secret / timestamp / body material the TS
// suite signs, so both SDKs are proven against identical bytes), and
// the verify_webhook behavioral contract: MAC before timestamp,
// constant-time compare, tolerance edges, malformed bodies.
#include <doctest/doctest.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <string>

#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/webhooks.hpp>

#include "hmac_sha256.hpp"

using junjo::ErrorCode;
using junjo::Result;
using junjo::sign_webhook_body;
using junjo::VerifiedWebhook;
using junjo::verify_webhook;
using junjo::VerifyWebhookOptions;
using junjo::WebhookHeaders;

namespace {

[[nodiscard]] std::string sha256_hex(const std::string& input) {
  const std::array<std::uint8_t, 32> digest = junjo::detail::sha256(
      reinterpret_cast<const std::uint8_t*>(input.data()), input.size());
  return junjo::detail::to_hex(digest.data(), digest.size());
}

[[nodiscard]] std::string hmac_hex(const std::string& key, const std::string& message) {
  const std::array<std::uint8_t, 32> mac = junjo::detail::hmac_sha256(key, message);
  return junjo::detail::to_hex(mac.data(), mac.size());
}

// The TS suite's material (packages/sdk/src/webhooks.test.ts): the
// same secret, timestamp, and JSON.stringify(sampleEvent) bytes.
constexpr const char* kSecret = "topsecret-1234";
constexpr const char* kTimestamp = "2026-04-28T05:00:30.000Z";
constexpr const char* kSampleBody =
    R"({"id":"evt_1","type":"group.updated","gameId":"game_1","groupId":"grp_1",)"
    R"("occurredAt":"2026-04-28T05:00:00.000Z","group":{"id":"grp_1","gameId":"game_1",)"
    R"("kind":"guild","name":"Crimson Wolves","visibility":"invite-only","metadata":{},)"
    R"("defaultRoleId":null,"parentGroupId":null,"memberCount":0,"hasPasscode":false,)"
    R"("createdAt":"2026-04-28T05:00:00.000Z","updatedAt":"2026-04-28T05:01:00.000Z",)"
    R"("softDeletedAt":null}})";
// node: createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")
constexpr const char* kSampleSignature =
    "v1=6de4816d80a87cc0952c2ec88ade4b3c314d8aac7000f960027405e0763d9470";

// 2026-04-28T05:00:30.000Z as Unix milliseconds; the frozen "now"
// matching the TS suite's FROZEN_NOW.
constexpr std::int64_t kFrozenNowMs = 1777352430000;

[[nodiscard]] VerifyWebhookOptions frozen_clock(std::int64_t unix_ms = kFrozenNowMs) {
  VerifyWebhookOptions options;
  options.now = [unix_ms] {
    return std::chrono::system_clock::time_point(std::chrono::milliseconds(unix_ms));
  };
  return options;
}

[[nodiscard]] WebhookHeaders signed_headers(const std::string& body,
                                            const std::string& secret = kSecret,
                                            const std::string& timestamp = kTimestamp) {
  return {
      {"x-junjo-signature", sign_webhook_body(secret, body, timestamp)},
      {"x-junjo-timestamp", timestamp},
      {"x-junjo-event", "group.updated"},
      {"x-junjo-event-id", "evt_1"},
      {"x-junjo-delivery-id", "del_1"},
  };
}

}  // namespace

// ---------------------------------------------------------------------
// SHA-256 (FIPS 180-4 examples)
// ---------------------------------------------------------------------

TEST_CASE("sha256 matches the published FIPS vectors") {
  CHECK(sha256_hex("") ==
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  CHECK(sha256_hex("abc") ==
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  // Two-block message.
  CHECK(sha256_hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq") ==
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  // One million 'a': exercises the multi-block streaming path.
  CHECK(sha256_hex(std::string(1000000, 'a')) ==
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  // 55 and 56 input bytes straddle the padding boundary (56 forces an
  // extra all-padding block). Expected values computed with node's
  // crypto.createHash("sha256").
  CHECK(sha256_hex(std::string(55, 'x')) ==
        "d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072");
  CHECK(sha256_hex(std::string(56, 'a')) ==
        "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
}

// ---------------------------------------------------------------------
// HMAC-SHA256 (RFC 4231)
// ---------------------------------------------------------------------

TEST_CASE("hmac_sha256 matches the RFC 4231 test cases") {
  // Case 1: 20-byte 0x0b key.
  CHECK(hmac_hex(std::string(20, '\x0b'), "Hi There") ==
        "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
  // Case 2: short ASCII key.
  CHECK(hmac_hex("Jefe", "what do ya want for nothing?") ==
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  // Case 3: 20-byte 0xaa key, 50-byte 0xdd data.
  CHECK(hmac_hex(std::string(20, '\xaa'), std::string(50, '\xdd')) ==
        "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe");
  // Case 4: 25-byte incrementing key, 50-byte 0xcd data.
  std::string counting_key;
  for (int i = 1; i <= 25; ++i) counting_key.push_back(static_cast<char>(i));
  CHECK(hmac_hex(counting_key, std::string(50, '\xcd')) ==
        "82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b");
  // Case 6: 131-byte key (larger than the block; hashed first).
  CHECK(hmac_hex(std::string(131, '\xaa'),
                 "Test Using Larger Than Block-Size Key - Hash Key First") ==
        "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54");
  // Case 7: 131-byte key AND >block data.
  CHECK(hmac_hex(std::string(131, '\xaa'),
                 "This is a test using a larger than block-size key and a larger than "
                 "block-size data. The key needs to be hashed before being used by the HMAC "
                 "algorithm.") ==
        "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2");
}

// ---------------------------------------------------------------------
// Cross-SDK signing parity
// ---------------------------------------------------------------------

TEST_CASE("sign_webhook_body reproduces the server/TS signature for identical material") {
  // Every expected value computed with node:
  //   createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")
  // which is exactly what the server's signWebhookBody does and what
  // the TS SDK verifies against.
  CHECK(sign_webhook_body(kSecret, kSampleBody, kTimestamp) == kSampleSignature);
  CHECK(sign_webhook_body("secret", "hello", "2026-04-28T05:00:00.000Z") ==
        "v1=f37bf9a5f013824d44d2108cbe7493d7c31357955cf35c1b76528b1646201576");
  CHECK(sign_webhook_body("k", "x", "ts") ==
        "v1=6e73cc4fbdb70c8833c08cdad51045954a67cf025d0e626cd04d07f8e68da3a3");
}

TEST_CASE("sign_webhook_body varies with each input and stays deterministic") {
  const std::string base = sign_webhook_body("k", "x", "ts");
  CHECK(base.rfind("v1=", 0) == 0);
  CHECK(base.size() == 3 + 64);
  CHECK(sign_webhook_body("k", "x", "ts") == base);
  CHECK(sign_webhook_body("other", "x", "ts") != base);
  CHECK(sign_webhook_body("k", "y", "ts") != base);
  CHECK(sign_webhook_body("k", "x", "ts2") != base);
}

// ---------------------------------------------------------------------
// verify_webhook: accept paths
// ---------------------------------------------------------------------

TEST_CASE("verify_webhook accepts a valid delivery and surfaces type, ids, and payload") {
  const Result<VerifiedWebhook> verified =
      verify_webhook(kSampleBody, signed_headers(kSampleBody), kSecret, frozen_clock());
  REQUIRE(verified.has_value());
  CHECK(verified.value().event_type == "group.updated");
  REQUIRE(verified.value().event_id.has_value());
  CHECK(*verified.value().event_id == "evt_1");
  REQUIRE(verified.value().delivery_id.has_value());
  CHECK(*verified.value().delivery_id == "del_1");
  CHECK(verified.value().payload_json == kSampleBody);
}

TEST_CASE("verify_webhook matches header names case-insensitively") {
  WebhookHeaders headers = {
      {"X-Junjo-Signature", sign_webhook_body(kSecret, kSampleBody, kTimestamp)},
      {"X-JUNJO-TIMESTAMP", kTimestamp},
  };
  const Result<VerifiedWebhook> verified =
      verify_webhook(kSampleBody, headers, kSecret, frozen_clock());
  REQUIRE(verified.has_value());
  CHECK(verified.value().event_type == "group.updated");
  // The id headers were stripped by an intermediary: absent, not empty.
  CHECK_FALSE(verified.value().event_id.has_value());
  CHECK_FALSE(verified.value().delivery_id.has_value());
}

TEST_CASE("verify_webhook returns event types this SDK predates verbatim") {
  // Unlike the TS SDK (which must reject unknown types to build its
  // typed event union), the C++ surface hands back the raw type +
  // payload, so future event types still verify.
  const std::string body = R"({"id":"evt_future","type":"member.promoted","gameId":"game_1"})";
  const Result<VerifiedWebhook> verified =
      verify_webhook(body, signed_headers(body), kSecret, frozen_clock());
  REQUIRE(verified.has_value());
  CHECK(verified.value().event_type == "member.promoted");
}

// ---------------------------------------------------------------------
// verify_webhook: reject paths
// ---------------------------------------------------------------------

TEST_CASE("verify_webhook fails WebhookSignatureMissing / WebhookTimestampMissing") {
  WebhookHeaders no_signature = {{"x-junjo-timestamp", kTimestamp}};
  const Result<VerifiedWebhook> missing_sig =
      verify_webhook(kSampleBody, no_signature, kSecret, frozen_clock());
  REQUIRE_FALSE(missing_sig.has_value());
  CHECK(missing_sig.error().code == ErrorCode::WebhookSignatureMissing);

  WebhookHeaders no_timestamp = {
      {"x-junjo-signature", sign_webhook_body(kSecret, kSampleBody, kTimestamp)}};
  const Result<VerifiedWebhook> missing_ts =
      verify_webhook(kSampleBody, no_timestamp, kSecret, frozen_clock());
  REQUIRE_FALSE(missing_ts.has_value());
  CHECK(missing_ts.error().code == ErrorCode::WebhookTimestampMissing);
}

TEST_CASE("verify_webhook rejects a tampered body, wrong secret, and malformed signature") {
  const WebhookHeaders headers = signed_headers(kSampleBody);

  const Result<VerifiedWebhook> tampered =
      verify_webhook(R"({"tampered":true})", headers, kSecret, frozen_clock());
  REQUIRE_FALSE(tampered.has_value());
  CHECK(tampered.error().code == ErrorCode::WebhookInvalidSignature);

  const Result<VerifiedWebhook> wrong_secret =
      verify_webhook(kSampleBody, headers, "wrong-secret", frozen_clock());
  REQUIRE_FALSE(wrong_secret.has_value());
  CHECK(wrong_secret.error().code == ErrorCode::WebhookInvalidSignature);

  WebhookHeaders garbage = headers;
  garbage[0].second = "v1=garbage";
  const Result<VerifiedWebhook> malformed =
      verify_webhook(kSampleBody, garbage, kSecret, frozen_clock());
  REQUIRE_FALSE(malformed.has_value());
  CHECK(malformed.error().code == ErrorCode::WebhookInvalidSignature);
}

TEST_CASE("verify_webhook rejects a wrong scheme prefix carrying a correct MAC") {
  WebhookHeaders headers = signed_headers(kSampleBody);
  headers[0].second.replace(0, 2, "v2");
  const Result<VerifiedWebhook> verified =
      verify_webhook(kSampleBody, headers, kSecret, frozen_clock());
  REQUIRE_FALSE(verified.has_value());
  CHECK(verified.error().code == ErrorCode::WebhookInvalidSignature);
}

TEST_CASE("MAC is verified before the timestamp: tampered timestamps read as bad signatures") {
  // An unsigned timestamp swap must NOT reach the timestamp parser;
  // unauthenticated senders learn nothing about the receiver's clock
  // or tolerance (oracle-avoidance parity with the TS SDK).
  WebhookHeaders headers = signed_headers(kSampleBody);
  headers[1].second = "not-a-date";
  const Result<VerifiedWebhook> tampered =
      verify_webhook(kSampleBody, headers, kSecret, frozen_clock());
  REQUIRE_FALSE(tampered.has_value());
  CHECK(tampered.error().code == ErrorCode::WebhookInvalidSignature);

  // Both the signature and the freshness are wrong: the signature
  // failure wins.
  WebhookHeaders bad_both = signed_headers(kSampleBody);
  bad_both[0].second = "v1=deadbeef";
  const Result<VerifiedWebhook> stale_and_bad = verify_webhook(
      kSampleBody, bad_both, kSecret, frozen_clock(kFrozenNowMs + 6 * 60 * 1000));
  REQUIRE_FALSE(stale_and_bad.has_value());
  CHECK(stale_and_bad.error().code == ErrorCode::WebhookInvalidSignature);
}

TEST_CASE("verify_webhook rejects a correctly signed unparseable timestamp") {
  // Reaching WebhookTimestampInvalid requires signing over the bad
  // value, mirroring the TS suite.
  const Result<VerifiedWebhook> verified = verify_webhook(
      kSampleBody, signed_headers(kSampleBody, kSecret, "not-a-date"), kSecret, frozen_clock());
  REQUIRE_FALSE(verified.has_value());
  CHECK(verified.error().code == ErrorCode::WebhookTimestampInvalid);
}

TEST_CASE("verify_webhook rejects signed timestamps without an explicit UTC offset") {
  for (const char* timestamp : {"2026-04-28T05:00:30.000", "2026-04-28", "1777352430000"}) {
    const Result<VerifiedWebhook> verified = verify_webhook(
        kSampleBody, signed_headers(kSampleBody, kSecret, timestamp), kSecret, frozen_clock());
    REQUIRE_FALSE(verified.has_value());
    CHECK(verified.error().code == ErrorCode::WebhookTimestampInvalid);
  }
}

TEST_CASE("verify_webhook accepts a numeric-offset timestamp") {
  // 07:00:30+02:00 is the same instant as the frozen 05:00:30Z clock.
  const char* timestamp = "2026-04-28T07:00:30.000+02:00";
  const Result<VerifiedWebhook> verified = verify_webhook(
      kSampleBody, signed_headers(kSampleBody, kSecret, timestamp), kSecret, frozen_clock());
  REQUIRE(verified.has_value());
}

TEST_CASE("verify_webhook enforces the tolerance window in both directions, edges exact") {
  const WebhookHeaders headers = signed_headers(kSampleBody);
  constexpr std::int64_t kFiveMinutes = 5 * 60 * 1000;

  // Skew == tolerance passes (the TS check is strictly greater-than).
  CHECK(verify_webhook(kSampleBody, headers, kSecret, frozen_clock(kFrozenNowMs + kFiveMinutes))
            .has_value());
  CHECK(verify_webhook(kSampleBody, headers, kSecret, frozen_clock(kFrozenNowMs - kFiveMinutes))
            .has_value());

  // One millisecond beyond fails, replay (stale) and future-dated alike.
  const Result<VerifiedWebhook> stale = verify_webhook(
      kSampleBody, headers, kSecret, frozen_clock(kFrozenNowMs + kFiveMinutes + 1));
  REQUIRE_FALSE(stale.has_value());
  CHECK(stale.error().code == ErrorCode::WebhookTimestampOutOfTolerance);

  const Result<VerifiedWebhook> future = verify_webhook(
      kSampleBody, headers, kSecret, frozen_clock(kFrozenNowMs - kFiveMinutes - 1));
  REQUIRE_FALSE(future.has_value());
  CHECK(future.error().code == ErrorCode::WebhookTimestampOutOfTolerance);
}

TEST_CASE("verify_webhook respects a custom tolerance") {
  const WebhookHeaders headers = signed_headers(kSampleBody);
  VerifyWebhookOptions options = frozen_clock(kFrozenNowMs + 8 * 60 * 1000);
  options.tolerance = std::chrono::milliseconds(10 * 60 * 1000);
  CHECK(verify_webhook(kSampleBody, headers, kSecret, options).has_value());

  options.tolerance = std::chrono::milliseconds(60 * 1000);
  const Result<VerifiedWebhook> tight =
      verify_webhook(kSampleBody, headers, kSecret, options);
  REQUIRE_FALSE(tight.has_value());
  CHECK(tight.error().code == ErrorCode::WebhookTimestampOutOfTolerance);
}

TEST_CASE("verify_webhook rejects signed non-JSON and type-less bodies as WebhookInvalidBody") {
  const std::string garbage = "not json at all";
  const Result<VerifiedWebhook> not_json =
      verify_webhook(garbage, signed_headers(garbage), kSecret, frozen_clock());
  REQUIRE_FALSE(not_json.has_value());
  CHECK(not_json.error().code == ErrorCode::WebhookInvalidBody);

  const std::string no_type = R"({"id":"evt_1"})";
  const Result<VerifiedWebhook> missing_type =
      verify_webhook(no_type, signed_headers(no_type), kSecret, frozen_clock());
  REQUIRE_FALSE(missing_type.has_value());
  CHECK(missing_type.error().code == ErrorCode::WebhookInvalidBody);

  const std::string array_body = R"([1,2,3])";
  const Result<VerifiedWebhook> not_object =
      verify_webhook(array_body, signed_headers(array_body), kSecret, frozen_clock());
  REQUIRE_FALSE(not_object.has_value());
  CHECK(not_object.error().code == ErrorCode::WebhookInvalidBody);
}

// ---------------------------------------------------------------------
// constant_time_equal sanity
// ---------------------------------------------------------------------

TEST_CASE("constant_time_equal compares whole strings and rejects length mismatches") {
  using junjo::detail::constant_time_equal;
  CHECK(constant_time_equal("", ""));
  CHECK(constant_time_equal("v1=abc", "v1=abc"));
  CHECK_FALSE(constant_time_equal("v1=abc", "v1=abd"));
  // Differences at the FIRST byte and the LAST byte are both caught
  // (the accumulator never short-circuits).
  CHECK_FALSE(constant_time_equal("x1=abc", "v1=abc"));
  CHECK_FALSE(constant_time_equal("v1=abx", "v1=abc"));
  CHECK_FALSE(constant_time_equal("v1=abc", "v1=ab"));
  CHECK_FALSE(constant_time_equal("", "a"));
}
