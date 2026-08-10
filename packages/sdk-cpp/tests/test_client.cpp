// Junjo.io SDK for C++: Client construction, request plumbing, and
// the first domain slice (key_info, groups.get) against MockTransport.
#include <doctest/doctest.h>

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <utility>

#include <junjo/cancellation.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/groups.hpp>
#include <junjo/result.hpp>

#include "mock_transport.hpp"

using junjo::CancellationSource;
using junjo::Client;
using junjo::ClientConfig;
using junjo::Error;
using junjo::ErrorCode;
using junjo::GetGroupOptions;
using junjo::Group;
using junjo::KeyInfo;
using junjo::Result;
using junjo::test::MockTransport;

namespace {

constexpr const char* kKey = "jk_test.secret";

struct Harness {
  std::shared_ptr<MockTransport> transport = std::make_shared<MockTransport>();
  Client client;

  explicit Harness(ClientConfig config = {}) : client(make_client(std::move(config), transport)) {}

 private:
  static Client make_client(ClientConfig config, std::shared_ptr<MockTransport> transport) {
    if (config.api_key.empty()) config.api_key = kKey;
    config.transport = std::move(transport);
    Result<Client> created = Client::create(std::move(config));
    REQUIRE(created.has_value());
    return std::move(created).value();
  }
};

constexpr const char* kGroupJson = R"({
  "id": "grp_1",
  "gameId": "game_1",
  "kind": "guild",
  "name": "Night Watch",
  "visibility": "public",
  "metadata": {"motto": "and now it begins"},
  "defaultRoleId": null,
  "parentGroupId": "grp_parent",
  "memberCount": 12,
  "hasPasscode": true,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-02-01T00:00:00.000Z",
  "softDeletedAt": null
})";

}  // namespace

// ---------------------------------------------------------------------
// Construction / key shape validation
// ---------------------------------------------------------------------

TEST_CASE("create rejects an admin token (jadm_*) with InvalidConfig") {
  const Result<Client> created = Client::create(ClientConfig{
      .api_key = "jadm_d6f863cd5cf220b06773b57ecb5ea75a118bff3f92f581bbce515a70cb14b62a",
      .transport = std::make_shared<MockTransport>()});
  REQUIRE_FALSE(created.has_value());
  CHECK(created.error().code == ErrorCode::InvalidConfig);
}

TEST_CASE("create rejects an empty api_key with InvalidConfig") {
  const Result<Client> created =
      Client::create(ClientConfig{.transport = std::make_shared<MockTransport>()});
  REQUIRE_FALSE(created.has_value());
  CHECK(created.error().code == ErrorCode::InvalidConfig);
}

TEST_CASE("create rejects an empty base_url with InvalidConfig") {
  const Result<Client> created = Client::create(ClientConfig{
      .api_key = kKey, .base_url = "///", .transport = std::make_shared<MockTransport>()});
  REQUIRE_FALSE(created.has_value());
  CHECK(created.error().code == ErrorCode::InvalidConfig);
}

TEST_CASE("create accepts a proper jk_ key and, silently, unfamiliar shapes") {
  CHECK(Client::create(ClientConfig{
                           .api_key = "jk_kzPNEgg-rEY5nGHF.vYJ-girvGuJfwkO4vM4jwT7stXHFxsbhRrpIYqfsWJY",
                           .transport = std::make_shared<MockTransport>()})
            .has_value());
  // Not jk_-shaped: accepted without complaint, the server judges it.
  CHECK(Client::create(ClientConfig{.api_key = "totally-novel-key-format",
                                    .transport = std::make_shared<MockTransport>()})
            .has_value());
}

// ---------------------------------------------------------------------
// Request assembly
// ---------------------------------------------------------------------

TEST_CASE("key_info builds the whoami request with auth header and default timeout") {
  Harness h;
  h.transport->enqueue_json(200, R"({"gameId":"game_42"})");

  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE(info.has_value());
  CHECK(info.value().game_id == "game_42");

  REQUIRE(h.transport->request_count() == 1);
  const auto& request = h.transport->last_request();
  CHECK(request.method == "GET");
  CHECK(request.url == "https://api.junjo.io/v1/whoami");
  REQUIRE(request.headers.size() == 1);
  CHECK(request.headers[0].first == "authorization");
  CHECK(request.headers[0].second == std::string("Bearer ") + kKey);
  CHECK_FALSE(request.body.has_value());
  REQUIRE(request.timeout.has_value());
  CHECK(*request.timeout == std::chrono::milliseconds(30000));
}

