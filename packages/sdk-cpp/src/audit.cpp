// Junjo.io SDK for C++

#include "junjo/audit.hpp"

#include <utility>

#include "request_executor.hpp"
#include "url.hpp"
#include "wire.hpp"

namespace junjo {

AuditApi::AuditApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept
    : executor_(std::move(executor)) {}

Result<Page<AuditEntry>> AuditApi::list(std::string_view group_id,
                                        const ListAuditOptions& options,
                                        const CancellationToken& token) const {
  std::string limit;
  std::vector<std::pair<std::string_view, std::string_view>> params;
  if (options.limit.has_value()) {
    limit = std::to_string(*options.limit);
    params.emplace_back("limit", limit);
  }
  if (options.before.has_value()) params.emplace_back("before", *options.before);
  // Repeated `actions` parameters, matching the server's
  // c.req.queries("actions") array read and the TS SDK's
  // params.append loop.
  for (const std::string& action : options.actions) {
    params.emplace_back("actions", action);
  }

  const std::string path =
      "/v1/groups/" + detail::percent_encode(group_id) + "/audit" + detail::build_query(params);
  return detail::to_page<AuditEntry>(
      executor_->execute_json("GET", path, std::nullopt, token, options.timeout),
      detail::deserialize_audit_entry);
}

}  // namespace junjo
