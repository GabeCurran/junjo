// Junjo.io SDK for C++: public enum wire-mapping helpers: round-trips
// for every known value and the documented Unknown fallbacks.
#include <doctest/doctest.h>

#include <string_view>
#include <utility>

#include <junjo/types.hpp>

using junjo::FriendRequestStatus;
using junjo::friends_list_visibility_from_wire;
using junjo::friendship_state_from_wire;
using junjo::FriendshipState;
using junjo::FriendsListVisibility;
using junjo::to_string;
using junjo::webhook_format_from_wire;
using junjo::WebhookFormat;

TEST_CASE("FriendsListVisibility round-trips its wire strings") {
  const std::pair<FriendsListVisibility, std::string_view> cases[] = {
      {FriendsListVisibility::Private, "private"},
      {FriendsListVisibility::FriendsOnly, "friends-only"},
      {FriendsListVisibility::Public, "public"},
  };
  for (const auto& [value, wire] : cases) {
    CHECK(to_string(value) == wire);
    CHECK(friends_list_visibility_from_wire(wire) == value);
  }
}

TEST_CASE("FriendsListVisibility maps unknown wire values to Unknown, not a real level") {
  CHECK(friends_list_visibility_from_wire("mutuals-only") == FriendsListVisibility::Unknown);
  CHECK(friends_list_visibility_from_wire("") == FriendsListVisibility::Unknown);
  CHECK(friends_list_visibility_from_wire("PRIVATE") == FriendsListVisibility::Unknown);
  CHECK(to_string(FriendsListVisibility::Unknown) == "unknown");
  // "unknown" is not a wire value; it must NOT round-trip to a level.
  CHECK(friends_list_visibility_from_wire("unknown") == FriendsListVisibility::Unknown);
}

TEST_CASE("FriendshipState round-trips its wire strings") {
  const std::pair<FriendshipState, std::string_view> cases[] = {
      {FriendshipState::Friends, "friends"},
      {FriendshipState::RequestOutgoing, "request_outgoing"},
      {FriendshipState::RequestIncoming, "request_incoming"},
      {FriendshipState::BlockedByMe, "blocked_by_me"},
      {FriendshipState::BlockedByThem, "blocked_by_them"},
      {FriendshipState::None, "none"},
  };
  for (const auto& [value, wire] : cases) {
    CHECK(to_string(value) == wire);
    CHECK(friendship_state_from_wire(wire) == value);
  }
}

TEST_CASE("FriendshipState maps unknown wire values to Unknown") {
  CHECK(friendship_state_from_wire("soulmates") == FriendshipState::Unknown);
  CHECK(friendship_state_from_wire("") == FriendshipState::Unknown);
  CHECK(to_string(FriendshipState::Unknown) == "unknown");
}

TEST_CASE("WebhookFormat round-trips its wire strings") {
  const std::pair<WebhookFormat, std::string_view> cases[] = {
      {WebhookFormat::Junjo, "junjo"},
      {WebhookFormat::Discord, "discord"},
      {WebhookFormat::Slack, "slack"},
  };
  for (const auto& [value, wire] : cases) {
    CHECK(to_string(value) == wire);
    CHECK(webhook_format_from_wire(wire) == value);
  }
}

TEST_CASE("WebhookFormat maps unknown wire values to Unknown") {
  CHECK(webhook_format_from_wire("teams") == WebhookFormat::Unknown);
  CHECK(webhook_format_from_wire("") == WebhookFormat::Unknown);
  CHECK(to_string(WebhookFormat::Unknown) == "unknown");
}

TEST_CASE("FriendRequestStatus names its two closed states") {
  CHECK(to_string(FriendRequestStatus::Pending) == "pending");
  CHECK(to_string(FriendRequestStatus::AutoAccepted) == "auto-accepted");
}
