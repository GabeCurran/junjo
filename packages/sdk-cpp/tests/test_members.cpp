// Junjo.io SDK for C++: MembersApi domain surface against
// MockTransport: URL/query assembly (comma-joined status filter),
// exact body JSON, null-on-404 lookups, the tri-state notes PATCH, and
// permission overrides.
#include <doctest/doctest.h>

#include <optional>
#include <string>
#include <vector>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/members.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "json.hpp"
#include "test_support.hpp"

using junjo::ErrorCode;
using junjo::ListMembersForUserOptions;
using junjo::ListMembersOptions;
using junjo::Member;
using junjo::MemberPermissionOverride;
using junjo::Page;
using junjo::Patch;
using junjo::Result;
using junjo::RoleAssignmentOptions;
using junjo::SetMemberNotesInput;
using junjo::detail::Json;
using junjo::test::body_of;
using junjo::test::Harness;
using junjo::test::kMemberJson;
using junjo::test::kNotFoundJson;
using junjo::test::kOverrideJson;
using junjo::test::kPermissionDeniedJson;

// ---------------------------------------------------------------------
// get / get_by_id
// ---------------------------------------------------------------------

TEST_CASE("members.get deserializes the full member, encoding both path segments") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);

  const Result<std::optional<Member>> got = h.client.members().get("grp/1", "user 1");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  const Member& member = *got.value();
  CHECK(member.id == "mem_1");
  CHECK(member.group_id == "grp_1");
  CHECK(member.user_id == "user_1");
  CHECK(member.status == "active");
  REQUIRE(member.roles.size() == 2);
  CHECK(member.roles[0] == "role_1");
  CHECK(member.roles[1] == "role_2");
  CHECK(member.metadata_json.find("\"rank\"") != std::string::npos);
  REQUIRE(member.notes_public.has_value());
  CHECK(*member.notes_public == "reliable tank");
  CHECK_FALSE(member.notes_private.has_value());
  CHECK(member.joined_at == "2026-03-01T00:00:00.000Z");
  CHECK_FALSE(member.banned_until.has_value());

  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp%2F1/members/user%201");
}

TEST_CASE("members.get maps not_found to an empty optional and keeps other errors") {
  Harness h;
  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<std::optional<Member>> missing = h.client.members().get("grp_1", "user_1");
  REQUIRE(missing.has_value());
  CHECK_FALSE(missing.value().has_value());

  h.transport->enqueue_json(403, kPermissionDeniedJson);
  const Result<std::optional<Member>> denied = h.client.members().get("grp_1", "user_1");
  REQUIRE_FALSE(denied.has_value());
  CHECK(denied.error().code == ErrorCode::PermissionDenied);
}

TEST_CASE("members.get_by_id hits /v1/members/:id with null-on-404 semantics") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  const Result<std::optional<Member>> got = h.client.members().get_by_id("mem_1");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK(got.value()->id == "mem_1");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/members/mem_1");

  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<std::optional<Member>> missing = h.client.members().get_by_id("mem_missing");
  REQUIRE(missing.has_value());
  CHECK_FALSE(missing.value().has_value());
}

TEST_CASE("members.get tolerates unknown fields and a banned member's bannedUntil") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "id": "mem_2",
    "groupId": "grp_1",
    "userId": "user_2",
    "status": "banned",
    "roles": [],
    "metadata": {},
    "notesPublic": null,
    "notesPrivate": "watchlist",
    "joinedAt": "2026-03-01T00:00:00.000Z",
    "bannedUntil": "2027-01-01T00:00:00.000Z",
    "someFutureField": {"nested": true}
  })");
  const Result<std::optional<Member>> got = h.client.members().get("grp_1", "user_2");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK(got.value()->status == "banned");
  CHECK(got.value()->roles.empty());
  CHECK(got.value()->metadata_json == "{}");
  CHECK_FALSE(got.value()->notes_public.has_value());
  REQUIRE(got.value()->notes_private.has_value());
  CHECK(*got.value()->notes_private == "watchlist");
  REQUIRE(got.value()->banned_until.has_value());
  CHECK(*got.value()->banned_until == "2027-01-01T00:00:00.000Z");
}

// ---------------------------------------------------------------------
// list / list_for_user
// ---------------------------------------------------------------------

TEST_CASE("members.list without options hits the bare collection URL") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const Result<Page<Member>> page = h.client.members().list("grp_1");
  REQUIRE(page.has_value());
  CHECK(page.value().items.empty());
  CHECK_FALSE(page.value().next_cursor.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/members");
}

TEST_CASE("members.list comma-joins the status filter and passes the cursor through") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kMemberJson + R"(],"nextCursor":"mem_next"})";
  h.transport->enqueue_json(200, body);

  const ListMembersOptions options{.limit = 25,
                                   .cursor = std::string("mem_cur"),
                                   .status = {"active", "banned"}};
  const Result<Page<Member>> page = h.client.members().list("grp_1", options);
  REQUIRE(page.has_value());
  // The comma percent-encodes to %2C, matching URLSearchParams in the
  // TS SDK; the server decodes before splitting.
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members"
        "?limit=25&cursor=mem_cur&status=active%2Cbanned");
  REQUIRE(page.value().items.size() == 1);
  CHECK(page.value().items[0].id == "mem_1");
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "mem_next");
}

