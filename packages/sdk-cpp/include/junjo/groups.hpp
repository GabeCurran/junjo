// Junjo.io SDK for C++
//
// Groups API surface: CRUD, membership (join/leave/kick, per-group
// bans, invitations), group relationships, and sub-group hierarchy.
// Obtained via Client::groups(); the returned value shares the
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

// Options for GroupsApi::get.
struct GetGroupOptions {
  // External user id to scope visibility to. Secret groups the viewer
  // is not an active member of come back as "not found" (empty
  // optional). Without a viewer the call is treated as admin/server
  // side and sees everything.
  std::optional<std::string> viewer;
  // Per-request override of the client-level timeout. A value <= 0
  // disables the timeout for this request.
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::list.
struct ListGroupsOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  // Same visibility scoping as GetGroupOptions::viewer: secret groups
  // the viewer is not a member of are filtered out.
  std::optional<std::string> viewer;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::remove.
struct RemoveGroupOptions {
  // Soft delete by default (7-day undo window; see GroupsApi::restore).
  // true bypasses the window and deletes permanently.
  bool hard = false;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::join.
struct JoinGroupOptions {
  // Required when the group has a passcode set (Group::has_passcode);
  // the server answers passcode_required / passcode_invalid otherwise.
  std::optional<std::string> passcode;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::kick.
struct KickMemberOptions {
  // Recorded in the audit trail; capped at 500 chars server-side.
  std::optional<std::string> reason;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::ban.
struct BanMemberOptions {
  // Recorded on the ban; capped at 500 chars server-side.
  std::optional<std::string> reason;
  // ISO 8601 timestamp ending the ban; absent = permanent.
  std::optional<std::string> expires_at;
  // External user id of the acting moderator, for audit attribution.
  std::optional<std::string> actor_user_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::unban.
struct UnbanMemberOptions {
  // External user id of the acting moderator, for audit attribution.
  std::optional<std::string> actor_user_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::ban_history.
struct BanHistoryOptions {
  std::optional<int> limit;
  std::optional<std::string> cursor;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::invite_by_user_id.
struct InviteByUserIdOptions {
  // Role granted on accept.
  std::optional<std::string> role_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::invite_by_code.
struct InviteByCodeOptions {
  // Role granted on accept.
  std::optional<std::string> role_id;
  // Lifetime as <positive integer><unit> with unit s|m|h|d ("7d",
  // "1h"); absent = never expires.
  std::optional<std::string> expires_in;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::invite_by_link.
struct InviteByLinkOptions {
  // Role granted on accept.
  std::optional<std::string> role_id;
  // Lifetime as <positive integer><unit> with unit s|m|h|d ("7d",
  // "1h"); absent = never expires.
  std::optional<std::string> expires_in;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::bulk_invite.
struct BulkInviteOptions {
  // Role granted to every invited user on accept.
  std::optional<std::string> role_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::decline_invitation.
struct DeclineInvitationOptions {
  // External user id of the decliner; recorded in the audit trail.
  std::optional<std::string> user_id;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::set_relationship.
struct SetRelationshipOptions {
  // true writes both directed rows (A -> B and B -> A) atomically.
  std::optional<bool> mutual;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for GroupsApi::clear_relationship.
struct ClearRelationshipOptions {
  // true clears both directed rows.
  bool mutual = false;
  std::optional<std::chrono::milliseconds> timeout;
};

// Group operations. Cheap to copy (shares the client's executor);
// thread-safe to the same degree as the Client it came from.
class JUNJO_API GroupsApi {
 public:
  // POST /v1/groups. When `input.creator_user_id` is set the creator
  // becomes an active member atomically with the group insert; useful
  // for non-public groups the creator could not reach through join.
  [[nodiscard]] Result<Group> create(const CreateGroupInput& input,
                                     const RequestOptions& options = {},
                                     const CancellationToken& token = {}) const;

