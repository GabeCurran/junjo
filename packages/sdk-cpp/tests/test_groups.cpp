// Junjo.io SDK for C++: GroupsApi domain surface against
// MockTransport: request assembly (method, URL, query encoding, exact
// body JSON), deserialization, null-on-404 semantics, and the
// tri-state passcode / defaultRoleId / parent bodies.
#include <doctest/doctest.h>

#include <optional>
#include <string>
#include <vector>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/groups.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "json.hpp"
#include "test_support.hpp"

using junjo::BanHistoryEntry;
using junjo::BanHistoryOptions;
using junjo::BanMemberOptions;
using junjo::BulkInviteOptions;
using junjo::BulkInviteResult;
using junjo::ClearRelationshipOptions;
using junjo::ClientConfig;
using junjo::CreateGroupInput;
using junjo::DeclineInvitationOptions;
using junjo::ErrorCode;
using junjo::Group;
using junjo::GroupRelationship;
using junjo::HttpRequest;
using junjo::Invitation;
using junjo::InviteByCodeOptions;
using junjo::InviteByLinkOptions;
using junjo::InviteByLinkResult;
using junjo::InviteByUserIdOptions;
using junjo::JoinGroupOptions;
using junjo::KickMemberOptions;
using junjo::ListGroupsOptions;
using junjo::Member;
using junjo::Page;
using junjo::Patch;
using junjo::RemoveGroupOptions;
using junjo::Result;
using junjo::SetRelationshipOptions;
using junjo::UnbanMemberOptions;
using junjo::UpdateGroupInput;
using junjo::detail::Json;
using junjo::test::body_of;
using junjo::test::Harness;
using junjo::test::kBanHistoryEntryJson;
using junjo::test::kGroupJson;
using junjo::test::kInvitationJson;
using junjo::test::kMemberJson;
using junjo::test::kNotFoundJson;
using junjo::test::kPermissionDeniedJson;
using junjo::test::kRelationshipJson;

namespace {

// Content-type of a recorded request, or empty when absent. Header
// names are lowercase by SDK convention.
[[nodiscard]] std::string content_type_of(const HttpRequest& request) {
  for (const auto& [name, value] : request.headers) {
    if (name == "content-type") return value;
  }
  return {};
}

}  // namespace

// ---------------------------------------------------------------------
// create
// ---------------------------------------------------------------------

TEST_CASE("groups.create posts the full input body exactly") {
  Harness h;
  h.transport->enqueue_json(201, kGroupJson);

  const CreateGroupInput input{
      .kind = "guild",
      .name = "Night Watch",
      .visibility = std::string("invite-only"),
      .metadata_json = std::string(R"({"motto":"onward"})"),
      .default_role_id = std::string("role_member"),
      .creator_user_id = std::string("user_creator"),
      .passcode = std::string("1234"),
  };
  const Result<Group> created = h.client.groups().create(input);
  REQUIRE(created.has_value());
  CHECK(created.value().id == "grp_1");

  const auto& request = h.transport->last_request();
  CHECK(request.method == "POST");
  CHECK(request.url == "https://api.junjo.io/v1/groups");
  const Json expected = {
      {"kind", "guild"},           {"name", "Night Watch"},
      {"visibility", "invite-only"}, {"metadata", {{"motto", "onward"}}},
      {"defaultRoleId", "role_member"}, {"creatorUserId", "user_creator"},
      {"passcode", "1234"},
  };
  CHECK(body_of(request) == expected);
}

TEST_CASE("groups.create with a minimal input sends only kind and name") {
  Harness h;
  h.transport->enqueue_json(201, kGroupJson);

  CHECK(h.client.groups().create({.kind = "clan", .name = "Minimal"}).has_value());
  const Json expected = {{"kind", "clan"}, {"name", "Minimal"}};
  CHECK(body_of(h.transport->last_request()) == expected);
}

TEST_CASE("groups.create rejects non-object metadata_json client-side with InvalidConfig") {
  Harness h;
  const Result<Group> created = h.client.groups().create(
      {.kind = "guild", .name = "Broken", .metadata_json = std::string("[1,2,3]")});
  REQUIRE_FALSE(created.has_value());
  CHECK(created.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->request_count() == 0);
}