TEST_CASE("members.list omits an empty status filter entirely") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListMembersOptions options{.limit = 5};
  CHECK(h.client.members().list("grp_1", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members?limit=5");
}

TEST_CASE("members.list_for_user lists across groups, with an optional gameId filter") {
  Harness h;
  const std::string body = std::string("[") + kMemberJson + "]";
  h.transport->enqueue_json(200, body);
  const Result<std::vector<Member>> rows = h.client.members().list_for_user("user_1");
  REQUIRE(rows.has_value());
  REQUIRE(rows.value().size() == 1);
  CHECK(rows.value()[0].user_id == "user_1");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/users/user_1/members");

  h.transport->enqueue_json(200, "[]");
  const ListMembersForUserOptions options{.game_id = std::string("game_1")};
  const Result<std::vector<Member>> filtered =
      h.client.members().list_for_user("user_1", options);
  REQUIRE(filtered.has_value());
  CHECK(filtered.value().empty());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/members?gameId=game_1");
}

// ---------------------------------------------------------------------
// set_metadata / set_notes
// ---------------------------------------------------------------------

TEST_CASE("members.set_metadata patches the parsed metadata object exactly") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.members().set_metadata("grp_1", "user_1", R"({"rank":4})").has_value());
  CHECK(h.transport->last_request().method == "PATCH");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1");
  CHECK(body_of(h.transport->last_request()) == Json{{"metadata", {{"rank", 4}}}});
}

TEST_CASE("members.set_metadata rejects non-object metadata client-side with InvalidConfig") {
  Harness h;
  const Result<Member> updated =
      h.client.members().set_metadata("grp_1", "user_1", "not json");
  REQUIRE_FALSE(updated.has_value());
  CHECK(updated.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->request_count() == 0);
}

TEST_CASE("members.set_notes tri-state: SET sends values, CLEAR sends null, OMIT drops") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  SetMemberNotesInput both;
  both.notes_public = std::string("solid raider");
  both.notes_private = std::string("promote next season");
  CHECK(h.client.members().set_notes("grp_1", "user_1", both).has_value());
  CHECK(body_of(h.transport->last_request()) ==
        Json{{"notesPublic", "solid raider"}, {"notesPrivate", "promote next season"}});

  h.transport->enqueue_json(200, kMemberJson);
  SetMemberNotesInput clear_public;
  clear_public.notes_public = Patch<std::string>::clear();
  CHECK(h.client.members().set_notes("grp_1", "user_1", clear_public).has_value());
  const Json body = body_of(h.transport->last_request());
  REQUIRE(body.contains("notesPublic"));
  CHECK(body["notesPublic"].is_null());
  CHECK_FALSE(body.contains("notesPrivate"));
  CHECK(body.size() == 1);
}

// ---------------------------------------------------------------------
// role assignment
// ---------------------------------------------------------------------

TEST_CASE("members.assign_role posts with no body, adding the actor when set") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.members().assign_role("grp_1", "user_1", "role x").has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/roles/role%20x");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(200, kMemberJson);
  const RoleAssignmentOptions options{.actor_user_id = std::string("user_mod")};
  CHECK(h.client.members().assign_role("grp_1", "user_1", "role_1", options).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"actorUserId", "user_mod"}});
}

TEST_CASE("members.remove_role deletes the assignment, mirroring assign_role's body rules") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.members().remove_role("grp_1", "user_1", "role_1").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/roles/role_1");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(200, kMemberJson);
  const RoleAssignmentOptions options{.actor_user_id = std::string("user_mod")};
  CHECK(h.client.members().remove_role("grp_1", "user_1", "role_1", options).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"actorUserId", "user_mod"}});
}

TEST_CASE("members.assign_role surfaces role_group_mismatch as its typed code") {
  Harness h;
  h.transport->enqueue_json(
      400, R"({"code":"role_group_mismatch","status":400,"message":"wrong group"})");
  const Result<Member> assigned =
      h.client.members().assign_role("grp_1", "user_1", "role_other");
  REQUIRE_FALSE(assigned.has_value());
  CHECK(assigned.error().code == ErrorCode::RoleGroupMismatch);
}

// ---------------------------------------------------------------------
// permission overrides
// ---------------------------------------------------------------------

TEST_CASE("members.override_permission posts the grant flag exactly") {
  Harness h;
  h.transport->enqueue_json(200, kOverrideJson);
  const Result<MemberPermissionOverride> set = h.client.members().override_permission(
      "grp_1", "user_1", "claim territory", /*grant=*/false);
  REQUIRE(set.has_value());
  CHECK(set.value().group_id == "grp_1");
  CHECK(set.value().user_id == "user_1");
  CHECK(set.value().permission == "claim_territory");
  CHECK(set.value().grant);
  CHECK(set.value().set_at == "2026-05-02T00:00:00.000Z");
  REQUIRE(set.value().set_by.has_value());
  CHECK(*set.value().set_by == "user_mod");

  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/permissions/claim%20territory");
  CHECK(body_of(h.transport->last_request()) == Json{{"grant", false}});
}

TEST_CASE("members.clear_permission_override deletes with no body and succeeds on 204") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.members()
            .clear_permission_override("grp_1", "user_1", "claim_territory")
            .has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/permissions/claim_territory");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("members.list_permission_overrides returns every override row") {
  Harness h;
  const std::string body = std::string("[") + kOverrideJson + "]";
  h.transport->enqueue_json(200, body);
  const Result<std::vector<MemberPermissionOverride>> rows =
      h.client.members().list_permission_overrides("grp_1", "user_1");
  REQUIRE(rows.has_value());
  REQUIRE(rows.value().size() == 1);
  CHECK(rows.value()[0].permission == "claim_territory");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/permissions");
}

TEST_CASE("a mistyped override row (grant as string) maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(
      200, R"([{"groupId":"g","userId":"u","permission":"p","grant":"yes",
                "setAt":"2026-05-02T00:00:00.000Z","setBy":null}])");
  const Result<std::vector<MemberPermissionOverride>> rows =
      h.client.members().list_permission_overrides("grp_1", "user_1");
  REQUIRE_FALSE(rows.has_value());
  CHECK(rows.error().code == ErrorCode::InvalidWireData);
}
