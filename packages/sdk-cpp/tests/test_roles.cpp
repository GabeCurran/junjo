// Junjo.io SDK for C++: RolesApi domain surface against
// MockTransport: exact create/update bodies (tri-state color),
// null-on-404 get, permission grant/revoke, and delete.
#include <doctest/doctest.h>

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/result.hpp>
#include <junjo/roles.hpp>
#include <junjo/types.hpp>

#include "json.hpp"
#include "test_support.hpp"

using junjo::CreateRoleInput;
using junjo::ErrorCode;
using junjo::Patch;
using junjo::Result;
using junjo::Role;
using junjo::UpdateRoleInput;
using junjo::detail::Json;
using junjo::test::body_of;
using junjo::test::Harness;
using junjo::test::kNotFoundJson;
using junjo::test::kRoleJson;

TEST_CASE("roles.create posts the minimal body, then the full body, exactly") {
  Harness h;
  h.transport->enqueue_json(201, kRoleJson);
  const Result<Role> created =
      h.client.roles().create("grp_1", {.name = "Officer", .priority = 10});
  REQUIRE(created.has_value());
  const Role& role = created.value();
  CHECK(role.id == "role_1");
  CHECK(role.group_id == "grp_1");
  CHECK(role.name == "Officer");
  CHECK(role.priority == 10);
  REQUIRE(role.color.has_value());
  CHECK(*role.color == "#ff5050");
  CHECK_FALSE(role.is_default);
  REQUIRE(role.permissions.size() == 2);
  CHECK(role.permissions[0] == "invite_member");
  CHECK(role.created_at == "2026-01-15T00:00:00.000Z");

  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/roles");
  CHECK(body_of(h.transport->last_request()) == Json{{"name", "Officer"}, {"priority", 10}});

  h.transport->enqueue_json(201, kRoleJson);
  const CreateRoleInput full{.name = "Recruit",
                             .priority = 1,
                             .color = std::string("#00ff00"),
                             .is_default = true};
  CHECK(h.client.roles().create("grp_1", full).has_value());
  const Json expected = {
      {"name", "Recruit"}, {"priority", 1}, {"color", "#00ff00"}, {"isDefault", true}};
  CHECK(body_of(h.transport->last_request()) == expected);
}

TEST_CASE("roles.create surfaces role_name_taken as its typed code") {
  Harness h;
  h.transport->enqueue_json(409, R"({"code":"role_name_taken","status":409,"message":"taken"})");
  const Result<Role> created =
      h.client.roles().create("grp_1", {.name = "Officer", .priority = 1});
  REQUIRE_FALSE(created.has_value());
  CHECK(created.error().code == ErrorCode::RoleNameTaken);
}

TEST_CASE("roles.get maps not_found to an empty optional and tolerates a null color") {
  Harness h;
  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<std::optional<Role>> missing = h.client.roles().get("role_missing");
  REQUIRE(missing.has_value());
  CHECK_FALSE(missing.value().has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/roles/role_missing");

  h.transport->enqueue_json(200, R"({
    "id": "role_2",
    "groupId": "grp_1",
    "name": "Member",
    "priority": 0,
    "color": null,
    "isDefault": true,
    "permissions": [],
    "createdAt": "2026-01-15T00:00:00.000Z",
    "futureField": 42
  })");
  const Result<std::optional<Role>> got = h.client.roles().get("role_2");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK_FALSE(got.value()->color.has_value());
  CHECK(got.value()->is_default);
  CHECK(got.value()->permissions.empty());
}

TEST_CASE("roles.list returns every role of the group") {
  Harness h;
  const std::string body = std::string("[") + kRoleJson + "]";
  h.transport->enqueue_json(200, body);
  const Result<std::vector<Role>> roles = h.client.roles().list("grp_1");
  REQUIRE(roles.has_value());
  REQUIRE(roles.value().size() == 1);
  CHECK(roles.value()[0].name == "Officer");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/roles");
}

TEST_CASE("roles.update tri-state color: SET sends the value, CLEAR sends null, OMIT drops") {
  Harness h;
  h.transport->enqueue_json(200, kRoleJson);
  UpdateRoleInput set;
  set.name = std::string("Veteran");
  set.priority = std::int64_t{5};
  set.color = std::string("#123abc");
  set.is_default = false;
  CHECK(h.client.roles().update("role_1", set).has_value());
  CHECK(h.transport->last_request().method == "PATCH");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/roles/role_1");
  const Json expected = {
      {"name", "Veteran"}, {"priority", 5}, {"color", "#123abc"}, {"isDefault", false}};
  CHECK(body_of(h.transport->last_request()) == expected);

  h.transport->enqueue_json(200, kRoleJson);
  UpdateRoleInput clear;
  clear.color = Patch<std::string>::clear();
  CHECK(h.client.roles().update("role_1", clear).has_value());
  const Json cleared = body_of(h.transport->last_request());
  REQUIRE(cleared.contains("color"));
  CHECK(cleared["color"].is_null());
  CHECK(cleared.size() == 1);

  h.transport->enqueue_json(200, kRoleJson);
  UpdateRoleInput omit;
  omit.name = std::string("Quiet");
  CHECK(h.client.roles().update("role_1", omit).has_value());
  CHECK_FALSE(body_of(h.transport->last_request()).contains("color"));
}

TEST_CASE("roles.remove deletes and surfaces role_has_members") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.roles().remove("role_1").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/roles/role_1");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(
      409, R"({"code":"role_has_members","status":409,"message":"still held"})");
  const Result<void> removed = h.client.roles().remove("role_1");
  REQUIRE_FALSE(removed.has_value());
  CHECK(removed.error().code == ErrorCode::RoleHasMembers);
}

TEST_CASE("roles.grant_permission posts the key and returns the updated role") {
  Harness h;
  h.transport->enqueue_json(200, kRoleJson);
  const Result<Role> granted = h.client.roles().grant_permission("role_1", "invite_member");
  REQUIRE(granted.has_value());
  CHECK(granted.value().permissions.size() == 2);
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/roles/role_1/permissions");
  CHECK(body_of(h.transport->last_request()) == Json{{"permission", "invite_member"}});
}

TEST_CASE("roles.revoke_permission deletes the encoded key path with no body") {
  Harness h;
  h.transport->enqueue_json(200, kRoleJson);
  const Result<Role> revoked = h.client.roles().revoke_permission("role_1", "claim territory");
  REQUIRE(revoked.has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/roles/role_1/permissions/claim%20territory");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("a role response missing priority maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "id": "role_3", "groupId": "grp_1", "name": "Broken",
    "color": null, "isDefault": false, "permissions": [],
    "createdAt": "2026-01-15T00:00:00.000Z"
  })");
  const Result<std::optional<Role>> got = h.client.roles().get("role_3");
  REQUIRE_FALSE(got.has_value());
  CHECK(got.error().code == ErrorCode::InvalidWireData);
}