// ---------------------------------------------------------------------
// list
// ---------------------------------------------------------------------

TEST_CASE("groups.list without options hits the bare collection URL") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");

  const Result<Page<Group>> page = h.client.groups().list();
  REQUIRE(page.has_value());
  CHECK(page.value().items.empty());
  CHECK_FALSE(page.value().next_cursor.has_value());
  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("groups.list encodes limit, cursor, and viewer and passes the cursor through") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kGroupJson + R"(],"nextCursor":"grp_next"})";
  h.transport->enqueue_json(200, body);

  const ListGroupsOptions options{.limit = 25,
                                  .cursor = std::string("grp_cur"),
                                  .viewer = std::string("user one")};
  const Result<Page<Group>> page = h.client.groups().list(options);
  REQUIRE(page.has_value());
  REQUIRE(page.value().items.size() == 1);
  CHECK(page.value().items[0].name == "Night Watch");
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "grp_next");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups?limit=25&cursor=grp_cur&viewer=user%20one");
}

// ---------------------------------------------------------------------
// update: tri-state passcode / defaultRoleId
// ---------------------------------------------------------------------

TEST_CASE("groups.update sends only the fields that are present") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  const UpdateGroupInput input{.name = std::string("Renamed"),
                               .visibility = std::string("secret")};
  CHECK(h.client.groups().update("grp_1", input).has_value());
  const auto& request = h.transport->last_request();
  CHECK(request.method == "PATCH");
  CHECK(request.url == "https://api.junjo.io/v1/groups/grp_1");
  const Json expected = {{"name", "Renamed"}, {"visibility", "secret"}};
  CHECK(body_of(request) == expected);
}

TEST_CASE("groups.update tri-state SET sends passcode and defaultRoleId values") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  UpdateGroupInput input;
  input.default_role_id = std::string("role_new");
  input.passcode = std::string("9876");
  CHECK(h.client.groups().update("grp_1", input).has_value());
  const Json expected = {{"defaultRoleId", "role_new"}, {"passcode", "9876"}};
  CHECK(body_of(h.transport->last_request()) == expected);
}

TEST_CASE("groups.update tri-state CLEAR sends explicit JSON nulls") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  UpdateGroupInput input;
  input.default_role_id = Patch<std::string>::clear();
  input.passcode = Patch<std::string>::clear();
  CHECK(h.client.groups().update("grp_1", input).has_value());
  const Json body = body_of(h.transport->last_request());
  REQUIRE(body.contains("passcode"));
  CHECK(body["passcode"].is_null());
  REQUIRE(body.contains("defaultRoleId"));
  CHECK(body["defaultRoleId"].is_null());
  CHECK(body.size() == 2);
}

TEST_CASE("groups.update tri-state OMIT leaves passcode and defaultRoleId out entirely") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  const UpdateGroupInput input{.name = std::string("Still Here")};
  CHECK(h.client.groups().update("grp_1", input).has_value());
  const Json body = body_of(h.transport->last_request());
  CHECK_FALSE(body.contains("passcode"));
  CHECK_FALSE(body.contains("defaultRoleId"));
  CHECK(body == Json{{"name", "Still Here"}});
}

TEST_CASE("groups.update replaces metadata as a parsed object") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);

  const UpdateGroupInput input{.metadata_json = std::string(R"({"level":9})")};
  CHECK(h.client.groups().update("grp_1", input).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"metadata", {{"level", 9}}}});
}

// ---------------------------------------------------------------------
// remove / restore
// ---------------------------------------------------------------------

TEST_CASE("groups.remove soft-deletes by default and hard-deletes on request") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);
  CHECK(h.client.groups().remove("grp_1").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(204, "");
  CHECK(h.client.groups().remove("grp_1", RemoveGroupOptions{.hard = true}).has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1?hard=true");
}

TEST_CASE("groups.restore posts with no body and returns the revived group") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);
  const Result<Group> restored = h.client.groups().restore("grp_1");
  REQUIRE(restored.has_value());
  CHECK(restored.value().id == "grp_1");
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/restore");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("groups.restore surfaces restore_window_expired as its typed code") {
  Harness h;
  h.transport->enqueue_json(
      403, R"({"code":"restore_window_expired","status":403,"message":"too late"})");
  const Result<Group> restored = h.client.groups().restore("grp_1");
  REQUIRE_FALSE(restored.has_value());
  CHECK(restored.error().code == ErrorCode::RestoreWindowExpired);
}