  // Fetches a group by id. An empty optional means the group does not
  // exist (or is invisible to `options.viewer`); every other failure,
  // transport included, is an Error. Mirrors the TS SDK's null-on-404
  // semantics.
  [[nodiscard]] Result<std::optional<Group>> get(std::string_view id,
                                                 const GetGroupOptions& options = {},
                                                 const CancellationToken& token = {}) const;

  // GET /v1/groups: cursor-paginated listing. Feed Page::next_cursor
  // back through `options.cursor` for the next page, or drain with
  // junjo::paginate (junjo/pagination.hpp).
  [[nodiscard]] Result<Page<Group>> list(const ListGroupsOptions& options = {},
                                         const CancellationToken& token = {}) const;

  // ------ Async variants ------
  //
  // Same contract as the Client-level async methods (see the async
  // section in junjo/client.hpp): the sync call, posted to a caller
  // owned Executor, arguments copied, future valid past the Client's
  // lifetime, token semantics unchanged.

  // create, asynchronously.
  [[nodiscard]] std::future<Result<Group>> create_async(
      Executor& executor, const CreateGroupInput& input, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // get, asynchronously.
  [[nodiscard]] std::future<Result<std::optional<Group>>> get_async(
      Executor& executor, std::string_view id, const GetGroupOptions& options = {},
      const CancellationToken& token = {}) const;

  // list, asynchronously.
  [[nodiscard]] std::future<Result<Page<Group>>> list_async(
      Executor& executor, const ListGroupsOptions& options = {},
      const CancellationToken& token = {}) const;

  // PATCH /v1/groups/:id. Absent input fields stay untouched; see
  // UpdateGroupInput for the tri-state passcode / default_role_id
  // semantics.
  [[nodiscard]] Result<Group> update(std::string_view id, const UpdateGroupInput& input,
                                     const RequestOptions& options = {},
                                     const CancellationToken& token = {}) const;

  // DELETE /v1/groups/:id. Soft delete with a 7-day undo window by
  // default; `options.hard` bypasses it. Named remove because delete
  // is a C++ keyword.
  [[nodiscard]] Result<void> remove(std::string_view id, const RemoveGroupOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/restore: undoes a soft delete while the
  // restore window is open (restore_window_expired afterwards).
  [[nodiscard]] Result<Group> restore(std::string_view id, const RequestOptions& options = {},
                                      const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/join: open join. The server requires
  // visibility "public" (403 for invite-only, 404 for secret) and the
  // group's passcode when one is set (JoinGroupOptions::passcode).
  [[nodiscard]] Result<Member> join(std::string_view group_id, std::string_view user_id,
                                    const JoinGroupOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/leave.
  [[nodiscard]] Result<Member> leave(std::string_view group_id, std::string_view user_id,
                                     const RequestOptions& options = {},
                                     const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/members/:userId/kick. Unlike ban, a kicked
  // user may rejoin.
  [[nodiscard]] Result<Member> kick(std::string_view group_id, std::string_view user_id,
                                    const KickMemberOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/members/:userId/ban: per-group ban. The banned
  // user cannot rejoin via join or invitation accept (the routes
  // answer 403 code "banned"). `options.expires_at` makes it
  // time-bounded; absent = permanent.
  [[nodiscard]] Result<Member> ban(std::string_view group_id, std::string_view user_id,
                                   const BanMemberOptions& options = {},
                                   const CancellationToken& token = {}) const;

  // DELETE /v1/groups/:id/members/:userId/ban.
  [[nodiscard]] Result<Member> unban(std::string_view group_id, std::string_view user_id,
                                     const UnbanMemberOptions& options = {},
                                     const CancellationToken& token = {}) const;

  // GET /v1/groups/:id/bans/history: this group's ban-event timeline
  // (every set/lift across all users, newest first). Game-wide bans
  // are not included. Cursor-paginated.
  [[nodiscard]] Result<Page<BanHistoryEntry>> ban_history(
      std::string_view group_id, const BanHistoryOptions& options = {},
      const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/invitations addressed to one user.
  [[nodiscard]] Result<Invitation> invite_by_user_id(
      std::string_view group_id, std::string_view user_id,
      const InviteByUserIdOptions& options = {}, const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/invitations as an open invite: anyone holding
  // the returned Invitation::code can accept.
  [[nodiscard]] Result<Invitation> invite_by_code(std::string_view group_id,
                                                  const InviteByCodeOptions& options = {},
                                                  const CancellationToken& token = {}) const;

  // Creates an open invitation (POST /v1/groups/:id/invitations) and
  // composes an accept URL from the client's invite_base_url and the
  // returned code. Fails with ErrorCode::InvalidConfig, before any
  // request, when invite_base_url was not set on the ClientConfig (the
  // API origin serves no invite page, so no URL could be minted); use
  // invite_by_code when only the code is needed.
  [[nodiscard]] Result<InviteByLinkResult> invite_by_link(
      std::string_view group_id, const InviteByLinkOptions& options = {},
      const CancellationToken& token = {}) const;

  // POST /v1/groups/:id/bulk-invite. Sends `csv` verbatim as the
  // request body (one external user id per line) with content type
  // text/csv; the server mints one invitation per new row. The server
  // caps the batch at 1000 rows and each user id at 255 characters and
  // enforces both; see BulkInviteResult for how invited, skipped, and
  // errored rows are reported. A large upload can outlive the default
  // timeout: raise options.timeout (or set it <= 0 to disable) when
  // feeding big lists.
  [[nodiscard]] Result<BulkInviteResult> bulk_invite(
      std::string_view group_id, std::string_view csv, const BulkInviteOptions& options = {},
      const CancellationToken& token = {}) const;

  // POST /v1/invitations/:code/accept: joins `user_id` to the
  // invitation's group.
  [[nodiscard]] Result<Member> accept_invitation(std::string_view code, std::string_view user_id,
                                                 const RequestOptions& options = {},
                                                 const CancellationToken& token = {}) const;

  // POST /v1/invitations/:code/decline.
  [[nodiscard]] Result<void> decline_invitation(std::string_view code,
                                                const DeclineInvitationOptions& options = {},
                                                const CancellationToken& token = {}) const;

  // PUT /v1/groups/:a/relationships/:b: sets the directed A -> B
  // relationship (both directions with `options.mutual`).
  [[nodiscard]] Result<GroupRelationship> set_relationship(
      std::string_view group_a_id, std::string_view group_b_id, std::string_view type,
      const SetRelationshipOptions& options = {}, const CancellationToken& token = {}) const;

  // DELETE /v1/groups/:a/relationships/:b. Idempotent: clearing a
  // relationship that does not exist still succeeds.
  [[nodiscard]] Result<void> clear_relationship(std::string_view group_a_id,
                                                std::string_view group_b_id,
                                                const ClearRelationshipOptions& options = {},
                                                const CancellationToken& token = {}) const;

  // GET /v1/groups/:a/relationships/:b. An empty optional means no
  // A -> B relationship exists (null-on-404, like get).
  [[nodiscard]] Result<std::optional<GroupRelationship>> get_relationship(
      std::string_view group_a_id, std::string_view group_b_id,
      const RequestOptions& options = {}, const CancellationToken& token = {}) const;

  // GET /v1/groups/:id/relationships: every outgoing relationship of
  // the group.
  [[nodiscard]] Result<std::vector<GroupRelationship>> list_relationships(
      std::string_view group_id, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

  // PUT /v1/groups/:id/parent: places the group under
  // `parent_group_id`, or clears the parent (making it top-level) when
  // nullopt is passed; the wire body carries an explicit JSON null in
  // that case, matching the route contract. Cycles are rejected
  // server-side (parent_cycle).
  [[nodiscard]] Result<Group> set_parent(std::string_view group_id,
                                         const std::optional<std::string>& parent_group_id,
                                         const RequestOptions& options = {},
                                         const CancellationToken& token = {}) const;

  // GET /v1/groups/:id/children: direct sub-groups only (one level).
  [[nodiscard]] Result<std::vector<Group>> list_children(
      std::string_view group_id, const RequestOptions& options = {},
      const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit GroupsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
