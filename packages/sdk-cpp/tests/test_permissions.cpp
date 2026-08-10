// Junjo.io SDK for C++: Client::check and Client::can against
// MockTransport: query encoding, source enum mapping, viaRoleId
// handling, and error passthrough (check is NOT null-on-404).
#include <doctest/doctest.h>

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
