// Junjo.io SDK for C++

#include "junjo/client.hpp"

#include <future>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "junjo/error.hpp"

#include "async.hpp"
#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

#if defined(JUNJO_HAS_CURL_TRANSPORT)
#include "junjo/curl_transport.hpp"
#endif

namespace junjo {

namespace {

using detail::JsonBody;

[[nodiscard]] Error invalid_config(std::string message) {
  return Error{.code = ErrorCode::InvalidConfig, .message = std::move(message)};
}

// Strips trailing '/' runs so path concatenation ("base" + "/v1/...")
// cannot produce "//".
[[nodiscard]] std::string normalize_base_url(std::string url) {
  while (!url.empty() && url.back() == '/') {
    url.pop_back();
  }
  return url;
}

}  // namespace

Result<Client> Client::create(ClientConfig config) {
  if (config.api_key.empty()) {
    return invalid_config(
        "api_key is required; mint a per-game key (jk_<prefix>.<secret>) via "
        "POST /v1/admin/games/:gameId/api-keys");
  }
  // A jadm_ token is the cross-game ADMIN credential; the API would
  // reject it on every call, so fail fast at construction. Any other
  // shape (including non-jk_ strings) is accepted silently and left
  // for the server to judge; see the header comment for why.
  if (std::string_view(config.api_key).starts_with("jadm_")) {
    return invalid_config(
        "api_key looks like a cross-game admin token (jadm_*); the SDK needs a per-game "
        "API key (jk_<prefix>.<secret>) minted via POST /v1/admin/games/:gameId/api-keys");
  }

  std::string base_url = normalize_base_url(std::move(config.base_url));
  if (base_url.empty()) {
    return invalid_config("base_url must not be empty");
  }

  // Normalized once at construction so invite_by_link can concatenate
  // without re-trimming; absence stays absent (invite_by_link then
  // fails with InvalidConfig).
  std::optional<std::string> invite_base_url;
  if (config.invite_base_url.has_value()) {
    invite_base_url = normalize_base_url(std::move(*config.invite_base_url));
  }

  std::shared_ptr<Transport> transport = std::move(config.transport);
  if (transport == nullptr) {
#if defined(JUNJO_HAS_CURL_TRANSPORT)
    transport = std::make_shared<CurlTransport>();
#else
    return invalid_config(
        "no transport: the library was built without the bundled curl transport "
        "(JUNJO_BUILD_CURL_TRANSPORT=OFF), so ClientConfig::transport must be set");
#endif
  }

  auto executor = std::make_shared<const detail::RequestExecutor>(detail::RequestExecutor::Config{
      .api_key = std::move(config.api_key),
      .base_url = std::move(base_url),
      .invite_base_url = std::move(invite_base_url),
      .timeout = config.timeout,
      .transport = std::move(transport),
  });
  return Client(std::move(executor));
}

Client::Client(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<KeyInfo> Client::key_info(const CancellationToken& token) const {
  Result<JsonBody> response = executor_->execute_json("GET", "/v1/whoami", std::nullopt, token);
  if (!response.has_value()) {
    return std::move(response).error();
  }
  const JsonBody& body = response.value();
  if (!body.value.has_value() || !body.value->is_object()) {
    return Error{.code = ErrorCode::InvalidWireData,
                 .message = "whoami response was not a JSON object",
                 .status = body.status};
  }
  const auto game_id = body.value->find("gameId");
  if (game_id == body.value->end() || !game_id->is_string()) {
    return Error{.code = ErrorCode::InvalidWireData,
                 .message = "whoami response is missing string field gameId",
                 .status = body.status};
  }
  return KeyInfo{.game_id = game_id->get<std::string>()};
}

Result<PermissionCheckResult> Client::check(std::string_view user_id,
                                            std::string_view group_id,
                                            std::string_view permission,
                                            const RequestOptions& options,
                                            const CancellationToken& token) const {
  const std::string path =
      "/v1/permissions/check" + detail::build_query({{"userId", user_id},
                                                     {"groupId", group_id},
                                                     {"permission", permission}});
  return detail::to_value<PermissionCheckResult>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_permission_check_result);
}

Result<bool> Client::can(std::string_view user_id, std::string_view group_id,
                         std::string_view permission, const RequestOptions& options,
                         const CancellationToken& token) const {
  return check(user_id, group_id, permission, options, token)
      .map([](PermissionCheckResult&& result) { return result.allowed; });
}

std::future<Result<KeyInfo>> Client::key_info_async(Executor& executor,
                                                    const CancellationToken& token) const {
  // The task owns a full copy of this client (one shared_ptr), so the
  // future completes even if every user-held handle dies first.
  return detail::post_task(executor,
                           [client = *this, token] { return client.key_info(token); });
}

std::future<Result<PermissionCheckResult>> Client::check_async(
    Executor& executor, std::string_view user_id, std::string_view group_id,
    std::string_view permission, const RequestOptions& options,
    const CancellationToken& token) const {
  return detail::post_task(
      executor, [client = *this, user_id = std::string(user_id),
                 group_id = std::string(group_id), permission = std::string(permission), options,
                 token] { return client.check(user_id, group_id, permission, options, token); });
}

GroupsApi Client::groups() const noexcept { return GroupsApi(executor_); }

MembersApi Client::members() const noexcept { return MembersApi(executor_); }

RolesApi Client::roles() const noexcept { return RolesApi(executor_); }

InvitationsApi Client::invitations() const noexcept { return InvitationsApi(executor_); }

BansApi Client::bans() const noexcept { return BansApi(executor_); }

FriendsApi Client::friends() const noexcept { return FriendsApi(executor_); }

AuditApi Client::audit() const noexcept { return AuditApi(executor_); }

WebhooksApi Client::webhooks() const noexcept { return WebhooksApi(executor_); }

EventsApi Client::events() const noexcept { return EventsApi(executor_); }

}  // namespace junjo
