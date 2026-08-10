// Junjo.io SDK for C++: shared test support for the domain-surface
// suites: a Client-over-MockTransport harness, canonical wire
// fixtures, and body helpers. Test-only; never installed.
#pragma once

#include <doctest/doctest.h>

#include <memory>
#include <string>
#include <utility>

#include <junjo/client.hpp>
#include <junjo/result.hpp>

#include "json.hpp"
#include "mock_transport.hpp"

namespace junjo::test {

inline constexpr const char* kTestKey = "jk_test.secret";

// A Client wired to a scripted MockTransport.
struct Harness {
  std::shared_ptr<MockTransport> transport = std::make_shared<MockTransport>();
  Client client;

  explicit Harness(ClientConfig config = {}) : client(make_client(std::move(config), transport)) {}

 private:
  static Client make_client(ClientConfig config, std::shared_ptr<MockTransport> transport) {
    if (config.api_key.empty()) config.api_key = kTestKey;
    config.transport = std::move(transport);
    Result<Client> created = Client::create(std::move(config));
    REQUIRE(created.has_value());
    return std::move(created).value();
  }
};

// Parses the recorded request body as JSON, failing the test when the
// request carried none. Comparing parsed values is an exact structural
// check (null vs absent included) without depending on key order.
[[nodiscard]] inline detail::Json body_of(const HttpRequest& request) {
  REQUIRE(request.body.has_value());
  detail::Json parsed = detail::Json::parse(*request.body, nullptr, false);
  REQUIRE_FALSE(parsed.is_discarded());
  return parsed;
}

// Canonical wire fixtures matching the server serializers.

inline constexpr const char* kGroupJson = R"({
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

inline constexpr const char* kMemberJson = R"({
  "id": "mem_1",
  "groupId": "grp_1",
  "userId": "user_1",
  "status": "active",
  "roles": ["role_1", "role_2"],
  "metadata": {"rank": 3},
  "notesPublic": "reliable tank",
  "notesPrivate": null,
  "joinedAt": "2026-03-01T00:00:00.000Z",
  "bannedUntil": null
})";

inline constexpr const char* kRoleJson = R"({
  "id": "role_1",
  "groupId": "grp_1",
  "name": "Officer",
  "priority": 10,
  "color": "#ff5050",
  "isDefault": false,
  "permissions": ["invite_member", "kick_member"],
  "createdAt": "2026-01-15T00:00:00.000Z"
})";

inline constexpr const char* kInvitationJson = R"({
  "id": "inv_1",
  "groupId": "grp_1",
  "code": "a1b2c3d4e5f60708",
  "roleId": null,
  "targetUserId": "user_9",
  "createdBy": "user_officer",
  "createdAt": "2026-04-01T00:00:00.000Z",
  "expiresAt": "2026-04-08T00:00:00.000Z",
  "usedAt": null,
  "usedBy": null
})";

inline constexpr const char* kRelationshipJson = R"({
  "groupAId": "grp_1",
  "groupBId": "grp_2",
  "type": "ally",
  "since": "2026-05-01T00:00:00.000Z",
  "setBy": null
})";

inline constexpr const char* kOverrideJson = R"({
  "groupId": "grp_1",
  "userId": "user_1",
  "permission": "claim_territory",
  "grant": true,
  "setAt": "2026-05-02T00:00:00.000Z",
  "setBy": "user_mod"
})";

inline constexpr const char* kBanHistoryEntryJson = R"({
  "id": "bh_1",
  "gameId": "game_1",
  "userId": "user_1",
  "scope": "group",
  "groupId": "grp_1",
  "kind": "set",
  "reason": "griefing",
  "expiresAt": null,
  "eventAt": "2026-06-01T00:00:00.000Z",
  "actorUserId": "user_mod"
})";

inline constexpr const char* kBanJson = R"({
  "id": "ban_1",
  "gameId": "game_1",
  "userId": "user_1",
  "bannedAt": "2026-06-01T00:00:00.000Z",
  "expiresAt": "2026-07-01T00:00:00.000Z",
  "reason": "griefing",
  "bannedBy": "user_mod"
})";

inline constexpr const char* kFriendRequestJson = R"({
  "id": "rel_1",
  "gameId": "game_1",
  "actorJunjoUserId": "user_1",
  "targetJunjoUserId": "user_2",
  "createdAt": "2026-06-01T00:00:00.000Z"
})";

inline constexpr const char* kFriendshipJson = R"({
  "id": "rel_2",
  "gameId": "game_1",
  "junjoUserId": "user_2",
  "since": "2026-06-02T00:00:00.000Z"
})";

inline constexpr const char* kBlockJson = R"({
  "id": "rel_3",
  "gameId": "game_1",
  "junjoUserId": "user_3",
  "blockedAt": "2026-06-03T00:00:00.000Z"
})";

inline constexpr const char* kFriendTagJson = R"({
  "id": "tag_1",
  "gameId": "game_1",
  "junjoUserId": "user_1",
  "name": "raid buddies",
  "color": "#ff5050",
  "createdAt": "2026-06-04T00:00:00.000Z"
})";

inline constexpr const char* kVisibilityJson = R"({
  "gameId": "game_1",
  "junjoUserId": "user_1",
  "friendsListVisibility": "friends-only",
  "allowed": ["private", "friends-only", "public"],
  "updatedAt": "2026-06-05T00:00:00.000Z"
})";

inline constexpr const char* kSuggestionJson = R"({
  "junjoUserId": "user_9",
  "mutualCount": 4,
  "sampleMutualJunjoUserIds": ["user_2", "user_3"]
})";

inline constexpr const char* kAuditEntryJson = R"({
  "id": "aud_1",
  "groupId": "grp_1",
  "actorUserId": "user_mod",
  "action": "member.kicked",
  "targetId": "user_1",
  "payload": {"reason": "afk"},
  "createdAt": "2026-06-06T00:00:00.000Z"
})";

inline constexpr const char* kWebhookEndpointJson = R"({
  "id": "whe_1",
  "gameId": "game_1",
  "url": "https://dev.example.com/hook",
  "events": ["member.joined"],
  "format": "junjo",
  "createdAt": "2026-04-28T05:00:00.000Z",
  "disabledAt": null
})";

inline constexpr const char* kNotFoundJson =
    R"({"code":"not_found","status":404,"message":"no such thing"})";

inline constexpr const char* kPermissionDeniedJson =
    R"({"code":"permission_denied","status":403,"message":"not yours"})";

}  // namespace junjo::test
