// Junjo.io SDK for C++: FriendsApi domain surface against
// MockTransport: the requests / blocks / tags / visibility
// sub-surfaces, friendship listing and removal, the relationship
// probe's state-not-404 contract, and suggestions.
#include <doctest/doctest.h>

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <junjo/client.hpp>
#include <junjo/error.hpp>
#include <junjo/friends.hpp>
#include <junjo/result.hpp>
#include <junjo/types.hpp>

#include "json.hpp"
#include "test_support.hpp"

using junjo::Block;
using junjo::CreateFriendTagInput;
using junjo::ErrorCode;
using junjo::FriendRequestList;
using junjo::FriendRequestSendResult;
using junjo::FriendRequestStatus;
using junjo::FriendshipRelationship;
using junjo::FriendshipState;
using junjo::FriendsListVisibility;
using junjo::FriendSuggestion;
using junjo::FriendSuggestionsOptions;
using junjo::FriendTag;
using junjo::FriendTagAssignment;
using junjo::Friendship;
using junjo::ListFriendRequestsOptions;
using junjo::ListFriendsOptions;
using junjo::Page;
using junjo::Patch;
using junjo::Result;
using junjo::UpdateFriendTagInput;
using junjo::UserVisibilitySettings;
using junjo::detail::Json;
using junjo::test::body_of;
using junjo::test::Harness;
using junjo::test::kBlockJson;
using junjo::test::kFriendRequestJson;
using junjo::test::kFriendTagJson;
using junjo::test::kFriendshipJson;
using junjo::test::kNotFoundJson;
using junjo::test::kSuggestionJson;
using junjo::test::kVisibilityJson;

// ---------------------------------------------------------------------
// requests()
// ---------------------------------------------------------------------

TEST_CASE("friends.requests.list hits the collection URL and splits directions") {
  Harness h;
  const std::string body = std::string(R"({"inbound":[)") + kFriendRequestJson +
                           R"(],"outbound":[]})";
  h.transport->enqueue_json(200, body);
  const Result<FriendRequestList> list = h.client.friends().requests().list("user_1");
  REQUIRE(list.has_value());
  CHECK(h.transport->last_request().method == "GET");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friend-requests");
  REQUIRE(list.value().inbound.size() == 1);
  CHECK(list.value().outbound.empty());
  CHECK(list.value().inbound[0].id == "rel_1");
  CHECK(list.value().inbound[0].actor_user_id == "user_1");
  CHECK(list.value().inbound[0].target_user_id == "user_2");
  CHECK(list.value().inbound[0].created_at == "2026-06-01T00:00:00.000Z");
}