// ---------------------------------------------------------------------
// join / leave / kick
// ---------------------------------------------------------------------

TEST_CASE("groups.join posts userId, adding the passcode only when supplied") {
  Harness h;
  h.transport->enqueue_json(201, kMemberJson);
  const Result<Member> joined = h.client.groups().join("grp_1", "user_1");
  REQUIRE(joined.has_value());
  CHECK(joined.value().user_id == "user_1");
  CHECK(joined.value().status == "active");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/join");
  CHECK(body_of(h.transport->last_request()) == Json{{"userId", "user_1"}});

  h.transport->enqueue_json(201, kMemberJson);
  const JoinGroupOptions options{.passcode = std::string("1234")};
  CHECK(h.client.groups().join("grp_1", "user_1", options).has_value());
  CHECK(body_of(h.transport->last_request()) ==
        Json{{"userId", "user_1"}, {"passcode", "1234"}});
}

TEST_CASE("groups.join surfaces passcode_required and banned as typed codes") {
  Harness h;
  h.transport->enqueue_json(
      403, R"({"code":"passcode_required","status":403,"message":"needs passcode"})");
  Result<Member> joined = h.client.groups().join("grp_1", "user_1");
  REQUIRE_FALSE(joined.has_value());
  CHECK(joined.error().code == ErrorCode::PasscodeRequired);

  h.transport->enqueue_json(403, R"({"code":"banned","status":403,"message":"banned"})");
  joined = h.client.groups().join("grp_1", "user_1");
  REQUIRE_FALSE(joined.has_value());
  CHECK(joined.error().code == ErrorCode::Banned);
}

TEST_CASE("groups.leave posts userId to the leave route") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.groups().leave("grp_1", "user_1").has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/leave");
  CHECK(body_of(h.transport->last_request()) == Json{{"userId", "user_1"}});
}

TEST_CASE("groups.kick posts an empty object without a reason, the reason otherwise") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.groups().kick("grp_1", "user with space").has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user%20with%20space/kick");
  CHECK(body_of(h.transport->last_request()) == Json::object());

  h.transport->enqueue_json(200, kMemberJson);
  const KickMemberOptions options{.reason = std::string("afk farming")};
  CHECK(h.client.groups().kick("grp_1", "user_1", options).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"reason", "afk farming"}});
}

// ---------------------------------------------------------------------
// ban / unban / ban_history
// ---------------------------------------------------------------------

TEST_CASE("groups.ban posts an empty object by default and all fields when set") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.groups().ban("grp_1", "user_1").has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/ban");
  CHECK(body_of(h.transport->last_request()) == Json::object());

  h.transport->enqueue_json(200, kMemberJson);
  const BanMemberOptions options{.reason = std::string("griefing"),
                                 .expires_at = std::string("2027-01-01T00:00:00.000Z"),
                                 .actor_user_id = std::string("user_mod")};
  CHECK(h.client.groups().ban("grp_1", "user_1", options).has_value());
  const Json expected = {{"reason", "griefing"},
                         {"expiresAt", "2027-01-01T00:00:00.000Z"},
                         {"actorUserId", "user_mod"}};
  CHECK(body_of(h.transport->last_request()) == expected);
}

TEST_CASE("groups.unban sends no body without an actor and the actor when set") {
  Harness h;
  h.transport->enqueue_json(200, kMemberJson);
  CHECK(h.client.groups().unban("grp_1", "user_1").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/members/user_1/ban");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(200, kMemberJson);
  const UnbanMemberOptions options{.actor_user_id = std::string("user_mod")};
  CHECK(h.client.groups().unban("grp_1", "user_1", options).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"actorUserId", "user_mod"}});
}

