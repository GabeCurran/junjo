// Junjo.io SDK for C++
//
// Audit API surface: a group's action history, newest first. Obtained
// via Client::audit(); the returned value shares the client's
// internals, so it stays valid independently of the Client object it
// came from.
#pragma once

#include <chrono>
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

// Options for AuditApi::list.
struct ListAuditOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Page boundary, sent verbatim. Two forms are accepted: an opaque
  // cursor (what Page::next_cursor returns; exact keyset pagination
  // immune to same-millisecond rows) or an ISO 8601 timestamp
  // (strictly-older-than). Feed each page's next_cursor back in here
  // for the next page; note the parameter is named `before`, not
  // `cursor`, so junjo::paginate does not apply to this listing.
  std::optional<std::string> before;
  // Filter to these audit-action strings ("member.kicked",
  // "role.created", ...), sent as repeated `actions` query
  // parameters. Empty = all actions. Unknown strings are rejected
  // server-side as bad_request.
  std::vector<std::string> actions;
  std::optional<std::chrono::milliseconds> timeout;
};

// Audit log operations. Cheap to copy (shares the client's executor);
// thread-safe to the same degree as the Client it came from.
class JUNJO_API AuditApi {
 public:
  // GET /v1/groups/:id/audit: cursor-paginated audit entries, newest
  // first. Page::next_cursor goes back in as ListAuditOptions::before.
  [[nodiscard]] Result<Page<AuditEntry>> list(std::string_view group_id,
                                              const ListAuditOptions& options = {},
                                              const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit AuditApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
