// Junjo.io SDK for C++

#include "junjo/invitations.hpp"

#include <utility>

#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

InvitationsApi::InvitationsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Page<Invitation>> InvitationsApi::list(std::string_view group_id,
                                              const ListInvitationsOptions& options,
                                              const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.cursor.has_value()) params.emplace_back("cursor", *options.cursor);
  if (options.include_expired.has_value()) {
    params.emplace_back("includeExpired", *options.include_expired ? "true" : "false");
  }
  if (options.include_used.has_value()) {
    params.emplace_back("includeUsed", *options.include_used ? "true" : "false");
  }

  const std::string path = "/v1/groups/" + detail::percent_encode(group_id) + "/invitations" +
                           detail::build_query(params);
  return detail::to_page<Invitation>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_invitation);
}

Result<std::optional<Invitation>> InvitationsApi::get(std::string_view code,
                                                      const RequestOptions& options,
                                                      const CancellationToken& token) const {
  return detail::to_optional_value<Invitation>(
      executor_->execute_json("GET", "/v1/invitations/" + detail::percent_encode(code),
                              std::nullopt, token, options.timeout),
      detail::deserialize_invitation);
}

Result<void> InvitationsApi::revoke(std::string_view code, const RequestOptions& options,
                                    const CancellationToken& token) const {
  return detail::to_void(
      executor_->execute_json("DELETE", "/v1/invitations/" + detail::percent_encode(code),
                              std::nullopt, token, options.timeout));
}

}  // namespace junjo