TEST_CASE("groups.ban_history pages the timeline and deserializes entries") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kBanHistoryEntryJson + R"(],"nextCursor":"bh_next"})";
  h.transport->enqueue_json(200, body);

  const BanHistoryOptions options{.limit = 10, .cursor = std::string("bh_cur")};
  const Result<Page<BanHistoryEntry>> page = h.client.groups().ban_history("grp_1", options);
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/bans/history?limit=10&cursor=bh_cur");
  REQUIRE(page.value().items.size() == 1);
  const BanHistoryEntry& entry = page.value().items[0];
  CHECK(entry.id == "bh_1");
  CHECK(entry.scope == "group");
  REQUIRE(entry.group_id.has_value());
  CHECK(*entry.group_id == "grp_1");
  CHECK(entry.kind == "set");
  REQUIRE(entry.reason.has_value());
  CHECK(*entry.reason == "griefing");
  CHECK_FALSE(entry.expires_at.has_value());
  CHECK(entry.event_at == "2026-06-01T00:00:00.000Z");
  REQUIRE(entry.actor_user_id.has_value());
  CHECK(*entry.actor_user_id == "user_mod");
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "bh_next");
}

// ---------------------------------------------------------------------
// invitations (creation + accept/decline live on GroupsApi)
// ---------------------------------------------------------------------

TEST_CASE("groups.invite_by_user_id posts targetUserId with an optional roleId") {
  Harness h;
  h.transport->enqueue_json(201, kInvitationJson);
  const Result<Invitation> invited = h.client.groups().invite_by_user_id("grp_1", "user_9");
  REQUIRE(invited.has_value());
  CHECK(invited.value().code == "a1b2c3d4e5f60708");
  REQUIRE(invited.value().target_user_id.has_value());
  CHECK(*invited.value().target_user_id == "user_9");
  CHECK_FALSE(invited.value().role_id.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/invitations");
  CHECK(body_of(h.transport->last_request()) == Json{{"targetUserId", "user_9"}});

  h.transport->enqueue_json(201, kInvitationJson);
  const InviteByUserIdOptions options{.role_id = std::string("role_recruit")};
  CHECK(h.client.groups().invite_by_user_id("grp_1", "user_9", options).has_value());
  CHECK(body_of(h.transport->last_request()) ==
        Json{{"targetUserId", "user_9"}, {"roleId", "role_recruit"}});
}

TEST_CASE("groups.invite_by_code posts an open invite, never a targetUserId") {
  Harness h;
  h.transport->enqueue_json(201, kInvitationJson);
  CHECK(h.client.groups().invite_by_code("grp_1").has_value());
  CHECK(body_of(h.transport->last_request()) == Json::object());

  h.transport->enqueue_json(201, kInvitationJson);
  const InviteByCodeOptions options{.role_id = std::string("role_recruit"),
                                    .expires_in = std::string("7d")};
  CHECK(h.client.groups().invite_by_code("grp_1", options).has_value());
  const Json body = body_of(h.transport->last_request());
  CHECK(body == Json{{"roleId", "role_recruit"}, {"expiresIn", "7d"}});
  CHECK_FALSE(body.contains("targetUserId"));
}

TEST_CASE("groups.accept_invitation posts userId to the accept route and returns the member") {
  Harness h;
  h.transport->enqueue_json(201, kMemberJson);
  const Result<Member> accepted =
      h.client.groups().accept_invitation("code/with/slashes", "user_1");
  REQUIRE(accepted.has_value());
  CHECK(accepted.value().group_id == "grp_1");
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/invitations/code%2Fwith%2Fslashes/accept");
  CHECK(body_of(h.transport->last_request()) == Json{{"userId", "user_1"}});
}

TEST_CASE("groups.accept_invitation surfaces invitation_expired and invitation_used") {
  Harness h;
  h.transport->enqueue_json(
      410, R"({"code":"invitation_expired","status":410,"message":"expired"})");
  Result<Member> accepted = h.client.groups().accept_invitation("abc", "user_1");
  REQUIRE_FALSE(accepted.has_value());
  CHECK(accepted.error().code == ErrorCode::InvitationExpired);

  h.transport->enqueue_json(409, R"({"code":"invitation_used","status":409,"message":"used"})");
  accepted = h.client.groups().accept_invitation("abc", "user_1");
  REQUIRE_FALSE(accepted.has_value());
  CHECK(accepted.error().code == ErrorCode::InvitationUsed);
}

TEST_CASE("groups.decline_invitation posts an empty object, or the userId when given") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.groups().decline_invitation("abc").has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/invitations/abc/decline");
  CHECK(body_of(h.transport->last_request()) == Json::object());

  h.transport->enqueue_json(204, "");
  const DeclineInvitationOptions options{.user_id = std::string("user_1")};
  CHECK(h.client.groups().decline_invitation("abc", options).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"userId", "user_1"}});
}

