// Junjo.io SDK for C++

#include "junjo/types.hpp"

namespace junjo {

namespace {

// Wire string <-> enum tables. One table drives both directions per
// enum so they cannot drift apart (same pattern as error.cpp).

constexpr std::pair<std::string_view, FriendsListVisibility> kVisibilities[]{
    {"private", FriendsListVisibility::Private},
    {"friends-only", FriendsListVisibility::FriendsOnly},
    {"public", FriendsListVisibility::Public},
};

constexpr std::pair<std::string_view, FriendshipState> kFriendshipStates[]{
    {"friends", FriendshipState::Friends},
    {"request_outgoing", FriendshipState::RequestOutgoing},
    {"request_incoming", FriendshipState::RequestIncoming},
    {"blocked_by_me", FriendshipState::BlockedByMe},
    {"blocked_by_them", FriendshipState::BlockedByThem},
    {"none", FriendshipState::None},
};

constexpr std::pair<std::string_view, WebhookFormat> kWebhookFormats[]{
    {"junjo", WebhookFormat::Junjo},
    {"discord", WebhookFormat::Discord},
    {"slack", WebhookFormat::Slack},
};

}  // namespace

std::string_view to_string(FriendsListVisibility visibility) noexcept {
  for (const auto& [wire, mapped] : kVisibilities) {
    if (mapped == visibility) return wire;
  }
  return "unknown";
}

FriendsListVisibility friends_list_visibility_from_wire(std::string_view wire) noexcept {
  for (const auto& [name, mapped] : kVisibilities) {
    if (name == wire) return mapped;
  }
  return FriendsListVisibility::Unknown;
}

std::string_view to_string(FriendshipState state) noexcept {
  for (const auto& [wire, mapped] : kFriendshipStates) {
    if (mapped == state) return wire;
  }
  return "unknown";
}

FriendshipState friendship_state_from_wire(std::string_view wire) noexcept {
  for (const auto& [name, mapped] : kFriendshipStates) {
    if (name == wire) return mapped;
  }
  return FriendshipState::Unknown;
}

std::string_view to_string(WebhookFormat format) noexcept {
  for (const auto& [wire, mapped] : kWebhookFormats) {
    if (mapped == format) return wire;
  }
  return "unknown";
}

WebhookFormat webhook_format_from_wire(std::string_view wire) noexcept {
  for (const auto& [name, mapped] : kWebhookFormats) {
    if (name == wire) return mapped;
  }
  return WebhookFormat::Unknown;
}

std::string_view to_string(FriendRequestStatus status) noexcept {
  return status == FriendRequestStatus::AutoAccepted ? "auto-accepted" : "pending";
}

}  // namespace junjo
