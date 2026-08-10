// Junjo.io SDK for C++: BansApi domain surface against MockTransport:
// game-wide ban add/remove wire bodies, null-on-404 get (including the
// lazy-expiry contract), list flags, and the per-user history filters.
#include <doctest/doctest.h>

#include <optional>
#include <string>

#include <junjo/bans.hpp>
#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "json.hpp"
#include "test_support.hpp"

using junjo::AddBanOptions;
using junjo::Ban;
using junjo::BanHistoryEntry;
using junjo::ErrorCode;
using junjo::ListBanHistoryOptions;
using junjo::ListBansOptions;
using junjo::Page;
using junjo::RemoveBanOptions;
using junjo::Result;
using junjo::detail::Json;
using junjo::test::body_of;
using junjo::test::Harness;
using junjo::test::kBanJson;
using junjo::test::kNotFoundJson;

TEST_CASE("bans.add POSTs /v1/bans with only the userId when no options are set") {
  Harness h;
  h.transport->enqueue_json(201, kBanJson);
  const Result<Ban> ban = h.client.bans().add("user_1");
  REQUIRE(ban.has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/bans");
  const Json body = body_of(h.transport->last_request());
  CHECK(body == Json::parse(R"({"userId":"user_1"})"));

  CHECK(ban.value().id == "ban_1");
  CHECK(ban.value().game_id == "game_1");
  CHECK(ban.value().user_id == "user_1");
  CHECK(ban.value().banned_at == "2026-06-01T00:00:00.000Z");
  REQUIRE(ban.value().expires_at.has_value());
  CHECK(*ban.value().expires_at == "2026-07-01T00:00:00.000Z");
  REQUIRE(ban.value().reason.has_value());
  CHECK(*ban.value().reason == "griefing");
  REQUIRE(ban.value().banned_by.has_value());
  CHECK(*ban.value().banned_by == "user_mod");
}

TEST_CASE("bans.add forwards reason, expiresAt, and actorUserId") {
  Harness h;
  h.transport->enqueue_json(201, kBanJson);
  const AddBanOptions options{.reason = std::string("griefing"),
                              .expires_at = std::string("2026-07-01T00:00:00.000Z"),
                              .actor_user_id = std::string("user_mod")};
  REQUIRE(h.client.bans().add("user_1", options).has_value());
  const Json body = body_of(h.transport->last_request());
  CHECK(body == Json::parse(R"({
    "userId": "user_1",
    "reason": "griefing",
    "expiresAt": "2026-07-01T00:00:00.000Z",
    "actorUserId": "user_mod"
  })"));
}

TEST_CASE("bans.remove DELETEs the encoded user id with no body when no actor is given") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.bans().remove("user with space").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/bans/user%20with%20space");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("bans.remove carries an actorUserId body when set") {
  Harness h;
  h.transport->enqueue_json(204, "");
  const RemoveBanOptions options{.actor_user_id = std::string("user_mod")};
  CHECK(h.client.bans().remove("user_1", options).has_value());
  const Json body = body_of(h.transport->last_request());
  CHECK(body == Json::parse(R"({"actorUserId":"user_mod"})"));
}

TEST_CASE("bans.get maps not_found to an empty optional (not banned / expired / unseen)") {
  Harness h;
  h.transport->enqueue_json(200, kBanJson);
  const Result<std::optional<Ban>> got = h.client.bans().get("user_1");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK(got.value()->id == "ban_1");
  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/bans/user_1");

  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<std::optional<Ban>> missing = h.client.bans().get("user_clean");
  REQUIRE(missing.has_value());
  CHECK_FALSE(missing.value().has_value());
}

TEST_CASE("bans.get surfaces a permanent ban's nullable fields as absent") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "id": "ban_2",
    "gameId": "game_1",
    "userId": "user_2",
    "bannedAt": "2026-06-01T00:00:00.000Z",
    "expiresAt": null,
    "reason": null,
    "bannedBy": null,
    "futureField": true
  })");
  const Result<std::optional<Ban>> got = h.client.bans().get("user_2");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK_FALSE(got.value()->expires_at.has_value());
  CHECK_FALSE(got.value()->reason.has_value());
  CHECK_FALSE(got.value()->banned_by.has_value());
}

TEST_CASE("bans.list without options hits the bare collection URL") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const Result<Page<Ban>> page = h.client.bans().list();
  REQUIRE(page.has_value());
  CHECK(page.value().items.empty());
  CHECK_FALSE(page.value().next_cursor.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/bans");
}

TEST_CASE("bans.list encodes limit, cursor, and includeExpired only when true") {
  Harness h;
  const std::string body = std::string(R"({"items":[)") + kBanJson + R"(],"nextCursor":"ban_1"})";
  h.transport->enqueue_json(200, body);
  const ListBansOptions options{
      .limit = 10, .cursor = std::string("ban_0"), .include_expired = true};
  const Result<Page<Ban>> page = h.client.bans().list(options);
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/bans?limit=10&cursor=ban_0&includeExpired=true");
  REQUIRE(page.value().items.size() == 1);
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "ban_1");

  // include_expired false is omitted entirely (the server default is
  // already active-only), matching the TS SDK.
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListBansOptions default_options{.limit = 5};
  REQUIRE(h.client.bans().list(default_options).has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/bans?limit=5");
}

TEST_CASE("bans.history hits /v1/bans/:userId/history and deserializes entries") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "items": [{
      "id": "bh_9",
      "gameId": "game_1",
      "userId": "user_1",
      "scope": "game",
      "groupId": null,
      "kind": "lifted",
      "reason": null,
      "expiresAt": null,
      "eventAt": "2026-06-10T00:00:00.000Z",
      "actorUserId": null
    }],
    "nextCursor": null
  })");
  const Result<Page<BanHistoryEntry>> page = h.client.bans().history("user_1");
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/bans/user_1/history");
  REQUIRE(page.value().items.size() == 1);
  const BanHistoryEntry& entry = page.value().items[0];
  CHECK(entry.scope == "game");
  CHECK(entry.kind == "lifted");
  CHECK_FALSE(entry.group_id.has_value());
  CHECK_FALSE(entry.actor_user_id.has_value());
}

TEST_CASE("bans.history encodes limit, cursor, scope, and groupId") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListBanHistoryOptions options{.limit = 25,
                                      .cursor = std::string("bh_5"),
                                      .scope = std::string("group"),
                                      .group_id = std::string("grp_1")};
  REQUIRE(h.client.bans().history("user_1", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/bans/user_1/history"
        "?limit=25&cursor=bh_5&scope=group&groupId=grp_1");
}

TEST_CASE("a ban missing bannedAt maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"id":"ban_3","gameId":"game_1","userId":"user_1"})");
  const Result<std::optional<Ban>> got = h.client.bans().get("user_1");
  REQUIRE_FALSE(got.has_value());
  CHECK(got.error().code == ErrorCode::InvalidWireData);
}
