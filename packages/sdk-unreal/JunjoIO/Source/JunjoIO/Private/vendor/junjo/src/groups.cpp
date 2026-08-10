// Junjo.io SDK for C++

#include "junjo/groups.hpp"

#include <future>
#include <optional>
#include <utility>

#include "junjo/error.hpp"

#include "async.hpp"
#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

namespace {

using detail::Json;

[[nodiscard]] std::string group_path(std::string_view id) {
  return "/v1/groups/" + detail::percent_encode(id);
}

[[nodiscard]] std::string member_path(std::string_view group_id, std::string_view user_id) {
  return group_path(group_id) + "/members/" + detail::percent_encode(user_id);
}

[[nodiscard]] std::string invitation_path(std::string_view code) {
  return "/v1/invitations/" + detail::percent_encode(code);
}

[[nodiscard]] std::string relationship_path(std::string_view group_a_id,
                                            std::string_view group_b_id) {
  return group_path(group_a_id) + "/relationships/" + detail::percent_encode(group_b_id);
}

}  // namespace

GroupsApi::GroupsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Group> GroupsApi::create(const CreateGroupInput& input, const RequestOptions& options,
                                const CancellationToken& token) const {
  Json body = Json::object();
  body["kind"] = input.kind;
  body["name"] = input.name;
  if (input.visibility.has_value()) body["visibility"] = *input.visibility;
  if (input.metadata_json.has_value()) {
    Result<Json> metadata = detail::parse_metadata_input(*input.metadata_json);
    if (!metadata.has_value()) return std::move(metadata).error();
    body["metadata"] = std::move(metadata).value();
  }
  if (input.default_role_id.has_value()) body["defaultRoleId"] = *input.default_role_id;
  if (input.creator_user_id.has_value()) body["creatorUserId"] = *input.creator_user_id;
  if (input.passcode.has_value()) body["passcode"] = *input.passcode;

  return detail::to_value<Group>(
      executor_->execute_json("POST", "/v1/groups", body, token, options.timeout),
      detail::deserialize_group);
}

Result<std::optional<Group>> GroupsApi::get(std::string_view id, const GetGroupOptions& options,
                                            const CancellationToken& token) const {
  std::string path = group_path(id);
  if (options.viewer.has_value()) {
    path += detail::build_query({{"viewer", *options.viewer}});
  }
  return detail::to_optional_value<Group>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_group);
}

Result<Page<Group>> GroupsApi::list(const ListGroupsOptions& options,
                                    const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);
  if (options.viewer.has_value()) params.emplace_back("viewer", *options.viewer);

  const std::string path = "/v1/groups" + detail::build_query(params);
  return detail::to_page<Group>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_group);
}

std::future<Result<Group>> GroupsApi::create_async(Executor& executor,
                                                   const CreateGroupInput& input,
                                                   const RequestOptions& options,
                                                   const CancellationToken& token) const {
  // The task owns a full copy of this surface (one shared_ptr), so
  // the future completes even if the Client dies first.
  return detail::post_task(
      executor, [api = *this, input, options, token] { return api.create(input, options, token); });
}

std::future<Result<std::optional<Group>>> GroupsApi::get_async(Executor& executor,
                                                               std::string_view id,
                                                               const GetGroupOptions& options,
                                                               const CancellationToken& token) const {
  return detail::post_task(executor, [api = *this, id = std::string(id), options, token] {
    return api.get(id, options, token);
  });
}

std::future<Result<Page<Group>>> GroupsApi::list_async(Executor& executor,
                                                       const ListGroupsOptions& options,
                                                       const CancellationToken& token) const {
  return detail::post_task(executor,
                           [api = *this, options, token] { return api.list(options, token); });
}

Result<Group> GroupsApi::update(std::string_view id, const UpdateGroupInput& input,
                                const RequestOptions& options,
                                const CancellationToken& token) const {
  Json body = Json::object();
  if (input.name.has_value()) body["name"] = *input.name;
  if (input.visibility.has_value()) body["visibility"] = *input.visibility;
  if (input.metadata_json.has_value()) {
    Result<Json> metadata = detail::parse_metadata_input(*input.metadata_json);
    if (!metadata.has_value()) return std::move(metadata).error();
    body["metadata"] = std::move(metadata).value();
  }
  detail::apply_patch(body, "defaultRoleId", input.default_role_id);
  detail::apply_patch(body, "passcode", input.passcode);

  return detail::to_value<Group>(
      executor_->execute_json("PATCH", group_path(id), body, token, options.timeout),
      detail::deserialize_group);
}

