// Junjo.io SDK for C++

#include "junjo/members.hpp"

#include <future>
#include <utility>

#include "async.hpp"
#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

namespace {

using detail::Json;

[[nodiscard]] std::string member_path(std::string_view group_id, std::string_view user_id) {
  return "/v1/groups/" + detail::percent_encode(group_id) + "/members/" +
         detail::percent_encode(user_id);
}

}  // namespace

MembersApi::MembersApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Member> MembersApi::add(std::string_view group_id, std::string_view user_id,
                               const AddMemberOptions& options,
                               const CancellationToken& token) const {
  Json body = Json::object();
  body["userId"] = std::string(user_id);
  if (options.role_id.has_value()) body["roleId"] = *options.role_id;
  if (options.actor_user_id.has_value()) body["actorUserId"] = *options.actor_user_id;
  const std::string path = "/v1/groups/" + detail::percent_encode(group_id) + "/members";
  return detail::to_value<Member>(
      executor_->execute_json("POST", path, body, token, options.timeout),
      detail::deserialize_member);
}

Result<std::optional<Member>> MembersApi::get(std::string_view group_id,
                                              std::string_view user_id,
                                              const RequestOptions& options,
                                              const CancellationToken& token) const {
  return detail::to_optional_value<Member>(
      executor_->execute_json("GET", member_path(group_id, user_id), std::nullopt, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<std::optional<Member>> MembersApi::get_by_id(std::string_view id,
                                                    const RequestOptions& options,
                                                    const CancellationToken& token) const {
  return detail::to_optional_value<Member>(
      executor_->execute_json("GET", "/v1/members/" + detail::percent_encode(id), std::nullopt,
                              token, options.timeout),
      detail::deserialize_member);
}

Result<Page<Member>> MembersApi::list(std::string_view group_id,
                                      const ListMembersOptions& options,
                                      const CancellationToken& token) const {
  std::string limit;
  std::string status;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);
  if (!options.status.empty()) {
    // Comma-joined, matching the server's comma-separated status
    // filter and the TS SDK's status.join(",").
    for (const std::string& one : options.status) {
      if (!status.empty()) status += ',';
      status += one;
    }
    params.emplace_back("status", status);
  }

  const std::string path = "/v1/groups/" + detail::percent_encode(group_id) + "/members" +
                           detail::build_query(params);
  return detail::to_page<Member>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_member);
}

std::future<Result<Page<Member>>> MembersApi::list_async(Executor& executor,
                                                         std::string_view group_id,
                                                         const ListMembersOptions& options,
                                                         const CancellationToken& token) const {
  // The task owns a full copy of this surface (one shared_ptr), so
  // the future completes even if the Client dies first.
  return detail::post_task(executor,
                           [api = *this, group_id = std::string(group_id), options, token] {
                             return api.list(group_id, options, token);
                           });
}

Result<std::vector<Member>> MembersApi::list_for_user(std::string_view user_id,
                                                      const ListMembersForUserOptions& options,
                                                      const CancellationToken& token) const {
  std::string path = "/v1/users/" + detail::percent_encode(user_id) + "/members";
  if (options.game_id.has_value()) {
    path += detail::build_query({{"gameId", *options.game_id}});
  }
  return detail::to_array<Member>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_member);
}

Result<Member> MembersApi::set_metadata(std::string_view group_id, std::string_view user_id,
                                        const std::string& metadata_json,
                                        const RequestOptions& options,
                                        const CancellationToken& token) const {
  Result<Json> metadata = detail::parse_metadata_input(metadata_json);
  if (!metadata.has_value()) return std::move(metadata).error();
  Json body = Json::object();
  body["metadata"] = std::move(metadata).value();
  return detail::to_value<Member>(
      executor_->execute_json("PATCH", member_path(group_id, user_id), body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Member> MembersApi::set_notes(std::string_view group_id, std::string_view user_id,
                                     const SetMemberNotesInput& input,
                                     const RequestOptions& options,
                                     const CancellationToken& token) const {
  Json body = Json::object();
  detail::apply_patch(body, "notesPublic", input.notes_public);
  detail::apply_patch(body, "notesPrivate", input.notes_private);
  return detail::to_value<Member>(
      executor_->execute_json("PATCH", member_path(group_id, user_id), body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Member> MembersApi::assign_role(std::string_view group_id, std::string_view user_id,
                                       std::string_view role_id,
                                       const RoleAssignmentOptions& options,
                                       const CancellationToken& token) const {
  // No actor = no body at all, mirroring the TS SDK.
  std::optional<Json> body;
  if (options.actor_user_id.has_value()) {
    body = Json::object();
    (*body)["actorUserId"] = *options.actor_user_id;
  }
  const std::string path =
      member_path(group_id, user_id) + "/roles/" + detail::percent_encode(role_id);
  return detail::to_value<Member>(
      executor_->execute_json("POST", path, body, token, options.timeout),
      detail::deserialize_member);
}

Result<Member> MembersApi::remove_role(std::string_view group_id, std::string_view user_id,
                                       std::string_view role_id,
                                       const RoleAssignmentOptions& options,
                                       const CancellationToken& token) const {
  std::optional<Json> body;
  if (options.actor_user_id.has_value()) {
    body = Json::object();
    (*body)["actorUserId"] = *options.actor_user_id;
  }
  const std::string path =
      member_path(group_id, user_id) + "/roles/" + detail::percent_encode(role_id);
  return detail::to_value<Member>(
      executor_->execute_json("DELETE", path, body, token, options.timeout),
      detail::deserialize_member);
}

Result<MemberPermissionOverride> MembersApi::override_permission(
    std::string_view group_id, std::string_view user_id, std::string_view permission,
    bool grant, const RequestOptions& options, const CancellationToken& token) const {
  Json body = Json::object();
  body["grant"] = grant;
  const std::string path =
      member_path(group_id, user_id) + "/permissions/" + detail::percent_encode(permission);
  return detail::to_value<MemberPermissionOverride>(
      executor_->execute_json("POST", path, body, token, options.timeout),
      detail::deserialize_member_permission_override);
}

Result<void> MembersApi::clear_permission_override(std::string_view group_id,
                                                   std::string_view user_id,
                                                   std::string_view permission,
                                                   const RequestOptions& options,
                                                   const CancellationToken& token) const {
  const std::string path =
      member_path(group_id, user_id) + "/permissions/" + detail::percent_encode(permission);
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

Result<std::vector<MemberPermissionOverride>> MembersApi::list_permission_overrides(
    std::string_view group_id, std::string_view user_id, const RequestOptions& options,
    const CancellationToken& token) const {
  return detail::to_array<MemberPermissionOverride>(
      executor_->execute_json("GET", member_path(group_id, user_id) + "/permissions",
                              std::nullopt, token, options.timeout),
      detail::deserialize_member_permission_override);
}

}  // namespace junjo
