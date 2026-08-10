// Junjo.io SDK for C++
//
// The entry point. Construct via Client::create(ClientConfig); every
// API call returns junjo::Result and never throws for API or transport
// failures (see result.hpp for the exception policy).
//
// Credential note: the per-game API key (jk_<prefix>.<secret>) is a
// full-control server credential. Ship it only inside your game server
// or backend, never in a client binary players can read. This library
// does not print warnings about key shapes at runtime (a C++ library
// has no business writing to your console); the one hard rejection is
// an admin token (jadm_*), which is a different credential the API
// would refuse anyway and therefore fails fast as InvalidConfig. Other
// non-jk_ shapes are accepted silently and left for the server to
// judge, so future key formats do not require an SDK update.
#pragma once

#include <chrono>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "junjo/audit.hpp"
#include "junjo/bans.hpp"
#include "junjo/cancellation.hpp"
#include "junjo/events.hpp"
#include "junjo/export.hpp"
#include "junjo/friends.hpp"
#include "junjo/groups.hpp"
#include "junjo/invitations.hpp"
#include "junjo/members.hpp"
#include "junjo/result.hpp"
#include "junjo/roles.hpp"
#include "junjo/transport.hpp"
#include "junjo/types.hpp"
#include "junjo/webhooks.hpp"

namespace junjo {

class Executor;

namespace detail {
class RequestExecutor;
}  // namespace detail

// Configuration for Client::create. Aggregate; brace-init the fields
// you care about and rely on the defaults for the rest.
struct ClientConfig {
  // Per-game secret API key, shape jk_<prefix>.<secret>. Required.
  std::string api_key;
  // Trailing slashes are stripped.
  std::string base_url = "https://api.junjo.io";
  // Base URL that GroupsApi::invite_by_link composes accept links from
  // (invite_base_url + "/invite/" + code). Point it at the frontend
  // origin that renders the invite page. Trailing slashes are stripped.
  // There is no default: the API origin serves no invite pages, so when
  // this is unset invite_by_link fails with InvalidConfig. Absent leaves
  // invite_by_code / invite_by_user_id unaffected.
  std::optional<std::string> invite_base_url;
  // Default whole-request timeout applied to every call. A value <= 0
  // disables the built-in timeout entirely (cancellation tokens still
  // work). 30 seconds is generous enough for slow list queries against
  // a cold database, short enough that a black-holed connection
  // surfaces as a typed Timeout instead of hanging a game server.
  std::chrono::milliseconds timeout{30000};
  // HTTP transport. Null selects the bundled libcurl transport when
  // the library was built with it (JUNJO_BUILD_CURL_TRANSPORT, the
  // default); if the library was built without it, create() fails with
  // InvalidConfig and you must supply your own Transport.
  std::shared_ptr<Transport> transport;
};

// A handle to the Junjo API for one game. Cheap to copy; copies share
// the same transport and configuration. Safe for concurrent use from
// multiple threads as long as the transport is (the bundled curl
// transport is).
class JUNJO_API Client {
 public:
  // Validates `config` and builds a client. Fails with InvalidConfig
  // when: api_key is empty, api_key is an admin token (jadm_*),
  // base_url is empty, or no transport is available (see
  // ClientConfig::transport). Never performs I/O.
  [[nodiscard]] static Result<Client> create(ClientConfig config);

  // GET /v1/whoami: resolves the key to its game. Cheap connectivity
  // and credential check.
  [[nodiscard]] Result<KeyInfo> key_info(const CancellationToken& token = {}) const;

  // GET /v1/permissions/check: does `user_id` hold `permission` in
  // `group_id`? Returns the full decision including where it came from
  // (role / override / default / none) and, when role-derived, the
  // granting role id. Permission keys are game-defined open strings.
  [[nodiscard]] Result<PermissionCheckResult> check(std::string_view user_id,
                                                    std::string_view group_id,
                                                    std::string_view permission,
                                                    const RequestOptions& options = {},
                                                    const CancellationToken& token = {}) const;

  // Convenience wrapper over check() returning only the boolean
  // `allowed` result.
  [[nodiscard]] Result<bool> can(std::string_view user_id, std::string_view group_id,
                                 std::string_view permission,
                                 const RequestOptions& options = {},
                                 const CancellationToken& token = {}) const;

  // ------ Async variants ------
  //
  // The sync API is the first-class surface; these are an opt-in
  // facade over it for callers that want overlap without writing
  // their own thread plumbing. The contract, shared by every *_async
  // method in the SDK:
  //   - The call itself does no I/O; it posts the equivalent sync
  //     call to `executor` and returns immediately. YOU construct and
  //     own the executor (junjo/executor.hpp); the SDK never spawns a
  //     hidden thread.
  //   - The work runs on whatever thread the executor provides, with
  //     identical semantics to the sync call, cancellation token
  //     included (cancel the token and the future completes with
  //     ErrorCode::Cancelled, exactly like the sync return).
  //   - The posted task owns copies of everything it needs, so the
  //     future stays valid and still completes after this Client (and
  //     any surface object) is destroyed. Only the executor must
  //     survive long enough to run what was posted to it; a
  //     ThreadPoolExecutor guarantees that by draining on
  //     destruction.
  //   - Arguments are copied at call time; the caller's strings can
  //     die as soon as the call returns.
  //
  // Deliberate scope restraint: async variants exist for a
  // representative high-value subset (key_info, check, groups
  // get/list/create, members list), not the whole surface. Every
  // sync call composes with an executor the same way these do; when
  // another call earns an async variant, it follows this exact
  // pattern (post a self-contained copy of the sync call, return the
  // future).

  // key_info, asynchronously. See the async contract above.
  [[nodiscard]] std::future<Result<KeyInfo>> key_info_async(
      Executor& executor, const CancellationToken& token = {}) const;

  // check, asynchronously. See the async contract above.
  [[nodiscard]] std::future<Result<PermissionCheckResult>> check_async(
      Executor& executor, std::string_view user_id, std::string_view group_id,
      std::string_view permission, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // The API surfaces. Each returned value shares this client's
  // internals and remains valid after the Client is destroyed.
  [[nodiscard]] GroupsApi groups() const noexcept;
  [[nodiscard]] MembersApi members() const noexcept;
  [[nodiscard]] RolesApi roles() const noexcept;
  [[nodiscard]] InvitationsApi invitations() const noexcept;
  [[nodiscard]] BansApi bans() const noexcept;
  [[nodiscard]] FriendsApi friends() const noexcept;
  [[nodiscard]] AuditApi audit() const noexcept;
  [[nodiscard]] WebhooksApi webhooks() const noexcept;
  [[nodiscard]] EventsApi events() const noexcept;

 private:
  explicit Client(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
