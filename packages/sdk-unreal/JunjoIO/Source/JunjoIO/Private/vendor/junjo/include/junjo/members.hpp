// Junjo.io SDK for C++
//
// Members API surface: lookups, listing, per-member metadata and
// notes, role assignment, and per-member permission overrides.
// Obtained via Client::members(); the returned value shares the
// client's internals, so it stays valid independently of the Client
// object it came from.
#pragma once

#include <chrono>
#include <future>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "junjo/cancellation.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"
#include "junjo/types.hpp"

namespace junjo {

namespace detail {
class RequestExecutor;
}  // namespace detail

class Client;
class Executor;

// Options for MembersApi::list.
struct ListMembersOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  // Filter to one or more statuses ("active", "invited", "left",
  // "kicked", "banned"), sent comma-joined. Empty = all statuses.
  std::vector<std::string> status;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for MembersApi::list_for_user.
struct ListMembersForUserOptions {
  // Constrain to one game; useful mainly for multi-game keys.
  std::optional<std::string> game_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for MembersApi::assign_role and MembersApi::remove_role.
struct RoleAssignmentOptions {
  // External user id of the acting moderator, for audit attribution
  // and the role.changed event.
  std::optional<std::string> actor_user_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Member operations. Cheap to copy (shares the client's executor);
// thread-safe to the same degree as the Client it came from.
class JUNJO_API MembersApi {
 public:
  // GET /v1/groups/:groupId/members/:userId. An empty optional means
  // no membership row exists (null-on-404); every other failure is an
  // Error.
  [[nodiscard]] Result<std::optional<Member>> get(std::string_view group_id,
                                                  std::string_view user_id,
                                                  const RequestOptions& options = {},
                                                  const CancellationToken& token = {}) const;

  // GET /v1/members/:id: lookup by the membership row's own id
  // (Member::id). Null-on-404 like get.
  [[nodiscard]] Result<std::optional<Member>> get_by_id(
      std::string_view id, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // GET /v1/groups/:groupId/members: cursor-paginated listing,
  // optionally filtered by status. Drain with junjo::paginate
  // (junjo/pagination.hpp).
  [[nodiscard]] Result<Page<Member>> list(std::string_view group_id,
                                          const ListMembersOptions& options = {},
                                          const CancellationToken& token = {}) const;

  // list, asynchronously. Same contract as the Client-level async
  // methods (see the async section in junjo/client.hpp): the sync
  // call, posted to a caller owned Executor, arguments copied, future
  // valid past the Client's lifetime, token semantics unchanged.
  [[nodiscard]] std::future<Result<Page<Member>>> list_async(
      Executor& executor, std::string_view group_id, const ListMembersOptions& options = {},
      const CancellationToken& token = {}) const;

  // GET /v1/users/:userId/members: every membership of one user
  // across groups. Not paginated (a user's group count stays small).
  [[nodiscard]] Result<std::vector<Member>> list_for_user(
      std::string_view user_id, const ListMembersForUserOptions& options = {},
      const CancellationToken& token = {}) const;

  // PATCH /v1/groups/:groupId/members/:userId with a full metadata
  // replacement. `metadata_json` must serialize a JSON object (same
  // contract as CreateGroupInput::metadata_json); anything else fails
  // client-side with InvalidConfig before a request is made.
  [[nodiscard]] Result<Member> set_metadata(std::string_view group_id, std::string_view user_id,
                                            const std::string& metadata_json,
                                            const RequestOptions& options = {},
                                            const CancellationToken& token = {}) const;

  // PATCH /v1/groups/:groupId/members/:userId updating the notes
  // fields; see SetMemberNotesInput for the tri-state semantics.
  [[nodiscard]] Result<Member> set_notes(std::string_view group_id, std::string_view user_id,
                                         const SetMemberNotesInput& input,
                                         const RequestOptions& options = {},
                                         const CancellationToken& token = {}) const;

  // POST /v1/groups/:groupId/members/:userId/roles/:roleId. Idempotent
  // on an already-held role.
  [[nodiscard]] Result<Member> assign_role(std::string_view group_id, std::string_view user_id,
                                           std::string_view role_id,
                                           const RoleAssignmentOptions& options = {},
                                           const CancellationToken& token = {}) const;

  // DELETE /v1/groups/:groupId/members/:userId/roles/:roleId.
  [[nodiscard]] Result<Member> remove_role(std::string_view group_id, std::string_view user_id,
                                           std::string_view role_id,
                                           const RoleAssignmentOptions& options = {},
                                           const CancellationToken& token = {}) const;

  // POST /v1/groups/:groupId/members/:userId/permissions/:permission.
  // `grant` true forces the permission on regardless of roles; false
  // forces it off. Overrides win over roles in Client::check.
  [[nodiscard]] Result<MemberPermissionOverride> override_permission(
      std::string_view group_id, std::string_view user_id, std::string_view permission,
      bool grant, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // DELETE /v1/groups/:groupId/members/:userId/permissions/:permission.
  // Idempotent: clearing an override that does not exist still
  // succeeds.
  [[nodiscard]] Result<void> clear_permission_override(
      std::string_view group_id, std::string_view user_id, std::string_view permission,
      const RequestOptions& options = {}, const CancellationToken& token = {}) const;

  // GET /v1/groups/:groupId/members/:userId/permissions.
  [[nodiscard]] Result<std::vector<MemberPermissionOverride>> list_permission_overrides(
      std::string_view group_id, std::string_view user_id, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit MembersApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
