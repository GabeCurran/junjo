// Junjo.io SDK for C++: InvitationsApi domain surface against
// MockTransport: list flags (includeExpired / includeUsed), Page
// cursor passthrough, null-on-404 get, and revoke.
#include <doctest/doctest.h>

#include <optional>
#include <string>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/invitations.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "test_support.hpp"

using junjo::ErrorCode;
using junjo::Invitation;
using junjo::ListInvitationsOptions;
using junjo::Page;
using junjo::Result;
using junjo::test::Harness;
using junjo::test::kInvitationJson;
using junjo::test::kNotFoundJson;

TEST_CASE("invitations.list without options hits the bare collection URL") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const Result<Page<Invitation>> page = h.client.invitations().list("grp_1");
  REQUIRE(page.has_value());
  CHECK(page.value().items.empty());
  CHECK_FALSE(page.value().next_cursor.has_value());
  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/invitations");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("invitations.list encodes limit, cursor, and both include flags") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kInvitationJson + R"(],"nextCursor":"inv_next"})";
  h.transport->enqueue_json(200, body);

  const ListInvitationsOptions options{.limit = 10,
                                       .cursor = std::string("inv_cur"),
                                       .include_expired = true,
                                       .include_used = false};
  const Result<Page<Invitation>> page = h.client.invitations().list("grp_1", options);
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/groups/grp_1/invitations"
        "?limit=10&cursor=inv_cur&includeExpired=true&includeUsed=false");

  REQUIRE(page.value().items.size() == 1);
  const Invitation& invitation = page.value().items[0];
  CHECK(invitation.id == "inv_1");
  CHECK(invitation.group_id == "grp_1");
  CHECK(invitation.code == "a1b2c3d4e5f60708");
  CHECK_FALSE(invitation.role_id.has_value());
  REQUIRE(invitation.target_user_id.has_value());
  CHECK(*invitation.target_user_id == "user_9");
  REQUIRE(invitation.created_by.has_value());
  CHECK(*invitation.created_by == "user_officer");
  CHECK(invitation.created_at == "2026-04-01T00:00:00.000Z");
  REQUIRE(invitation.expires_at.has_value());
  CHECK(*invitation.expires_at == "2026-04-08T00:00:00.000Z");
  CHECK_FALSE(invitation.used_at.has_value());
  CHECK_FALSE(invitation.used_by.has_value());
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "inv_next");
}

TEST_CASE("invitations.get maps not_found to an empty optional") {
  Harness h;
  h.transport->enqueue_json(200, kInvitationJson);
  const Result<std::optional<Invitation>> got = h.client.invitations().get("a1b2c3d4e5f60708");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  CHECK(got.value()->id == "inv_1");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/invitations/a1b2c3d4e5f60708");

  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<std::optional<Invitation>> missing = h.client.invitations().get("nope");
  REQUIRE(missing.has_value());
  CHECK_FALSE(missing.value().has_value());
}

TEST_CASE("invitations.get tolerates unknown fields and a fully-used invitation") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "id": "inv_2",
    "groupId": "grp_1",
    "code": "deadbeefdeadbeef",
    "roleId": "role_1",
    "targetUserId": null,
    "createdBy": null,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "expiresAt": null,
    "usedAt": "2026-04-02T00:00:00.000Z",
    "usedBy": "user_5",
    "futureField": [1, 2]
  })");
  const Result<std::optional<Invitation>> got = h.client.invitations().get("deadbeefdeadbeef");
  REQUIRE(got.has_value());
  REQUIRE(got.value().has_value());
  REQUIRE(got.value()->role_id.has_value());
  CHECK(*got.value()->role_id == "role_1");
  CHECK_FALSE(got.value()->target_user_id.has_value());
  CHECK_FALSE(got.value()->expires_at.has_value());
  REQUIRE(got.value()->used_at.has_value());
  REQUIRE(got.value()->used_by.has_value());
  CHECK(*got.value()->used_by == "user_5");
}

TEST_CASE("invitations.revoke deletes the encoded code and succeeds on 204") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.invitations().revoke("code with space").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/invitations/code%20with%20space");
  CHECK_FALSE(h.transport->last_request().body.has_value());
}

TEST_CASE("an invitation missing its code maps to InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(200, R"({"id":"inv_3","groupId":"grp_1"})");
  const Result<std::optional<Invitation>> got = h.client.invitations().get("whatever");
  REQUIRE_FALSE(got.has_value());
  CHECK(got.error().code == ErrorCode::InvalidWireData);
}