Result<void> GroupsApi::remove(std::string_view id, const RemoveGroupOptions& options,
                               const CancellationToken& token) const {
  std::string path = group_path(id);
  if (options.hard) path += "?hard=true";
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

Result<Group> GroupsApi::restore(std::string_view id, const RequestOptions& options,
                                 const CancellationToken& token) const {
  return detail::to_value<Group>(
      executor_->execute_json("POST", group_path(id) + "/restore", std::nullopt, token,
                              options.timeout),
      detail::deserialize_group);
}

Result<Member> GroupsApi::join(std::string_view group_id, std::string_view user_id,
                               const JoinGroupOptions& options,
                               const CancellationToken& token) const {
  Json body = Json::object();
  body["userId"] = std::string(user_id);
  if (options.passcode.has_value()) body["passcode"] = *options.passcode;
  return detail::to_value<Member>(
      executor_->execute_json("POST", group_path(group_id) + "/join", body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Member> GroupsApi::leave(std::string_view group_id, std::string_view user_id,
                                const RequestOptions& options,
                                const CancellationToken& token) const {
  Json body = Json::object();
  body["userId"] = std::string(user_id);
  return detail::to_value<Member>(
      executor_->execute_json("POST", group_path(group_id) + "/leave", body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Member> GroupsApi::kick(std::string_view group_id, std::string_view user_id,
                               const KickMemberOptions& options,
                               const CancellationToken& token) const {
  Json body = Json::object();
  if (options.reason.has_value()) body["reason"] = *options.reason;
  return detail::to_value<Member>(
      executor_->execute_json("POST", member_path(group_id, user_id) + "/kick", body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Member> GroupsApi::ban(std::string_view group_id, std::string_view user_id,
                              const BanMemberOptions& options,
                              const CancellationToken& token) const {
  Json body = Json::object();
  if (options.reason.has_value()) body["reason"] = *options.reason;
  if (options.expires_at.has_value()) body["expiresAt"] = *options.expires_at;
  if (options.actor_user_id.has_value()) body["actorUserId"] = *options.actor_user_id;
  return detail::to_value<Member>(
      executor_->execute_json("POST", member_path(group_id, user_id) + "/ban", body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Member> GroupsApi::unban(std::string_view group_id, std::string_view user_id,
                                const UnbanMemberOptions& options,
                                const CancellationToken& token) const {
  // No actor = no body at all, mirroring the TS SDK (the route treats
  // an absent body as "no acting user").
  std::optional<Json> body;
  if (options.actor_user_id.has_value()) {
    body = Json::object();
    (*body)["actorUserId"] = *options.actor_user_id;
  }
  return detail::to_value<Member>(
      executor_->execute_json("DELETE", member_path(group_id, user_id) + "/ban", body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<Page<BanHistoryEntry>> GroupsApi::ban_history(std::string_view group_id,
                                                     const BanHistoryOptions& options,
                                                     const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);

  const std::string path = group_path(group_id) + "/bans/history" + detail::build_query(params);
  return detail::to_page<BanHistoryEntry>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_ban_history_entry);
}

Result<Invitation> GroupsApi::invite_by_user_id(std::string_view group_id,
                                                std::string_view user_id,
                                                const InviteByUserIdOptions& options,
                                                const CancellationToken& token) const {
  Json body = Json::object();
  body["targetUserId"] = std::string(user_id);
  if (options.role_id.has_value()) body["roleId"] = *options.role_id;
  return detail::to_value<Invitation>(
      executor_->execute_json("POST", group_path(group_id) + "/invitations", body, token,
                              options.timeout),
      detail::deserialize_invitation);
}

Result<Invitation> GroupsApi::invite_by_code(std::string_view group_id,
                                             const InviteByCodeOptions& options,
                                             const CancellationToken& token) const {
  // No targetUserId by definition: the open-code path is not addressed
  // to anyone, matching the TS SDK's inviteByCode.
  Json body = Json::object();
  if (options.role_id.has_value()) body["roleId"] = *options.role_id;
  if (options.expires_in.has_value()) body["expiresIn"] = *options.expires_in;
  return detail::to_value<Invitation>(
      executor_->execute_json("POST", group_path(group_id) + "/invitations", body, token,
                              options.timeout),
      detail::deserialize_invitation);
}

Result<InviteByLinkResult> GroupsApi::invite_by_link(std::string_view group_id,
                                                     const InviteByLinkOptions& options,
                                                     const CancellationToken& token) const {
  // Refuse to mint a link nobody can open, and do it before creating
  // anything so a misconfigured client leaves no dangling invitation
  // behind.
  const std::optional<std::string>& invite_base_url = executor_->config().invite_base_url;
  if (!invite_base_url.has_value()) {
    return Error{
        .code = ErrorCode::InvalidConfig,
        .message = "invite_by_link requires invite_base_url; set ClientConfig::invite_base_url "
                   "to the frontend origin that renders the invite page, or use invite_by_code "
                   "when only the code is needed"};
  }
  InviteByCodeOptions code_options;
  code_options.role_id = options.role_id;
  code_options.expires_in = options.expires_in;
  code_options.timeout = options.timeout;
  Result<Invitation> invitation = invite_by_code(group_id, code_options, token);
  if (!invitation.has_value()) {
    return std::move(invitation).error();
  }
  InviteByLinkResult result;
  result.invitation = std::move(invitation).value();
  result.url = *invite_base_url + "/invite/" + detail::percent_encode(result.invitation.code);
  return result;
}

Result<BulkInviteResult> GroupsApi::bulk_invite(std::string_view group_id, std::string_view csv,
                                                const BulkInviteOptions& options,
                                                const CancellationToken& token) const {
  std::string path = group_path(group_id) + "/bulk-invite";
  if (options.role_id.has_value()) {
    path += detail::build_query({{"roleId", *options.role_id}});
  }
  // The body is the CSV text sent verbatim under text/csv; the server
  // parses one external user id per line and enforces the row and
  // per-id length caps.
  return detail::to_value<BulkInviteResult>(
      executor_->execute_raw("POST", path, std::string(csv), "text/csv", token, options.timeout),
      detail::deserialize_bulk_invite_result);
}

Result<Member> GroupsApi::accept_invitation(std::string_view code, std::string_view user_id,
                                            const RequestOptions& options,
                                            const CancellationToken& token) const {
  Json body = Json::object();
  body["userId"] = std::string(user_id);
  return detail::to_value<Member>(
      executor_->execute_json("POST", invitation_path(code) + "/accept", body, token,
                              options.timeout),
      detail::deserialize_member);
}

Result<void> GroupsApi::decline_invitation(std::string_view code,
                                           const DeclineInvitationOptions& options,
                                           const CancellationToken& token) const {
  Json body = Json::object();
  if (options.user_id.has_value()) body["userId"] = *options.user_id;
  return detail::to_void(executor_->execute_json("POST", invitation_path(code) + "/decline",
                                                 body, token, options.timeout));
}

Result<GroupRelationship> GroupsApi::set_relationship(std::string_view group_a_id,
                                                      std::string_view group_b_id,
                                                      std::string_view type,
                                                      const SetRelationshipOptions& options,
                                                      const CancellationToken& token) const {
  Json body = Json::object();
  body["type"] = std::string(type);
  if (options.mutual.has_value()) body["mutual"] = *options.mutual;
  return detail::to_value<GroupRelationship>(
      executor_->execute_json("PUT", relationship_path(group_a_id, group_b_id), body, token,
                              options.timeout),
      detail::deserialize_group_relationship);
}

Result<void> GroupsApi::clear_relationship(std::string_view group_a_id,
                                           std::string_view group_b_id,
                                           const ClearRelationshipOptions& options,
                                           const CancellationToken& token) const {
  std::string path = relationship_path(group_a_id, group_b_id);
  if (options.mutual) path += "?mutual=true";
  return detail::to_void(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout));
}

Result<std::optional<GroupRelationship>> GroupsApi::get_relationship(
    std::string_view group_a_id, std::string_view group_b_id, const RequestOptions& options,
    const CancellationToken& token) const {
  return detail::to_optional_value<GroupRelationship>(
      executor_->execute_json("GET", relationship_path(group_a_id, group_b_id), std::nullopt,
                              token, options.timeout),
      detail::deserialize_group_relationship);
}

Result<std::vector<GroupRelationship>> GroupsApi::list_relationships(
    std::string_view group_id, const RequestOptions& options,
    const CancellationToken& token) const {
  return detail::to_array<GroupRelationship>(
      executor_->execute_json("GET", group_path(group_id) + "/relationships", std::nullopt,
                              token, options.timeout),
      detail::deserialize_group_relationship);
}

Result<Group> GroupsApi::set_parent(std::string_view group_id,
                                    const std::optional<std::string>& parent_group_id,
                                    const RequestOptions& options,
                                    const CancellationToken& token) const {
  // The body always carries parentGroupId (the route rejects an
  // omitted field so the call's intent stays explicit); nullopt maps
  // to JSON null, clearing the parent.
  Json body = Json::object();
  if (parent_group_id.has_value()) {
    body["parentGroupId"] = *parent_group_id;
  } else {
    body["parentGroupId"] = nullptr;
  }
  return detail::to_value<Group>(
      executor_->execute_json("PUT", group_path(group_id) + "/parent", body, token,
                              options.timeout),
      detail::deserialize_group);
}

Result<std::vector<Group>> GroupsApi::list_children(std::string_view group_id,
                                                    const RequestOptions& options,
                                                    const CancellationToken& token) const {
  return detail::to_array<Group>(
      executor_->execute_json("GET", group_path(group_id) + "/children", std::nullopt, token,
                              options.timeout),
      detail::deserialize_group);
}

}  // namespace junjo
