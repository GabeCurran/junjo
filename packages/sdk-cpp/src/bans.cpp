// Junjo.io SDK for C++

#include "junjo/bans.hpp"

#include <utility>
#include <vector>

#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

namespace {

using detail::Json;

[[nodiscard]] std::string ban_path(std::string_view user_id) {
  return "/v1/bans/" + detail::percent_encode(user_id);
}

}  // namespace

BansApi::BansApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Ban> BansApi::add(std::string_view user_id, const AddBanOptions& options,
                         const CancellationToken& token) const {
  Json body = Json::object();
  body["userId"] = std::string(user_id);
  if (options.reason.has_value()) body["reason"] = *options.reason;
  if (options.expires_at.has_value()) body["expiresAt"] = *options.expires_at;
  if (options.actor_user_id.has_value()) body["actorUserId"] = *options.actor_user_id;
  return detail::to_value<Ban>(
      executor_->execute_json("POST", "/v1/bans", body, token, options.timeout),
      detail::deserialize_ban);
}

Result<void> BansApi::remove(std::string_view user_id, const RemoveBanOptions& options,
                             const CancellationToken& token) const {
  // No actor = no body at all, mirroring the TS SDK (the route treats
  // an absent body as "no acting user").
  std::optional<Json> body;
  if (options.actor_user_id.has_value()) {
    body = Json::object();
    (*body)["actorUserId"] = *options.actor_user_id;
  }
  return detail::to_void(
      executor_->execute_json("DELETE", ban_path(user_id), body, token, options.timeout));
}

Result<std::optional<Ban>> BansApi::get(std::string_view user_id, const RequestOptions& options,
                                        const CancellationToken& token) const {
  return detail::to_optional_value<Ban>(
      executor_->execute_json("GET", ban_path(user_id), std::nullopt, token, options.timeout),
      detail::deserialize_ban);
}

Result<Page<Ban>> BansApi::list(const ListBansOptions& options,
                                const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);
  // Sent only when true, matching the TS SDK; the server default is
  // already active-only.
  if (options.include_expired) params.emplace_back("includeExpired", "true");

  const std::string path = "/v1/bans" + detail::build_query(params);
  return detail::to_page<Ban>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_ban);
}

Result<Page<BanHistoryEntry>> BansApi::history(std::string_view user_id,
                                               const ListBanHistoryOptions& options,
                                               const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);
  if (options.scope.has_value()) params.emplace_back("scope", *options.scope);
  if (options.group_id.has_value()) params.emplace_back("groupId", *options.group_id);

  const std::string path = ban_path(user_id) + "/history" + detail::build_query(params);
  return detail::to_page<BanHistoryEntry>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_ban_history_entry);
}

}  // namespace junjo
