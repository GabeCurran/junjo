// Junjo.io SDK for C++

#include "junjo/friends.hpp"

#include <utility>

#include "junjo/error.hpp"

#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

namespace {

using detail::Json;

[[nodiscard]] std::string user_path(std::string_view user_id) {
  return "/v1/users/" + detail::percent_encode(user_id);
}

[[nodiscard]] std::string friend_request_path(std::string_view request_id) {
  return "/v1/friend-requests/" + detail::percent_encode(request_id);
}

}  // namespace

// ---------------------------------------------------------------------
// FriendRequestsApi
// ---------------------------------------------------------------------

FriendRequestsApi::FriendRequestsApi(
    std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<FriendRequestList> FriendRequestsApi::list(std::string_view user_id,
                                                  const ListFriendRequestsOptions& options,
                                                  const CancellationToken& token) const {
  std::string path = user_path(user_id) + "/friend-requests";
  if (options.direction.has_value()) {
    path += detail::build_query({{"direction", *options.direction}});
  }
  return detail::to_value<FriendRequestList>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_friend_request_list);
}

Result<FriendRequestSendResult> FriendRequestsApi::send(std::string_view user_id,
                                                        std::string_view target_user_id,
                                                        const RequestOptions& options,
                                                        const CancellationToken& token) const {
  Json body = Json::object();
  // Historical wire name; the value is the target's external user id.
  body["targetJunjoUserId"] = std::string(target_user_id);
  return detail::to_value<FriendRequestSendResult>(
      executor_->execute_json("POST", user_path(user_id) + "/friend-requests", body, token,
                              options.timeout),
      detail::deserialize_friend_request_send_result);
}

Result<Friendship> FriendRequestsApi::accept(std::string_view request_id,
                                             const RequestOptions& options,
                                             const CancellationToken& token) const {
  return detail::to_value<Friendship>(
      executor_->execute_json("POST", friend_request_path(request_id) + "/accept", std::nullopt,
                              token, options.timeout),
      detail::deserialize_friendship);
}

Result<void> FriendRequestsApi::decline(std::string_view request_id,
                                        const RequestOptions& options,
                                        const CancellationToken& token) const {
  return detail::to_void(executor_->execute_json("POST", friend_request_path(request_id) +
                                                             "/decline",
                                                 std::nullopt, token, options.timeout));
}

Result<void> FriendRequestsApi::cancel(std::string_view request_id,
                                       const RequestOptions& options,
                                       const CancellationToken& token) const {
  return detail::to_void(executor_->execute_json("DELETE", friend_request_path(request_id),
                                                 std::nullopt, token, options.timeout));
}

// ---------------------------------------------------------------------
// BlocksApi
// ---------------------------------------------------------------------

BlocksApi::BlocksApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<std::vector<Block>> BlocksApi::list(std::string_view user_id,
                                           const RequestOptions& options,
                                           const CancellationToken& token) const {
  return detail::to_items_array<Block>(
      executor_->execute_json("GET", user_path(user_id) + "/blocks", std::nullopt, token,
                              options.timeout),
      detail::deserialize_block);
}

Result<Block> BlocksApi::add(std::string_view user_id, std::string_view target_user_id,
                             const RequestOptions& options,
                             const CancellationToken& token) const {
  Json body = Json::object();
  body["targetJunjoUserId"] = std::string(target_user_id);
  return detail::to_value<Block>(
      executor_->execute_json("POST", user_path(user_id) + "/blocks", body, token,
                              options.timeout),
      detail::deserialize_block);
}

