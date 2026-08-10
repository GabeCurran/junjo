// Junjo.io SDK for C++
//
// Bans API surface: game-wide bans (issue, lift, look up, list) and
// the per-user ban-event timeline. Per-group bans live on GroupsApi
// (ban / unban / ban_history) alongside kick semantics; the two
// surfaces compose, and server-side enforcement checks game-level
// first, then per-group. Obtained via Client::bans(); the returned
// value shares the client's internals, so it stays valid independently
// of the Client object it came from.
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

// Options for BansApi::add. All plain set-only optionals: a create has
// no preexisting server value to clear, and the route stores an absent
// field and an explicit JSON null identically, so a tri-state Patch
// would imply a distinction the wire does not have (unlike update
// inputs, where omitted and null diverge).
struct AddBanOptions {
  // Recorded on the ban; capped at 500 chars server-side.
  std::optional<std::string> reason;
  // ISO 8601 timestamp ending the ban; absent = permanent. The value
  // must be a valid ISO 8601 instant; an already-past instant is
  // accepted and creates a ban that is already expired.
  std::optional<std::string> expires_at;
  // External user id of the acting moderator, for audit attribution.
  // Auto-creates the user server-side if unseen (mirrors the target).
  std::optional<std::string> actor_user_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for BansApi::remove.
struct RemoveBanOptions {
  // External user id of the acting moderator, for audit attribution.
  std::optional<std::string> actor_user_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for BansApi::list.
struct ListBansOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  // false (the default) returns only active bans, matching the runtime
  // ban check; true also returns rows whose expires_at has elapsed.
  bool include_expired = false;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for BansApi::history.
struct ListBanHistoryOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  // "game" | "group": filter to one ban surface. Omit for both.
  // Forced to "group" when `group_id` is supplied; supplying both with
  // scope "game" is a bad_request.
  std::optional<std::string> scope;
  // Narrow to one group's rows (implies scope "group").
  std::optional<std::string> group_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Game-wide ban operations. Cheap to copy (shares the client's
// executor); thread-safe to the same degree as the Client it came
// from.
class JUNJO_API BansApi {
 public:
  // POST /v1/bans: bans `user_id` game-wide. Idempotent on a
  // still-active ban of the same user (the existing row comes back,
  // updated in place); re-banning after expiry counts as a fresh ban
  // event. The user need not have been seen before (preemptive bans
  // work).
  [[nodiscard]] Result<Ban> add(std::string_view user_id, const AddBanOptions& options = {},
                                const CancellationToken& token = {}) const;

  // DELETE /v1/bans/:userId: lifts the game-wide ban. not_found when
  // no ban row exists or the user has never been seen in this game.
  [[nodiscard]] Result<void> remove(std::string_view user_id,
                                    const RemoveBanOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // GET /v1/bans/:userId: the user's current ACTIVE game-wide ban. An
  // empty optional means not banned: no row, an expired row (lazy
  // expiry, same contract as enforcement), or a never-seen user.
  // Mirrors the TS SDK's null-on-404 semantics; use list with
  // include_expired to see lapsed rows.
  [[nodiscard]] Result<std::optional<Ban>> get(std::string_view user_id,
                                               const RequestOptions& options = {},
                                               const CancellationToken& token = {}) const;

  // GET /v1/bans: cursor-paginated listing, newest first, active-only
  // by default. Drain with junjo::paginate (junjo/pagination.hpp).
  [[nodiscard]] Result<Page<Ban>> list(const ListBansOptions& options = {},
                                       const CancellationToken& token = {}) const;

  // GET /v1/bans/:userId/history: the user's append-only ban-event
  // timeline across both surfaces (game-wide and per-group), newest
  // first. A never-seen user yields an empty page. Cursor-paginated.
  [[nodiscard]] Result<Page<BanHistoryEntry>> history(
      std::string_view user_id, const ListBanHistoryOptions& options = {},
      const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit BansApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
