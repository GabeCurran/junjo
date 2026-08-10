// Junjo.io SDK for C++
//
// Roles API surface: CRUD within a group plus permission grant /
// revoke. Roles get permissions through the dedicated grant / revoke
// calls, never at creation time. Obtained via Client::roles(); the
// returned value shares the client's internals, so it stays valid
// independently of the Client object it came from.
#pragma once

#include <memory>
#include <optional>
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

// Role operations. Cheap to copy (shares the client's executor);
// thread-safe to the same degree as the Client it came from.
class JUNJO_API RolesApi {
 public:
  // POST /v1/groups/:groupId/roles. Role names are unique per group
  // (role_name_taken otherwise).
  [[nodiscard]] Result<Role> create(std::string_view group_id, const CreateRoleInput& input,
                                    const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // GET /v1/roles/:id. An empty optional means the role does not exist
  // (null-on-404); every other failure is an Error.
  [[nodiscard]] Result<std::optional<Role>> get(std::string_view id,
                                                const RequestOptions& options = {},
                                                const CancellationToken& token = {}) const;

  // GET /v1/groups/:groupId/roles: every role of the group. Not
  // paginated (a group's role count stays small).
  [[nodiscard]] Result<std::vector<Role>> list(std::string_view group_id,
                                               const RequestOptions& options = {},
                                               const CancellationToken& token = {}) const;

  // PATCH /v1/roles/:id. Absent input fields stay untouched; see
  // UpdateRoleInput for the tri-state color semantics.
  [[nodiscard]] Result<Role> update(std::string_view id, const UpdateRoleInput& input,
                                    const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // DELETE /v1/roles/:id. Fails with role_has_members while any member
  // still holds the role. Named remove because delete is a C++
  // keyword.
  [[nodiscard]] Result<void> remove(std::string_view id, const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // POST /v1/roles/:id/permissions: grants one permission key to the
  // role and returns the updated role. Idempotent.
  [[nodiscard]] Result<Role> grant_permission(std::string_view role_id,
                                              std::string_view permission,
                                              const RequestOptions& options = {},
                                              const CancellationToken& token = {}) const;

  // DELETE /v1/roles/:id/permissions/:permission. Idempotent.
  [[nodiscard]] Result<Role> revoke_permission(std::string_view role_id,
                                               std::string_view permission,
                                               const RequestOptions& options = {},
                                               const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit RolesApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