// ---------------------------------------------------------------------
// invite_by_link
// ---------------------------------------------------------------------

TEST_CASE("groups.invite_by_link composes the URL from invite_base_url and the created code") {
  Harness h{ClientConfig{.invite_base_url = std::string("https://play.example.com")}};
  h.transport->enqueue_json(201, kInvitationJson);

  const Result<InviteByLinkResult> linked = h.client.groups().invite_by_link("grp_1");
  REQUIRE(linked.has_value());
  CHECK(linked.value().invitation.code == "a1b2c3d4e5f60708");
  CHECK(linked.value().url == "https://play.example.com/invite/a1b2c3d4e5f60708");
  // The same open-invite POST invite_by_code issues underneath.
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/invitations");
  CHECK(body_of(h.transport->last_request()) == Json::object());
}

TEST_CASE("groups.invite_by_link strips a trailing slash and forwards role_id and expires_in") {
  Harness h{ClientConfig{.invite_base_url = std::string("https://play.example.com/")}};
  h.transport->enqueue_json(201, kInvitationJson);

  const InviteByLinkOptions options{.role_id = std::string("role_recruit"),
                                    .expires_in = std::string("7d")};
  const Result<InviteByLinkResult> linked = h.client.groups().invite_by_link("grp_1", options);
  REQUIRE(linked.has_value());
  CHECK(linked.value().url == "https://play.example.com/invite/a1b2c3d4e5f60708");
  CHECK(body_of(h.transport->last_request()) ==
        Json{{"roleId", "role_recruit"}, {"expiresIn", "7d"}});
}

TEST_CASE("groups.invite_by_link percent-encodes the invitation code in the URL") {
  Harness h{ClientConfig{.invite_base_url = std::string("https://play.example.com")}};
  h.transport->enqueue_json(201, R"({
    "id": "inv_9",
    "groupId": "grp_1",
    "code": "a b/c",
    "roleId": null,
    "targetUserId": null,
    "createdBy": null,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "expiresAt": null,
    "usedAt": null,
    "usedBy": null
  })");
  const Result<InviteByLinkResult> linked = h.client.groups().invite_by_link("grp_1");
  REQUIRE(linked.has_value());
  CHECK(linked.value().url == "https://play.example.com/invite/a%20b%2Fc");
}

TEST_CASE("groups.invite_by_link without invite_base_url fails InvalidConfig and makes no request") {
  Harness h;
  const Result<InviteByLinkResult> linked = h.client.groups().invite_by_link("grp_1");
  REQUIRE_FALSE(linked.has_value());
  CHECK(linked.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->request_count() == 0);
}

// ---------------------------------------------------------------------
// bulk_invite
// ---------------------------------------------------------------------

TEST_CASE("groups.bulk_invite posts the CSV body verbatim as text/csv and parses the summary") {
  Harness h;
  h.transport->enqueue_json(
      200,
      R"({"invited":2,"skipped":1,"errors":[{"row":4,"reason":"userId exceeds 255 characters"}]})");

  const std::string csv = "user_1\nuser_2\nuser_1\n";
  const Result<BulkInviteResult> result = h.client.groups().bulk_invite("grp_1", csv);
  REQUIRE(result.has_value());
  CHECK(result.value().invited == 2);
  CHECK(result.value().skipped == 1);
  REQUIRE(result.value().errors.size() == 1);
  CHECK(result.value().errors[0].row == 4);
  CHECK(result.value().errors[0].reason == "userId exceeds 255 characters");

  const auto& request = h.transport->last_request();
  CHECK(request.method == "POST");
  CHECK(request.url == "https://api.junjo.io/v1/groups/grp_1/bulk-invite");
  REQUIRE(request.body.has_value());
  CHECK(*request.body == csv);
  CHECK(content_type_of(request) == "text/csv");
}