Result<void> BlocksApi::remove(std::string_view user_id, std::string_view other_user_id,
                               const RequestOptions& options,
                               const CancellationToken& token) const {
  const std::string path =
      user_path(user_id) + "/blocks/" + detail::percent_encode(other_user_id);
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

// ---------------------------------------------------------------------
// FriendTagsApi
// ---------------------------------------------------------------------

FriendTagsApi::FriendTagsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<std::vector<FriendTag>> FriendTagsApi::list(std::string_view user_id,
                                                   const RequestOptions& options,
                                                   const CancellationToken& token) const {
  return detail::to_items_array<FriendTag>(
      executor_->execute_json("GET", user_path(user_id) + "/friend-tags", std::nullopt, token,
                              options.timeout),
      detail::deserialize_friend_tag);
}

Result<FriendTag> FriendTagsApi::create(std::string_view user_id,
                                        const CreateFriendTagInput& input,
                                        const RequestOptions& options,
                                        const CancellationToken& token) const {
  Json body = Json::object();
  body["name"] = input.name;
  if (input.color.has_value()) body["color"] = *input.color;
  return detail::to_value<FriendTag>(
      executor_->execute_json("POST", user_path(user_id) + "/friend-tags", body, token,
                              options.timeout),
      detail::deserialize_friend_tag);
}

Result<FriendTag> FriendTagsApi::update(std::string_view tag_id,
                                        const UpdateFriendTagInput& input,
                                        const RequestOptions& options,
                                        const CancellationToken& token) const {
  Json body = Json::object();
  if (input.name.has_value()) body["name"] = *input.name;
  detail::apply_patch(body, "color", input.color);
  const std::string path = "/v1/friend-tags/" + detail::percent_encode(tag_id);
  return detail::to_value<FriendTag>(
      executor_->execute_json("PATCH", path, body, token, options.timeout),
      detail::deserialize_friend_tag);
}

Result<void> FriendTagsApi::remove(std::string_view tag_id, const RequestOptions& options,
                                   const CancellationToken& token) const {
  const std::string path = "/v1/friend-tags/" + detail::percent_encode(tag_id);
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

Result<FriendTagAssignment> FriendTagsApi::assign(std::string_view user_id,
                                                  std::string_view other_user_id,
                                                  const std::vector<std::string>& tag_ids,
                                                  const RequestOptions& options,
                                                  const CancellationToken& token) const {
  Json body = Json::object();
  body["tagIds"] = tag_ids;
  const std::string path =
      user_path(user_id) + "/friends/" + detail::percent_encode(other_user_id) + "/tags";
  return detail::to_value<FriendTagAssignment>(
      executor_->execute_json("PUT", path, body, token, options.timeout),
      detail::deserialize_friend_tag_assignment);
}

// ---------------------------------------------------------------------
// FriendVisibilityApi
// ---------------------------------------------------------------------

FriendVisibilityApi::FriendVisibilityApi(
    std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<UserVisibilitySettings> FriendVisibilityApi::get(std::string_view user_id,
                                                        const RequestOptions& options,
                                                        const CancellationToken& token) const {
  return detail::to_value<UserVisibilitySettings>(
      executor_->execute_json("GET", user_path(user_id) + "/visibility", std::nullopt, token,
                              options.timeout),
      detail::deserialize_user_visibility_settings);
}

Result<UserVisibilitySettings> FriendVisibilityApi::set(std::string_view user_id,
                                                        FriendsListVisibility visibility,
                                                        const RequestOptions& options,
                                                        const CancellationToken& token) const {
  // Unknown exists only so newer server VALUES deserialize; it has no
  // wire spelling of its own and is rejected before any request.
  if (visibility == FriendsListVisibility::Unknown) {
    return Error{.code = ErrorCode::InvalidConfig,
                 .message = "FriendsListVisibility::Unknown cannot be sent; pick Private, "
                            "FriendsOnly, or Public"};
  }
  Json body = Json::object();
  body["friendsListVisibility"] = std::string(to_string(visibility));
  return detail::to_value<UserVisibilitySettings>(
      executor_->execute_json("PATCH", user_path(user_id) + "/visibility", body, token,
                              options.timeout),
      detail::deserialize_user_visibility_settings);
}

// ---------------------------------------------------------------------
// FriendsApi
// ---------------------------------------------------------------------

FriendsApi::FriendsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

FriendRequestsApi FriendsApi::requests() const noexcept { return FriendRequestsApi(executor_); }

BlocksApi FriendsApi::blocks() const noexcept { return BlocksApi(executor_); }

FriendTagsApi FriendsApi::tags() const noexcept { return FriendTagsApi(executor_); }

FriendVisibilityApi FriendsApi::visibility() const noexcept {
  return FriendVisibilityApi(executor_);
}

Result<Page<Friendship>> FriendsApi::list(std::string_view user_id,
                                          const ListFriendsOptions& options,
                                          const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);
  if (options.tag_id.has_value()) params.emplace_back("tagId", *options.tag_id);
  if (options.viewer.has_value()) params.emplace_back("viewer", *options.viewer);

  const std::string path = user_path(user_id) + "/friends" + detail::build_query(params);
  return detail::to_page<Friendship>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_friendship);
}

Result<void> FriendsApi::remove(std::string_view user_id, std::string_view other_user_id,
                                const RequestOptions& options,
                                const CancellationToken& token) const {
  const std::string path =
      user_path(user_id) + "/friends/" + detail::percent_encode(other_user_id);
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

Result<FriendshipRelationship> FriendsApi::get_relationship(std::string_view viewer_user_id,
                                                            std::string_view other_user_id,
                                                            const RequestOptions& options,
                                                            const CancellationToken& token) const {
  const std::string path = user_path(viewer_user_id) + "/friends/" +
                           detail::percent_encode(other_user_id) + "/relationship";
  return detail::to_value<FriendshipRelationship>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_friendship_relationship);
}

Result<std::vector<FriendSuggestion>> FriendsApi::suggestions(
    std::string_view user_id, const FriendSuggestionsOptions& options,
    const CancellationToken& token) const {
  std::string path = user_path(user_id) + "/friends/suggestions";
  std::string limit;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    path += detail::build_query({{"limit", limit}});
  }
  return detail::to_items_array<FriendSuggestion>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_friend_suggestion);
}

}  // namespace junjo
