// Junjo.io SDK for C++

#include "junjo/roles.hpp"

#include <string>
#include <utility>

#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

namespace {

using detail::Json;

[[nodiscard]] std::string role_path(std::string_view id) {
  return "/v1/roles/" + detail::percent_encode(id);
}

}  // namespace

RolesApi::RolesApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Role> RolesApi::create(std::string_view group_id, const CreateRoleInput& input,
                              const RequestOptions& options,
                              const CancellationToken& token) const {
  Json body = Json::object();
  body["name"] = input.name;
  body["priority"] = input.priority;
  if (input.color.has_value()) body["color"] = *input.color;
  if (input.is_default.has_value()) body["isDefault"] = *input.is_default;
  const std::string path = "/v1/groups/" + detail::percent_encode(group_id) + "/roles";
  return detail::to_value<Role>(
      executor_->execute_json("POST", path, body, token, options.timeout),
      detail::deserialize_role);
}

Result<std::optional<Role>> RolesApi::get(std::string_view id, const RequestOptions& options,
                                          const CancellationToken& token) const {
  return detail::to_optional_value<Role>(
      executor_->execute_json("GET", role_path(id), std::nullopt, token, options.timeout),
      detail::deserialize_role);
}

Result<std::vector<Role>> RolesApi::list(std::string_view group_id,
                                         const RequestOptions& options,
                                         const CancellationToken& token) const {
  const std::string path = "/v1/groups/" + detail::percent_encode(group_id) + "/roles";
  return detail::to_array<Role>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_role);
}

Result<Role> RolesApi::update(std::string_view id, const UpdateRoleInput& input,
                              const RequestOptions& options,
                              const CancellationToken& token) const {
  Json body = Json::object();
  if (input.name.has_value()) body["name"] = *input.name;
  if (input.priority.has_value()) body["priority"] = *input.priority;
  detail::apply_patch(body, "color", input.color);
  if (input.is_default.has_value()) body["isDefault"] = *input.is_default;
  return detail::to_value<Role>(
      executor_->execute_json("PATCH", role_path(id), body, token, options.timeout),
      detail::deserialize_role);
}

Result<void> RolesApi::remove(std::string_view id, const RequestOptions& options,
                              const CancellationToken& token) const {
  return detail::to_void(
      executor_->execute_json("DELETE", role_path(id), std::nullopt, token, options.timeout));
}

Result<Role> RolesApi::grant_permission(std::string_view role_id, std::string_view permission,
                                        const RequestOptions& options,
                                        const CancellationToken& token) const {
  Json body = Json::object();
  body["permission"] = std::string(permission);
  return detail::to_value<Role>(
      executor_->execute_json("POST", role_path(role_id) + "/permissions", body, token,
                              options.timeout),
      detail::deserialize_role);
}

Result<Role> RolesApi::revoke_permission(std::string_view role_id, std::string_view permission,
                                         const RequestOptions& options,
                                         const CancellationToken& token) const {
  const std::string path =
      role_path(role_id) + "/permissions/" + detail::percent_encode(permission);
  return detail::to_value<Role>(
      executor_->execute_json("DELETE", path, std::nullopt, token, options.timeout),
      detail::deserialize_role);
}

}  // namespace junjo