TEST_CASE("base_url trailing slashes are stripped before path concatenation") {
  Harness h(ClientConfig{.base_url = "https://api.example.test///"});
  h.transport->enqueue_json(200, R"({"gameId":"g"})");
  CHECK(h.client.key_info().has_value());
  CHECK(h.transport->last_request().url == "https://api.example.test/v1/whoami");
}

TEST_CASE("configured timeout propagates to the transport; non-positive disables it") {
  Harness slow(ClientConfig{.timeout = std::chrono::milliseconds(1234)});
  slow.transport->enqueue_json(200, R"({"gameId":"g"})");
  CHECK(slow.client.key_info().has_value());
  REQUIRE(slow.transport->last_request().timeout.has_value());
  CHECK(*slow.transport->last_request().timeout == std::chrono::milliseconds(1234));

  Harness untimed(ClientConfig{.timeout = std::chrono::milliseconds(0)});
  untimed.transport->enqueue_json(200, R"({"gameId":"g"})");
  CHECK(untimed.client.key_info().has_value());
  CHECK_FALSE(untimed.transport->last_request().timeout.has_value());
}

TEST_CASE("per-request timeout override wins over the client-level timeout") {
  Harness h(ClientConfig{.timeout = std::chrono::milliseconds(30000)});
  h.transport->enqueue_json(200, kGroupJson);

  const GetGroupOptions options{.timeout = std::chrono::milliseconds(250)};
  CHECK(h.client.groups().get("grp_1", options).has_value());
  REQUIRE(h.transport->last_request().timeout.has_value());
  CHECK(*h.transport->last_request().timeout == std::chrono::milliseconds(250));
}

// ---------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------

TEST_CASE("a token cancelled pre-flight fails without touching the transport") {
  Harness h;
  CancellationSource source;
  source.request_cancellation();

  const Result<KeyInfo> info = h.client.key_info(source.token());
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::Cancelled);
  CHECK(h.transport->request_count() == 0);
}

TEST_CASE("a token cancelled mid-flight surfaces as Cancelled from the transport") {
  Harness h;
  CancellationSource source;
  // The mock invokes this after recording the request but before
  // answering, simulating cancellation while the request is in flight.
  h.transport->on_execute = [&source](const junjo::HttpRequest&) {
    source.request_cancellation();
  };
  h.transport->enqueue_json(200, R"({"gameId":"g"})");

  const Result<KeyInfo> info = h.client.key_info(source.token());
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::Cancelled);
  CHECK(h.transport->request_count() == 1);
}

// ---------------------------------------------------------------------
// Response classification
// ---------------------------------------------------------------------

TEST_CASE("a full error envelope maps code, status, message, requestId, retryAfterSeconds") {
  Harness h;
  h.transport->enqueue_json(
      429,
      R"({"code":"rate_limit_exceeded","status":429,"message":"slow down","requestId":"req_9"})",
      {{"Retry-After", "17"}});

  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  const Error& err = info.error();
  CHECK(err.code == ErrorCode::RateLimitExceeded);
  CHECK(err.raw_code == "rate_limit_exceeded");
  CHECK(err.message == "slow down");
  REQUIRE(err.status.has_value());
  CHECK(*err.status == 429);
  REQUIRE(err.request_id.has_value());
  CHECK(*err.request_id == "req_9");
  REQUIRE(err.retry_after_seconds.has_value());
  CHECK(*err.retry_after_seconds == 17);
}

TEST_CASE("requestId falls back to the x-request-id header when absent from the body") {
  Harness h;
  h.transport->enqueue_json(500, R"({"code":"internal","status":500,"message":"boom"})",
                            {{"X-Request-Id", "req_hdr"}});
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  REQUIRE(info.error().request_id.has_value());
  CHECK(*info.error().request_id == "req_hdr");
}

TEST_CASE("a non-integer Retry-After is ignored") {
  Harness h;
  h.transport->enqueue_json(429, R"({"code":"rate_limit_exceeded","status":429,"message":"m"})",
                            {{"Retry-After", "Wed, 21 Oct 2026 07:28:00 GMT"}});
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  CHECK_FALSE(info.error().retry_after_seconds.has_value());
}

TEST_CASE("an unknown wire code maps to Unknown and preserves raw_code") {
  Harness h;
  h.transport->enqueue_json(
      418, R"({"code":"teapot_overheated","status":418,"message":"future server says no"})");
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::Unknown);
  CHECK(info.error().raw_code == "teapot_overheated");
  CHECK(info.error().message == "future server says no");
  REQUIRE(info.error().status.has_value());
  CHECK(*info.error().status == 418);
}