TEST_CASE("groups.bulk_invite appends roleId as a query parameter and handles an empty summary") {
  Harness h;
  h.transport->enqueue_json(200, R"({"invited":0,"skipped":0,"errors":[]})");

  const BulkInviteOptions options{.role_id = std::string("role_recruit")};
  const Result<BulkInviteResult> result =
      h.client.groups().bulk_invite("grp_1", "user_1\n", options);
  REQUIRE(result.has_value());
  CHECK(result.value().invited == 0);
  CHECK(result.value().errors.empty());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/bulk-invite?roleId=role_recruit");
}

TEST_CASE("groups.bulk_invite surfaces bad_request when the server rejects the batch") {
  Harness h;
  h.transport->enqueue_json(
      400,
      R"({"code":"bad_request","status":400,"message":"bulk-invite is limited to 1000 rows per request"})");
  const Result<BulkInviteResult> result = h.client.groups().bulk_invite("grp_1", "user_1\n");
  REQUIRE_FALSE(result.has_value());
  CHECK(result.error().code == ErrorCode::BadRequest);
}

TEST_CASE("groups.bulk_invite maps a summary without an errors array to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"invited":1,"skipped":0})");
  const Result<BulkInviteResult> result = h.client.groups().bulk_invite("grp_1", "user_1\n");
  REQUIRE_FALSE(result.has_value());
  CHECK(result.error().code == ErrorCode::InvalidWireData);
}

// ---------------------------------------------------------------------
// relationships
// ---------------------------------------------------------------------

TEST_CASE("groups.set_relationship puts the type, adding mutual only when set") {
  Harness h;
  h.transport->enqueue_json(200, kRelationshipJson);
  const Result<GroupRelationship> set =
      h.client.groups().set_relationship("grp_1", "grp_2", "ally");
  REQUIRE(set.has_value());
  CHECK(set.value().group_a_id == "grp_1");
  CHECK(set.value().group_b_id == "grp_2");
  CHECK(set.value().type == "ally");
  CHECK(set.value().since == "2026-05-01T00:00:00.000Z");
  CHECK_FALSE(set.value().set_by.has_value());
  CHECK(h.transport->last_request().method == "PUT");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/relationships/grp_2");
  CHECK(body_of(h.transport->last_request()) == Json{{"type", "ally"}});

  h.transport->enqueue_json(200, kRelationshipJson);
  const SetRelationshipOptions options{.mutual = true};
  CHECK(h.client.groups().set_relationship("grp_1", "grp_2", "ally", options).has_value());
  CHECK(body_of(h.transport->last_request()) == Json{{"type", "ally"}, {"mutual", true}});
}