TEST_CASE("friends.requests.list encodes the direction filter") {
  Harness h;
  h.transport->enqueue_json(200, R"({"inbound":[],"outbound":[]})");
  const ListFriendRequestsOptions options{.direction = std::string("in")};
  REQUIRE(h.client.friends().requests().list("user_1", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friend-requests?direction=in");
}

TEST_CASE("friends.requests.send POSTs the target and maps a pending result") {
  Harness h;
  const std::string body =
      std::string(R"({"status":"pending","request":)") + kFriendRequestJson + "}";
  h.transport->enqueue_json(201, body);
  const Result<FriendRequestSendResult> sent =
      h.client.friends().requests().send("user_1", "user_2");
  REQUIRE(sent.has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friend-requests");
  CHECK(body_of(h.transport->last_request()) ==
        Json::parse(R"({"targetJunjoUserId":"user_2"})"));
  CHECK(sent.value().status == FriendRequestStatus::Pending);
  REQUIRE(sent.value().request.has_value());
  CHECK(sent.value().request->id == "rel_1");
  CHECK_FALSE(sent.value().friendship.has_value());
}

TEST_CASE("friends.requests.send maps an auto-accepted result to the friendship") {
  Harness h;
  const std::string body =
      std::string(R"({"status":"auto-accepted","friendship":)") + kFriendshipJson + "}";
  h.transport->enqueue_json(201, body);
  const Result<FriendRequestSendResult> sent =
      h.client.friends().requests().send("user_1", "user_2");
  REQUIRE(sent.has_value());
  CHECK(sent.value().status == FriendRequestStatus::AutoAccepted);
  CHECK_FALSE(sent.value().request.has_value());
  REQUIRE(sent.value().friendship.has_value());
  CHECK(sent.value().friendship->user_id == "user_2");
  CHECK(sent.value().friendship->since == "2026-06-02T00:00:00.000Z");
}

TEST_CASE("friends.requests.send rejects an unknown status as InvalidWireData") {
  Harness h;
  h.transport->enqueue_json(201, R"({"status":"deferred"})");
  const Result<FriendRequestSendResult> sent =
      h.client.friends().requests().send("user_1", "user_2");
  REQUIRE_FALSE(sent.has_value());
  CHECK(sent.error().code == ErrorCode::InvalidWireData);
}

TEST_CASE("friends.requests accept / decline / cancel hit the request routes bodiless") {
  Harness h;
  h.transport->enqueue_json(200, kFriendshipJson);
  const Result<Friendship> accepted = h.client.friends().requests().accept("rel_1");
  REQUIRE(accepted.has_value());
  CHECK(accepted.value().id == "rel_2");
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/friend-requests/rel_1/accept");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(204, "");
  CHECK(h.client.friends().requests().decline("rel_1").has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/friend-requests/rel_1/decline");
  CHECK_FALSE(h.transport->last_request().body.has_value());

  h.transport->enqueue_json(204, "");
  CHECK(h.client.friends().requests().cancel("rel with space").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/friend-requests/rel%20with%20space");
}

// ---------------------------------------------------------------------
// top-level list / remove / relationship / suggestions
// ---------------------------------------------------------------------

TEST_CASE("friends.list hits the friends URL and deserializes the page") {
  Harness h;
  const std::string body =
      std::string(R"({"items":[)") + kFriendshipJson + R"(],"nextCursor":"cur_1"})";
  h.transport->enqueue_json(200, body);
  const Result<Page<Friendship>> page = h.client.friends().list("user_1");
  REQUIRE(page.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/users/user_1/friends");
  REQUIRE(page.value().items.size() == 1);
  CHECK(page.value().items[0].user_id == "user_2");
  REQUIRE(page.value().next_cursor.has_value());
  CHECK(*page.value().next_cursor == "cur_1");
}

TEST_CASE("friends.list encodes limit, cursor, tagId, and viewer") {
  Harness h;
  h.transport->enqueue_json(200, R"({"items":[],"nextCursor":null})");
  const ListFriendsOptions options{.limit = 10,
                                   .cursor = std::string("cur_0"),
                                   .tag_id = std::string("tag_1"),
                                   .viewer = std::string("user_9")};
  REQUIRE(h.client.friends().list("user_1", options).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friends"
        "?limit=10&cursor=cur_0&tagId=tag_1&viewer=user_9");
}

TEST_CASE("friends.remove DELETEs the pair path") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.friends().remove("user_1", "user 2").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friends/user%202");
}

TEST_CASE("friends.get_relationship returns the state instead of null-on-404") {
  Harness h;
  h.transport->enqueue_json(200, R"({"state":"friends","since":"2026-06-02T00:00:00.000Z"})");
  const Result<FriendshipRelationship> probe =
      h.client.friends().get_relationship("user_1", "user_2");
  REQUIRE(probe.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friends/user_2/relationship");
  CHECK(probe.value().state == FriendshipState::Friends);
  REQUIRE(probe.value().since.has_value());
  CHECK(*probe.value().since == "2026-06-02T00:00:00.000Z");

  // "No relationship" is a successful state, not an empty optional.
  h.transport->enqueue_json(200, R"({"state":"none","since":null})");
  const Result<FriendshipRelationship> none =
      h.client.friends().get_relationship("user_1", "user_stranger");
  REQUIRE(none.has_value());
  CHECK(none.value().state == FriendshipState::None);
  CHECK_FALSE(none.value().since.has_value());

  // An actual 404 (friends feature disabled) stays an error.
  h.transport->enqueue_json(404, kNotFoundJson);
  const Result<FriendshipRelationship> off =
      h.client.friends().get_relationship("user_1", "user_2");
  REQUIRE_FALSE(off.has_value());
  CHECK(off.error().code == ErrorCode::NotFound);
}

TEST_CASE("friends.get_relationship maps every wire state, unknown included") {
  Harness h;
  const std::pair<const char*, FriendshipState> cases[] = {
      {"request_outgoing", FriendshipState::RequestOutgoing},
      {"request_incoming", FriendshipState::RequestIncoming},
      {"blocked_by_me", FriendshipState::BlockedByMe},
      {"blocked_by_them", FriendshipState::BlockedByThem},
      {"soulmates", FriendshipState::Unknown},
  };
  for (const auto& [wire, expected] : cases) {
    h.transport->enqueue_json(
        200, std::string(R"({"state":")") + wire + R"(","since":null})");
    const Result<FriendshipRelationship> probe =
        h.client.friends().get_relationship("user_1", "user_2");
    REQUIRE(probe.has_value());
    CHECK(probe.value().state == expected);
  }
}

TEST_CASE("friends.suggestions unwraps items and encodes the limit") {
  Harness h;
  const std::string body = std::string(R"({"items":[)") + kSuggestionJson + "]}";
  h.transport->enqueue_json(200, body);
  const FriendSuggestionsOptions options{.limit = 5};
  const Result<std::vector<FriendSuggestion>> suggestions =
      h.client.friends().suggestions("user_1", options);
  REQUIRE(suggestions.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friends/suggestions?limit=5");
  REQUIRE(suggestions.value().size() == 1);
  CHECK(suggestions.value()[0].user_id == "user_9");
  CHECK(suggestions.value()[0].mutual_count == 4);
  CHECK(suggestions.value()[0].sample_mutual_user_ids ==
        std::vector<std::string>{"user_2", "user_3"});
}

// ---------------------------------------------------------------------
// blocks()
// ---------------------------------------------------------------------

TEST_CASE("friends.blocks list / add / remove wire shapes") {
  Harness h;
  const std::string list_body = std::string(R"({"items":[)") + kBlockJson + "]}";
  h.transport->enqueue_json(200, list_body);
  const Result<std::vector<Block>> blocks = h.client.friends().blocks().list("user_1");
  REQUIRE(blocks.has_value());
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/users/user_1/blocks");
  REQUIRE(blocks.value().size() == 1);
  CHECK(blocks.value()[0].user_id == "user_3");
  CHECK(blocks.value()[0].blocked_at == "2026-06-03T00:00:00.000Z");

  h.transport->enqueue_json(201, kBlockJson);
  const Result<Block> added = h.client.friends().blocks().add("user_1", "user_3");
  REQUIRE(added.has_value());
  CHECK(h.transport->last_request().method == "POST");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/users/user_1/blocks");
  CHECK(body_of(h.transport->last_request()) ==
        Json::parse(R"({"targetJunjoUserId":"user_3"})"));

  h.transport->enqueue_json(204, "");
  CHECK(h.client.friends().blocks().remove("user_1", "user_3").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/blocks/user_3");
}

// ---------------------------------------------------------------------
// tags()
// ---------------------------------------------------------------------

TEST_CASE("friends.tags.list unwraps items") {
  Harness h;
  const std::string body = std::string(R"({"items":[)") + kFriendTagJson + "]}";
  h.transport->enqueue_json(200, body);
  const Result<std::vector<FriendTag>> tags = h.client.friends().tags().list("user_1");
  REQUIRE(tags.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friend-tags");
  REQUIRE(tags.value().size() == 1);
  CHECK(tags.value()[0].name == "raid buddies");
  REQUIRE(tags.value()[0].color.has_value());
  CHECK(*tags.value()[0].color == "#ff5050");
}

TEST_CASE("friends.tags.create POSTs the name and optional color") {
  Harness h;
  h.transport->enqueue_json(201, kFriendTagJson);
  const CreateFriendTagInput input{.name = "raid buddies", .color = std::string("#ff5050")};
  REQUIRE(h.client.friends().tags().create("user_1", input).has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friend-tags");
  CHECK(body_of(h.transport->last_request()) ==
        Json::parse(R"({"name":"raid buddies","color":"#ff5050"})"));

  h.transport->enqueue_json(201, kFriendTagJson);
  const CreateFriendTagInput bare{.name = "pvp"};
  REQUIRE(h.client.friends().tags().create("user_1", bare).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"name":"pvp"})"));
}

TEST_CASE("friends.tags.update sends a rename, a color clear as null, and omits untouched") {
  Harness h;
  h.transport->enqueue_json(200, kFriendTagJson);
  UpdateFriendTagInput rename;
  rename.name = std::string("raiders");
  REQUIRE(h.client.friends().tags().update("tag_1", rename).has_value());
  CHECK(h.transport->last_request().method == "PATCH");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/friend-tags/tag_1");
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"name":"raiders"})"));

  h.transport->enqueue_json(200, kFriendTagJson);
  UpdateFriendTagInput clear_color;
  clear_color.color = Patch<std::string>::clear();
  REQUIRE(h.client.friends().tags().update("tag_1", clear_color).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"color":null})"));

  h.transport->enqueue_json(200, kFriendTagJson);
  UpdateFriendTagInput recolor;
  recolor.color = std::string("#00ff00");
  REQUIRE(h.client.friends().tags().update("tag_1", recolor).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"color":"#00ff00"})"));
}

TEST_CASE("friends.tags.remove DELETEs the tag and assign PUTs the full set") {
  Harness h;
  h.transport->enqueue_json(204, "");
  CHECK(h.client.friends().tags().remove("tag_1").has_value());
  CHECK(h.transport->last_request().method == "DELETE");
  CHECK(h.transport->last_request().url == "https://api.junjo.io/v1/friend-tags/tag_1");

  h.transport->enqueue_json(200, R"({"friendJunjoUserId":"user_2","tagIds":["tag_1","tag_2"]})");
  const Result<FriendTagAssignment> assigned =
      h.client.friends().tags().assign("user_1", "user_2", {"tag_1", "tag_2"});
  REQUIRE(assigned.has_value());
  CHECK(h.transport->last_request().method == "PUT");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/friends/user_2/tags");
  CHECK(body_of(h.transport->last_request()) ==
        Json::parse(R"({"tagIds":["tag_1","tag_2"]})"));
  CHECK(assigned.value().friend_user_id == "user_2");
  CHECK(assigned.value().tag_ids == std::vector<std::string>{"tag_1", "tag_2"});

  // Clearing every tag is an explicit empty array, not an omission.
  h.transport->enqueue_json(200, R"({"friendJunjoUserId":"user_2","tagIds":[]})");
  REQUIRE(h.client.friends().tags().assign("user_1", "user_2", {}).has_value());
  CHECK(body_of(h.transport->last_request()) == Json::parse(R"({"tagIds":[]})"));
}

// ---------------------------------------------------------------------
// visibility()
// ---------------------------------------------------------------------

TEST_CASE("friends.visibility.get maps the settings including the allowed list") {
  Harness h;
  h.transport->enqueue_json(200, kVisibilityJson);
  const Result<UserVisibilitySettings> settings =
      h.client.friends().visibility().get("user_1");
  REQUIRE(settings.has_value());
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/visibility");
  CHECK(settings.value().game_id == "game_1");
  CHECK(settings.value().user_id == "user_1");
  CHECK(settings.value().friends_list_visibility == FriendsListVisibility::FriendsOnly);
  CHECK(settings.value().allowed ==
        std::vector<FriendsListVisibility>{FriendsListVisibility::Private,
                                           FriendsListVisibility::FriendsOnly,
                                           FriendsListVisibility::Public});
  REQUIRE(settings.value().updated_at.has_value());
  CHECK(*settings.value().updated_at == "2026-06-05T00:00:00.000Z");
}

TEST_CASE("friends.visibility.get maps unknown wire levels to Unknown instead of failing") {
  Harness h;
  h.transport->enqueue_json(200, R"({
    "gameId": "game_1",
    "junjoUserId": "user_1",
    "friendsListVisibility": "mutuals-of-mutuals",
    "allowed": ["private", "mutuals-of-mutuals"],
    "updatedAt": null
  })");
  const Result<UserVisibilitySettings> settings =
      h.client.friends().visibility().get("user_1");
  REQUIRE(settings.has_value());
  CHECK(settings.value().friends_list_visibility == FriendsListVisibility::Unknown);
  CHECK(settings.value().allowed ==
        std::vector<FriendsListVisibility>{FriendsListVisibility::Private,
                                           FriendsListVisibility::Unknown});
  CHECK_FALSE(settings.value().updated_at.has_value());
}

TEST_CASE("friends.visibility.set PATCHes the wire string for the level") {
  Harness h;
  h.transport->enqueue_json(200, kVisibilityJson);
  REQUIRE(h.client.friends()
              .visibility()
              .set("user_1", FriendsListVisibility::FriendsOnly)
              .has_value());
  CHECK(h.transport->last_request().method == "PATCH");
  CHECK(h.transport->last_request().url ==
        "https://api.junjo.io/v1/users/user_1/visibility");
  CHECK(body_of(h.transport->last_request()) ==
        Json::parse(R"({"friendsListVisibility":"friends-only"})"));
}

TEST_CASE("friends.visibility.set rejects Unknown client-side with InvalidConfig") {
  Harness h;
  const Result<UserVisibilitySettings> rejected =
      h.client.friends().visibility().set("user_1", FriendsListVisibility::Unknown);
  REQUIRE_FALSE(rejected.has_value());
  CHECK(rejected.error().code == ErrorCode::InvalidConfig);
  CHECK(h.transport->request_count() == 0);
}