TEST_CASE("a non-envelope error body (HTML 502) maps to Unknown with the transport status") {
  Harness h;
  h.transport->enqueue_json(502, "<html><body>Bad Gateway</body></html>");
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::Unknown);
  CHECK(info.error().raw_code.empty());
  REQUIRE(info.error().status.has_value());
  CHECK(*info.error().status == 502);
  CHECK(info.error().message == "request failed with HTTP 502");
}

TEST_CASE("malformed 2xx JSON maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, "{not json");
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("a 2xx object missing required fields maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"gameId":12345})");
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("transport errors pass through untouched") {
  Harness h;
  h.transport->enqueue(Error{.code = ErrorCode::Timeout, .message = "request timed out"});
  const Result<KeyInfo> info = h.client.key_info();
  REQUIRE_FALSE(info.has_value());
  CHECK(info.error().code == ErrorCode::Timeout);
}

// ---------------------------------------------------------------------
// groups().get
// ---------------------------------------------------------------------

TEST_CASE("groups.get happy path deserializes the wire group") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  const Result<std::optional<Group>> got = h.client.groups().get("grp_1");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  const Group& group = *got.value();
  CHECK(group.id == "grp_1");
  CHECK(group.game_id == "game_1");
  CHECK(group.kind == "guild");
  CHECK(group.name == "Night Watch");
  CHECK(group.visibility == "public");
  CHECK(group.metadata_json.find("\"motto\"") != std::string::npos);
  CHECK_FALSE(group.default_role_id.has_value());
  REQUIRE(group.parent_group_id.has_value());
  CHECK(*group.parent_group_id == "grp_parent");
  CHECK(group.member_count == 12);
  CHECK(group.has_passcode);
  CHECK(group.created_at == "2026-01-01T00:00:00.000Z");
  CHECK(group.updated_at == "2026-02-01T00:00:00.000Z");
  CHECK_FALSE(group.soft_deleted_at.has_value());

  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1");
}

TEST_CASE("groups.get percent-encodes the id and the viewer query") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  const GetGroupOptions options{.viewer = std::string("user with spaces&stuff")};
  CHECK(h.client.groups().get("grp/../weird id", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp%2F..%2Fweird%20id"
        "?viewer=user%20with%20spaces%26stuff");
}

TEST_CASE("groups.get maps not_found to an empty optional, not an error") {
  Harness h;
  h.transport->enqueue_json(404, R"({"code":"not_found","status":404,"message":"no such group"})");
  const Result<std::optional<Group>> got = h.client.groups().get("grp_missing");
  REQUIRE(got.has_value());
  CHECK_FALSE(got.value().has_value());
}

TEST_CASE("groups.get surfaces non-404 envelope errors") {
  Harness h;
  h.transport->enqueue_json(
      403, R"({"code":"permission_denied","status":403,"message":"not yours"})");
  const Result<std::optional<Group>> got = h.client.groups().get("grp_1");
  REQUIRE_FALSE(got.has_value());
  CHECK(got.error().code == ErrorCode::PermissionDenied);
}

TEST_CASE("groups.get tolerates unknown fields and missing nullable fields") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "id": "grp_2",
    "gameId": "game_1",
    "kind": "clan",
    "name": "Tolerant",
    "visibility": "battle-royale-only",
    "metadata": {},
    "memberCount": 1,
    "hasPasscode": false,
    "createdAt": "2026-01-01T00:00:00.000Z",
    "updatedAt": "2026-01-01T00:00:00.000Z",
    "someFutureField": {"nested": [1, 2, 3]},
    "anotherNewThing": true
  })");

  const Result<std::optional<Group>> got = h.client.groups().get("grp_2");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  const Group& group = *got.value();
  CHECK(group.metadata_json == "{}");
  // A visibility value this SDK has never heard of passes through.
  CHECK(group.visibility == "battle-royale-only");
  CHECK_FALSE(group.default_role_id.has_value());
  CHECK_FALSE(group.parent_group_id.has_value());
  CHECK_FALSE(group.soft_deleted_at.has_value());
}

TEST_CASE("groups.get rejects a group missing required fields as InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"id":"grp_3","name":"incomplete"})");
  const Result<std::optional<Group>> got = h.client.groups().get("grp_3");
  REQUIRE_FALSE(got.has_value());
  CHECK(got.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("GroupsApi outlives the Client it came from") {
  auto transport = std::make_shared<MockTransport>();
  transport->enqueue_json(200, kGroupJson);

  std::optional<junjo::GroupsApi> groups;
  {
    Result<Client> created =
        Client::create(ClientConfig{.api_key = kKey, .transport = transport});
    REQUIRE(created.has_value());
    groups = created.value().groups();
  }  // Client destroyed here.
  CHECK(groups->get("grp_1").has_value());
}
