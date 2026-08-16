// Junjo.io SDK for C++: Client::check, Client::can, and
// Client::check_batch against MockTransport: query encoding, source
// enum mapping, viaRoleId / viaGroupId handling, the opt-in inherit
// walk, batch slicing, and error passthrough (check is NOT
// null-on-404).
#include <doctest/doctest.h>

#include <cstddef>
#include <string>
#include <vector>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "test_support.hpp"

using junjo::ErrorCode;
using junjo::PermissionCheckResult;
using junjo::PermissionSource;
using junjo::Result;
using junjo::test::Harness;
using junjo::test::kNotFoundJson;

TEST_CASE("check builds the query in userId, groupId, permission order with encoding") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"role","viaRoleId":"role_1"})");

  const Result<PermissionCheckResult> checked =
      h.client.check("user one", "grp/1", "claim territory");
  REQUIRE(checked.has_value());
  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/permissions/check"
        "?userId=user%20one&groupId=grp%2F1&permission=claim%20territory");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("check maps a role-sourced grant including viaRoleId") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"role","viaRoleId":"role_1"})");
  const Result<PermissionCheckResult> checked = h.client.check("u", "g", "p");
  REQUIRE(checked.has_value());
  CHECK(checked.value().allowed);
  CHECK(checked.value().source == PermissionSource::Role);
  REQUIRE(checked.value().via_role_id.has_value());
  CHECK(*checked.value().via_role_id == "role_1");
}

TEST_CASE("check maps override, default, and none sources without viaRoleId") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"override"})");
  Result<PermissionCheckResult> checked = h.client.check("u", "g", "p");
  REQUIRE(checked.has_value());
  CHECK(checked.value().allowed);
  CHECK(checked.value().source == PermissionSource::Override);
  CHECK_FALSE(checked.value().via_role_id.has_value());

  h.transport->enqueue_json(200, R"({"allowed":false,"source":"default"})");
  checked = h.client.check("u", "g", "p");
  REQUIRE(checked.has_value());
  CHECK_FALSE(checked.value().allowed);
  CHECK(checked.value().source == PermissionSource::Default);

  h.transport->enqueue_json(200, R"({"allowed":false,"source":"none"})");
  checked = h.client.check("u", "g", "p");
  REQUIRE(checked.has_value());
  CHECK_FALSE(checked.value().allowed);
  CHECK(checked.value().source == PermissionSource::None);
}

TEST_CASE("check rejects an unknown source value as InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"prophecy"})");
  const Result<PermissionCheckResult> checked = h.client.check("u", "g", "p");
  REQUIRE_FALSE(checked.has_value());
  CHECK(checked.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("check surfaces not_found as an error, not an empty optional") {
  // Unlike the tryGet-style lookups, a missing group here is a real
  // failure, matching the TS SDK where check() throws.
  Harness h;
  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<PermissionCheckResult> checked = h.client.check("u", "grp_missing", "p");
  REQUIRE_FALSE(checked.has_value());
  CHECK(checked.error().code == ErrorCode::NotFound);
}

TEST_CASE("can reduces the check result to its allowed flag") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"role","viaRoleId":"role_1"})");
  Result<bool> can = h.client.can("u", "g", "p");
  REQUIRE(can.has_value());
  CHECK(can.value());

  h.transport->enqueue_json(200, R"({"allowed":false,"source":"none"})");
  can = h.client.can("u", "g", "p");
  REQUIRE(can.has_value());
  CHECK_FALSE(can.value());
}

TEST_CASE("can propagates errors from the underlying check") {
  Harness h;
  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<bool> can = h.client.can("u", "grp_missing", "p");
  REQUIRE_FALSE(can.has_value());
  CHECK(can.error().code == ErrorCode::NotFound);
}

TEST_CASE("check omits the inherit param by default and appends it when set") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":false,"source":"default"})");
  Result<PermissionCheckResult> checked = h.client.check("u", "g", "p");
  REQUIRE(checked.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/permissions/check?userId=u&groupId=g&permission=p");

  h.transport->enqueue_json(200, R"({"allowed":false,"source":"default"})");
  checked = h.client.check("u", "g", "p", {.inherit = true});
  REQUIRE(checked.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/permissions/check?userId=u&groupId=g&permission=p&inherit=true");
}

TEST_CASE("check surfaces viaGroupId from an inherited decision") {
  Harness h;
  h.transport->enqueue_json(
      200, R"({"allowed":true,"source":"role","viaRoleId":"role_1","viaGroupId":"grp_parent"})");
  const Result<PermissionCheckResult> checked = h.client.check("u", "g", "p", {.inherit = true});
  REQUIRE(checked.has_value());
  REQUIRE(checked.value().via_group_id.has_value());
  CHECK(*checked.value().via_group_id == "grp_parent");
}

TEST_CASE("check leaves viaGroupId absent when the server omits it") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":false,"source":"none"})");
  const Result<PermissionCheckResult> checked = h.client.check("u", "g", "p");
  REQUIRE(checked.has_value());
  CHECK_FALSE(checked.value().via_group_id.has_value());
}