TEST_CASE("groups.clear_relationship deletes, with mutual=true only on request") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.groups().clear_relationship("grp_1", "grp_2").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/relationships/grp_2");

  h.transport->enqueue_json(204, "");
  const ClearRelationshipOptions options{.mutual = true};
  CHECK(h.client.groups().clear_relationship("grp_1", "grp_2", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/relationships/grp_2?mutual=true");
}

TEST_CASE("groups.get_relationship maps not_found to an empty optional") {
  Harness h;
  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<std::optional<GroupRelationship>> got =
      h.client.groups().get_relationship("grp_1", "grp_2");
  REQUIRE(got.has_value());
  CHECK_FALSE(got.value().has_value());
}

TEST_CASE("groups.get_relationship returns the row and surfaces non-404 errors") {
  Harness h;
  h.transport->enqueue_json(200, kRelationshipJson);
  const Result<std::optional<GroupRelationship>> got =
      h.client.groups().get_relationship("grp_1", "grp_2");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK(got.value()->type == "ally");

  h.transport->enqueue_json(403, kPermissionDeniedJson);
  const Result<std::optional<GroupRelationship>> denied =
      h.client.groups().get_relationship("grp_1", "grp_2");
  REQUIRE_FALSE(denied.has_value());
  CHECK(denied.error().code == ErrorCode::PermissionDenied);
}

TEST_CASE("groups.list_relationships returns every outgoing row") {
  Harness h;
  const std::string body = std::string("[") + kRelationshipJson + "]";
  h.transport->enqueue_json(200, body);
  const Result<std::vector<GroupRelationship>> rows =
      h.client.groups().list_relationships("grp_1");
  REQUIRE(rows.has_value());
  REQUIRE(rows.value().size() == 1);
  CHECK(rows.value()[0].type == "ally");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/relationships");
}

// ---------------------------------------------------------------------
// sub-groups: set_parent tri-state body, children
// ---------------------------------------------------------------------

TEST_CASE("groups.set_parent always carries parentGroupId: a value to set, null to clear") {
  Harness h;
  h.transport->enqueue_json(200, kGroupJson);
  CHECK(h.client.groups().set_parent("grp_1", std::string("grp_parent")).has_value());
  CHECK(h.transport->last_request().method == "PUT");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/parent");
  CHECK(body_of(h.transport->last_request()) == Json{{"parentGroupId", "grp_parent"}});

  h.transport->enqueue_json(200, kGroupJson);
  CHECK(h.client.groups().set_parent("grp_1", std::nullopt).has_value());
  const Json body = body_of(h.transport->last_request());
  REQUIRE(body.contains("parentGroupId"));
  CHECK(body["parentGroupId"].is_null());
  CHECK(body.size() == 1);
}

TEST_CASE("groups.set_parent surfaces parent_cycle as its typed code") {
  Harness h;
  h.transport->enqueue_json(409, R"({"code":"parent_cycle","status":409,"message":"cycle"})");
  const Result<Group> set = h.client.groups().set_parent("grp_1", std::string("grp_child"));
  REQUIRE_FALSE(set.has_value());
  CHECK(set.error().code == ErrorCode::ParentCycle);
}

TEST_CASE("groups.list_children returns the direct sub-groups") {
  Harness h;
  const std::string body = std::string("[") + kGroupJson + "]";
  h.transport->enqueue_json(200, body);
  const Result<std::vector<Group>> children = h.client.groups().list_children("grp_1");
  REQUIRE(children.has_value());
  REQUIRE(children.value().size() == 1);
  CHECK(children.value()[0].id == "grp_1");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups/grp_1/children");
}

// ---------------------------------------------------------------------
// wire strictness
// ---------------------------------------------------------------------

TEST_CASE("a member response missing required fields maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"id":"mem_1","groupId":"grp_1"})");
  const Result<Member> joined = h.client.groups().join("grp_1", "user_1");
  REQUIRE_FALSE(joined.has_value());
  CHECK(joined.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("a page response without an items array maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"nextCursor":null})");
  const Result<Page<Group>> page = h.client.groups().list();
  REQUIRE_FALSE(page.has_value());
  CHECK(page.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("an integer field above the int64 range maps to InvalidWireData") {
  // 2^63 parses as an unsigned JSON number; accepting it would wrap
  // the value negative instead of rejecting the wire data.
  Harness h;
  std::string body = junjo::test::kGroupJson;
  const std::string needle = "\"memberCount\": 12";
  const std::string::size_type at = body.find(needle);
  REQUIRE(at != std::string::npos);
  body.replace(at, needle.size(), "\"memberCount\": 9223372036854775808");
  h.transport->enqueue_json(200, body);
  const Result<std::optional<Group>> group = h.client.groups().get("grp_1");
  REQUIRE_FALSE(group.has_value());
  CHECK(group.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("groups.list appends the kind filter only when set") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  Result<Page<Group>> listed = h.client.groups().list();
  REQUIRE(listed.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups");

  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  listed = h.client.groups().list({.kind = "instance"});
  REQUIRE(listed.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/groups?kind=instance");
}

TEST_CASE("groups.list percent-encodes the kind filter and orders it after viewer") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const Result<Page<Group>> listed =
      h.client.groups().list({.viewer = "user_1", .kind = "raid team"});
  REQUIRE(listed.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups?viewer=user_1&kind=raid%20team");
}
