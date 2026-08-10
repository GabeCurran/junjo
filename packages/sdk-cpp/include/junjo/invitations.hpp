// Junjo.io SDK for C++
//
// Invitations API surface: list a group's invitations, look one up by
// code, revoke. Creation lives on GroupsApi (invite_by_user_id /
// invite_by_code), acceptance too (accept_invitation /
// decline_invitation). Obtained via Client::invitations(); the
// returned value shares the client's internals, so it stays valid
// independently of the Client object it came from.
#pragma once

#include <chrono>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "junjo/cancellation.hpp"
#include "junjo/export.hpp"
#include "junjo/result.hpp"
#include "junjo/types.hpp"

namespace junjo {

namespace detail {
class RequestExecutor;
}  // namespace detail

class Client;

// Options for InvitationsApi::list.
struct ListInvitationsOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  // Expired invitations are filtered out unless true.
  std::optional<bool> include_expired;
  // Already-used invitations are filtered out unless true.
  std::optional<bool> include_used;
  std::optional<std::chrono::milliseconds> timeout;
};

// Invitation operations. Cheap to copy (shares the client's executor);
// thread-safe to the same degree as the Client it came from.
class JUNJO_API InvitationsApi {
 public:
  // GET /v1/groups/:groupId/invitations: cursor-paginated listing,
  // pending-only by default. Drain with junjo::paginate
  // (junjo/pagination.hpp).
  [[nodiscard]] Result<Page<Invitation>> list(std::string_view group_id,
                                              const ListInvitationsOptions& options = {},
                                              const CancellationToken& token = {}) const;

  // GET /v1/invitations/:code. An empty optional means no such code
  // (null-on-404); every other failure is an Error.
  [[nodiscard]] Result<std::optional<Invitation>> get(
      std::string_view code, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // DELETE /v1/invitations/:code. Idempotent: revoking a code that no
  // longer exists still succeeds.
  [[nodiscard]] Result<void> revoke(std::string_view code, const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit InvitationsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
