// Junjo.io SDK for C++
//
// Friends API surface: friendships plus the requests / blocks / tags /
// visibility sub-surfaces, mirroring the TS SDK's nesting
// (friends.requests, friends.blocks, ...). Obtained via
// Client::friends(); each returned value (including the sub-surface
// accessors' results) shares the client's internals, so it stays valid
// independently of the Client object it came from.
//
// Server note: every friends route 404s when the game's friends
// feature is disabled in its config (feature absence is deliberately
// indistinguishable from a missing resource).
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
class FriendsApi;

// Options for FriendRequestsApi::list.
struct ListFriendRequestsOptions {
  // "in" | "out" | "both" (server default "both"). A filtered-out
  // direction comes back as an empty vector.
  std::optional<std::string> direction;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for FriendsApi::list.
struct ListFriendsOptions {
  // Page size; server default 50, capped server-side.
  std::optional<int> limit;
  // Cursor from the previous page's Page::next_cursor.
  std::optional<std::string> cursor;
  // Filter to friends carrying this tag. Tags are per-game, so tag
  // filtering never spans a friend network.
  std::optional<std::string> tag_id;
  // External user id to evaluate the owner's friends-list visibility
  // against; a blocked viewer gets not_found. Without a viewer the
  // API-key caller is treated as admin and sees everything.
  std::optional<std::string> viewer;
  std::optional<std::chrono::milliseconds> timeout;
};

// Options for FriendsApi::suggestions.
struct FriendSuggestionsOptions {
  // Maximum suggestions returned; server default 20, capped at 50.
  std::optional<int> limit;
  std::optional<std::chrono::milliseconds> timeout;
};

// Input for FriendTagsApi::create. Name caps at 64 chars server-side
// and must be unique per user; color must be a 7-char hex color.
struct CreateFriendTagInput {
  std::string name;
  std::optional<std::string> color;
};

// Input for FriendTagsApi::update (PATCH semantics). `color` is
// tri-state: clear() removes the color, omit leaves it. At least one
// field must be present or the server answers bad_request.
struct UpdateFriendTagInput {
  std::optional<std::string> name;
  Patch<std::string> color;
};

// Friend requests: list, send, accept, decline, cancel. Cheap to copy
// (shares the client's executor); thread-safe to the same degree as
// the Client it came from.
class JUNJO_API FriendRequestsApi {
 public:
  // GET /v1/users/:userId/friend-requests: the user's pending
  // requests, inbound and outbound (filter with options.direction). A
  // never-seen user yields two empty vectors.
  [[nodiscard]] Result<FriendRequestList> list(std::string_view user_id,
                                               const ListFriendRequestsOptions& options = {},
                                               const CancellationToken& token = {}) const;

  // POST /v1/users/:userId/friend-requests: sends a request from
  // `user_id` to `target_user_id`. The result's status says what
  // happened: Pending (a request row awaits the target) or
  // AutoAccepted (games without required requests; the friendship is
  // returned directly). Blocked pairs answer not_found; duplicates and
  // cap overflows answer bad_request.
  [[nodiscard]] Result<FriendRequestSendResult> send(std::string_view user_id,
                                                     std::string_view target_user_id,
                                                     const RequestOptions& options = {},
                                                     const CancellationToken& token = {}) const;

  // POST /v1/friend-requests/:id/accept: the recipient accepts;
  // returns the new friendship from the original sender's point of
  // view.
  [[nodiscard]] Result<Friendship> accept(std::string_view request_id,
                                          const RequestOptions& options = {},
                                          const CancellationToken& token = {}) const;

  // POST /v1/friend-requests/:id/decline: the recipient says no.
  [[nodiscard]] Result<void> decline(std::string_view request_id,
                                     const RequestOptions& options = {},
                                     const CancellationToken& token = {}) const;