TEST_CASE("check rejects a non-string viaGroupId as wire data") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"role","viaGroupId":7})");
  const Result<PermissionCheckResult> checked = h.client.check("u", "g", "p");
  REQUIRE_FALSE(checked.has_value());
  CHECK(checked.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("can forwards inherit to check") {
  Harness h;
  h.transport->enqueue_json(200, R"({"allowed":true,"source":"role","viaGroupId":"grp_parent"})");
  const Result<bool> can = h.client.can("u", "g", "p", {.inherit = true});
  REQUIRE(can.has_value());
  CHECK(can.value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/permissions/check?userId=u&groupId=g&permission=p&inherit=true");
}

TEST_CASE("check_batch POSTs one request and returns results positionally") {
  Harness h;
  h.transport->enqueue_json(
      200,
      R"({"results":[{"allowed":true,"source":"role","viaRoleId":"role_1"},)"
      R"({"allowed":false,"source":"none"}]})");

  const std::vector<junjo::PermissionCheckRequest> checks{
      {.user_id = "user_a", .group_id = "grp_1", .permission = "kick"},
      {.user_id = "user_b", .group_id = "grp_2", .permission = "invite"},
  };
  const Result<std::vector<PermissionCheckResult>> results = h.client.check_batch(checks);
  REQUIRE(results.has_value());
  REQUIRE(results.value().size() == 2);
  CHECK(results.value()[0].allowed);
  CHECK(results.value()[0].source == PermissionSource::Role);
  CHECK_FALSE(results.value()[1].allowed);
  CHECK(results.value()[1].source == PermissionSource::None);

  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/permissions/check-batch");
  REQUIRE(h.transport->last_request().body.has_value());
  CHECK(h.transport->last_request().body->find("\"userId\":\"user_a\"") != std::string::npos);
  CHECK(h.transport->last_request().body->find("\"permission\":\"invite\"") != std::string::npos);
  CHECK(h.transport->last_request().body->find("inherit") == std::string::npos);
}

TEST_CASE("check_batch returns empty without a request for no checks") {
  Harness h;
  const Result<std::vector<PermissionCheckResult>> results = h.client.check_batch({});
  REQUIRE(results.has_value());
  CHECK(results.value().empty());
  CHECK(h.transport->request_count() == 0);
}

TEST_CASE("check_batch sends inherit in the body when set") {
  Harness h;
  h.transport->enqueue_json(200, R"({"results":[{"allowed":true,"source":"role"}]})");
  const std::vector<junjo::PermissionCheckRequest> checks{
      {.user_id = "u", .group_id = "g", .permission = "p"}};
  const Result<std::vector<PermissionCheckResult>> results =
      h.client.check_batch(checks, {.inherit = true});
  REQUIRE(results.has_value());
  REQUIRE(h.transport->last_request().body.has_value());
  CHECK(h.transport->last_request().body->find("\"inherit\":true") != std::string::npos);
}

TEST_CASE("check_batch splits inputs past the server cap across requests") {
  Harness h;
  const std::size_t total = 250;
  // Three slices: 100, 100, 50.
  for (const std::size_t size : {std::size_t{100}, std::size_t{100}, std::size_t{50}}) {
    std::string body = R"({"results":[)";
    for (std::size_t i = 0; i < size; ++i) {
      if (i > 0) body += ",";
      body += R"({"allowed":true,"source":"role"})";
    }
    body += "]}";
    h.transport->enqueue_json(200, body);
  }

  std::vector<junjo::PermissionCheckRequest> checks;
  checks.reserve(total);
  for (std::size_t i = 0; i < total; ++i) {
    checks.push_back({.user_id = "u" + std::to_string(i), .group_id = "g", .permission = "p"});
  }

  const Result<std::vector<PermissionCheckResult>> results = h.client.check_batch(checks);
  REQUIRE(results.has_value());
  CHECK(results.value().size() == total);
  CHECK(h.transport->request_count() == 3);
}

TEST_CASE("check_batch fails when the server returns a mismatched result count") {
  Harness h;
  h.transport->enqueue_json(200, R"({"results":[{"allowed":true,"source":"role"}]})");
  const std::vector<junjo::PermissionCheckRequest> checks{
      {.user_id = "a", .group_id = "g", .permission = "p"},
      {.user_id = "b", .group_id = "g", .permission = "p"},
  };
  const Result<std::vector<PermissionCheckResult>> results = h.client.check_batch(checks);
  REQUIRE_FALSE(results.has_value());
  CHECK(results.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("check_batch propagates a not_found for an unknown group") {
  Harness h;
  h.transport->enqueue_json(404, kNotFoundJson);
  const std::vector<junjo::PermissionCheckRequest> checks{
      {.user_id = "u", .group_id = "grp_missing", .permission = "p"}};
  const Result<std::vector<PermissionCheckResult>> results = h.client.check_batch(checks);
  REQUIRE_FALSE(results.has_value());
  CHECK(results.error().code == ErrorCode::NotFound);
}

TEST_CASE("check_batch rejects a response body that is not a results array") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[]})");
  const std::vector<junjo::PermissionCheckRequest> checks{
      {.user_id = "u", .group_id = "g", .permission = "p"}};
  const Result<std::vector<PermissionCheckResult>> results = h.client.check_batch(checks);
  REQUIRE_FALSE(results.has_value());
  CHECK(results.error().code == ErrorCode::InvalidWireData);
}