  // DELETE /v1/friend-requests/:id: the original sender retracts.
  [[nodiscard]] Result<void> cancel(std::string_view request_id,
                                    const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

 private:
  friend class FriendsApi;
  explicit FriendRequestsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

// User-to-user blocks. Blocking removes any friendship or pending
// request between the pair and silently hides the blocker from future
// requests.
class JUNJO_API BlocksApi {
 public:
  // GET /v1/users/:userId/blocks: everyone the user has blocked
  // (not paginated; capped server-side).
  [[nodiscard]] Result<std::vector<Block>> list(std::string_view user_id,
                                                const RequestOptions& options = {},
                                                const CancellationToken& token = {}) const;

  // POST /v1/users/:userId/blocks: blocks `target_user_id`. Idempotent
  // on an existing block (the existing row comes back).
  [[nodiscard]] Result<Block> add(std::string_view user_id, std::string_view target_user_id,
                                  const RequestOptions& options = {},
                                  const CancellationToken& token = {}) const;

  // DELETE /v1/users/:userId/blocks/:otherUserId.
  [[nodiscard]] Result<void> remove(std::string_view user_id, std::string_view other_user_id,
                                    const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

 private:
  friend class FriendsApi;
  explicit BlocksApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

// Per-user friend tags: private labels a user pins on their friends.
// Each party tags a friendship independently; tags never cross games.
class JUNJO_API FriendTagsApi {
 public:
  // GET /v1/users/:userId/friend-tags: the user's tags, name-ordered.
  [[nodiscard]] Result<std::vector<FriendTag>> list(std::string_view user_id,
                                                    const RequestOptions& options = {},
                                                    const CancellationToken& token = {}) const;

  // POST /v1/users/:userId/friend-tags.
  [[nodiscard]] Result<FriendTag> create(std::string_view user_id,
                                         const CreateFriendTagInput& input,
                                         const RequestOptions& options = {},
                                         const CancellationToken& token = {}) const;

  // PATCH /v1/friend-tags/:id: rename and/or recolor; see
  // UpdateFriendTagInput for the tri-state color semantics.
  [[nodiscard]] Result<FriendTag> update(std::string_view tag_id,
                                         const UpdateFriendTagInput& input,
                                         const RequestOptions& options = {},
                                         const CancellationToken& token = {}) const;

  // DELETE /v1/friend-tags/:id. Assignments of the tag are cleared
  // with it. Named remove because delete is a C++ keyword.
  [[nodiscard]] Result<void> remove(std::string_view tag_id, const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // PUT /v1/users/:userId/friends/:otherUserId/tags: replaces the FULL
  // tag set on that friendship (PUT semantics; an empty vector clears
  // every tag). Every tag must belong to `user_id` in this game.
  [[nodiscard]] Result<FriendTagAssignment> assign(std::string_view user_id,
                                                   std::string_view other_user_id,
                                                   const std::vector<std::string>& tag_ids,
                                                   const RequestOptions& options = {},
                                                   const CancellationToken& token = {}) const;

 private:
  friend class FriendsApi;
  explicit FriendTagsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

// Per-user friends-list visibility settings.
class JUNJO_API FriendVisibilityApi {
 public:
  // GET /v1/users/:userId/visibility. `updated_at` stays absent until
  // the user first overrides the game default.
  [[nodiscard]] Result<UserVisibilitySettings> get(std::string_view user_id,
                                                   const RequestOptions& options = {},
                                                   const CancellationToken& token = {}) const;

  // PATCH /v1/users/:userId/visibility: sets the user's friends-list
  // visibility. The value must be in the game's allowlist
  // (UserVisibilitySettings::allowed); FriendsListVisibility::Unknown
  // fails client-side with InvalidConfig before any request is made.
  [[nodiscard]] Result<UserVisibilitySettings> set(std::string_view user_id,
                                                   FriendsListVisibility visibility,
                                                   const RequestOptions& options = {},
                                                   const CancellationToken& token = {}) const;

 private:
  friend class FriendsApi;
  explicit FriendVisibilityApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

// The Friends subsystem: friendships plus the requests / blocks /
// tags / visibility sub-surfaces. Cheap to copy (shares the client's
// executor); thread-safe to the same degree as the Client it came
// from.
class JUNJO_API FriendsApi {
 public:
  // The sub-surfaces. Each returned value shares this client's
  // internals and remains valid after the FriendsApi (and Client) are
  // destroyed.
  [[nodiscard]] FriendRequestsApi requests() const noexcept;
  [[nodiscard]] BlocksApi blocks() const noexcept;
  [[nodiscard]] FriendTagsApi tags() const noexcept;
  [[nodiscard]] FriendVisibilityApi visibility() const noexcept;

  // GET /v1/users/:userId/friends: cursor-paginated friends list,
  // newest friendship first. Feed Page::next_cursor back through
  // options.cursor, or drain with junjo::paginate
  // (junjo/pagination.hpp). A never-seen user yields an empty page.
  [[nodiscard]] Result<Page<Friendship>> list(std::string_view user_id,
                                              const ListFriendsOptions& options = {},
                                              const CancellationToken& token = {}) const;

  // DELETE /v1/users/:userId/friends/:otherUserId: ends the
  // friendship. Symmetric; both sides' rows go.
  [[nodiscard]] Result<void> remove(std::string_view user_id, std::string_view other_user_id,
                                    const RequestOptions& options = {},
                                    const CancellationToken& token = {}) const;

  // GET /v1/users/:viewerUserId/friends/:otherUserId/relationship:
  // single-pair viewer-perspective probe, made for rendering a friend
  // button on a profile view in one round-trip. NOT null-on-404: no
  // relationship (including either user being unseen) comes back as
  // state None, and not_found only means the friends feature is off.
  // Resolution priority is baked in server-side: blocks first (the
  // viewer's own block wins the both-blocked edge case), then
  // friendship, then pending request direction, then None.
  [[nodiscard]] Result<FriendshipRelationship> get_relationship(
      std::string_view viewer_user_id, std::string_view other_user_id,
      const RequestOptions& options = {}, const CancellationToken& token = {}) const;

  // GET /v1/users/:userId/friends/suggestions: ranked mutual-friend
  // suggestions, each carrying its mutual count and a small sample of
  // the mutual friends.
  [[nodiscard]] Result<std::vector<FriendSuggestion>> suggestions(
      std::string_view user_id, const FriendSuggestionsOptions& options = {},
      const CancellationToken& token = {}) const;

 private:
  friend class Client;
  explicit FriendsApi(std::shared_ptr<const detail::RequestExecutor> executor) noexcept;

  std::shared_ptr<const detail::RequestExecutor> executor_;
};

}  // namespace junjo
