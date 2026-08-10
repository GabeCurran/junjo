// Junjo.io SDK for C++
//
// Domain value types mirroring the shared wire contracts
// (packages/shared/src/types.ts), plus the small cross-surface
// vocabulary every API call shares (RequestOptions, Page, Patch).
// Plain copyable structs; nullable wire fields are std::optional, JSON
// null and absent both map to nullopt.
#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

#include "junjo/export.hpp"
#include "junjo/preconditions.hpp"

namespace junjo {

// Options shared by calls that take nothing but the standard knobs.
// Calls with per-call fields define their own options struct (e.g.
// GetGroupOptions) carrying the same trailing `timeout` member.
struct RequestOptions {
  // Per-request override of the client-level timeout. A value <= 0
  // disables the timeout for this request.
  std::optional<std::chrono::milliseconds> timeout;
};

// One page of a cursor-paginated listing. `next_cursor` present means
// more pages exist: pass it as the next call's `cursor` option. Absent
// means this was the last page. See junjo/pagination.hpp for a helper
// that walks the pages for you.
template <typename T>
struct Page {
  std::vector<T> items;
  std::optional<std::string> next_cursor;
};

// A tri-state PATCH field: omitted (leave the server value untouched),
// cleared (send JSON null), or set to a value.
//
// Design note: the natural encoding std::optional<std::optional<T>>
// works but is hostile at call sites; `.passcode = std::nullopt` reads
// as "no passcode" while actually meaning "do not touch", and
// `{{"1234"}}` in aggregate init is inscrutable. A dedicated type
// names each state instead: default construction omits, a value sets
// (implicit, so `.passcode = "1234"` just works), and Patch::clear()
// sends null. Mirrors the TS SDK's undefined / null / string tri-state
// on update inputs.
template <typename T>
class Patch {
 public:
  // Omitted: the field is not sent at all.
  constexpr Patch() noexcept = default;

  // Set: the field is sent with this value. Implicit on purpose so
  // designated-initializer call sites stay terse.
  template <typename U,
            std::enable_if_t<std::is_constructible_v<T, U&&> &&
                                 !std::is_same_v<std::remove_cv_t<std::remove_reference_t<U>>,
                                                 Patch<T>>,
                             int> = 0>
  Patch(U&& value) : state_(State::Set), value_(std::forward<U>(value)) {}

  // Cleared: the field is sent as JSON null, clearing the server value.
  [[nodiscard]] static Patch clear() noexcept {
    Patch patch;
    patch.state_ = State::Cleared;
    return patch;
  }

  [[nodiscard]] bool is_omitted() const noexcept { return state_ == State::Omitted; }
  [[nodiscard]] bool is_cleared() const noexcept { return state_ == State::Cleared; }
  [[nodiscard]] bool has_value() const noexcept { return state_ == State::Set; }

  // Precondition: has_value(). Violation throws std::logic_error, or
  // terminates when compiled without exception support (programmer
  // error, matching the junjo::Result contract).
  [[nodiscard]] const T& value() const {
    if (!has_value()) {
      detail::precondition_violation("junjo::Patch::value() called on a patch with no value");
    }
    return *value_;
  }

 private:
  enum class State { Omitted, Cleared, Set };
  State state_ = State::Omitted;
  std::optional<T> value_;
};

// Identity of the API key the client was constructed with.
// From GET /v1/whoami.
struct KeyInfo {
  std::string game_id;
};

// A group. What a group means is the game's choice; the SDK does not
// interpret the taxonomy. Mirrors the shared Group contract.
//
// Timestamps are ISO 8601 strings exactly as the server sent them.
// TODO(junjo): decide the chrono story (std::chrono::sys_time via
// C++20 parse vs a small custom parser) before the surface grows;
// strings keep this slice honest instead of shipping a lossy parse.
struct Group {
  std::string id;
  std::string game_id;
  // Open taxonomy string chosen by the game. Stored verbatim by the
  // server, never interpreted.
  std::string kind;
  std::string name;
  // "public" | "invite-only" | "secret". Kept as a string rather than
  // an enum so a newer server introducing a visibility does not turn
  // into a client-side parse failure.
  std::string visibility;
  // The group's metadata object as raw JSON text (the SDK's JSON
  // library is an internal dependency and never appears in public
  // headers). Always a valid JSON object serialization, "{}" when
  // empty. Parse with the JSON library of your choice.
  std::string metadata_json;
  std::optional<std::string> default_role_id;
  // Absent = top-level group.
  std::optional<std::string> parent_group_id;
  std::int64_t member_count = 0;
  // True when the group has a passcode set; callers should prompt for
  // one before join. The plaintext passcode is never returned.
  bool has_passcode = false;
  std::string created_at;
  std::string updated_at;
  // Set when the group is soft-deleted and still inside its restore
  // window.
  std::optional<std::string> soft_deleted_at;
};

// Input for GroupsApi::create. Aggregate; brace-init the fields you
// need. Field limits are enforced server-side: kind <= 64 chars,
// name 1..120, passcode 4..128.
struct CreateGroupInput {
  std::string kind;
  std::string name;
  // "public" | "invite-only" | "secret"; server default is
  // "invite-only".
  std::optional<std::string> visibility;
  // Metadata object as raw JSON text (must serialize a JSON object,
  // e.g. R"({"motto":"onward"})"). A value that does not parse as a
  // JSON object fails the call client-side with InvalidConfig before
  // any request is made.
  std::optional<std::string> metadata_json;
  std::optional<std::string> default_role_id;
  // External user id of the creator; when set, the server atomically
  // adds them as an active member in the create transaction (works for
  // every visibility, unlike join which needs "public").
  std::optional<std::string> creator_user_id;
  // Optional shared-secret join gate, 4..128 chars. Stored hashed;
  // never returned by the API.
  std::optional<std::string> passcode;
};

// Input for GroupsApi::update (PATCH semantics: absent fields stay
// untouched). `default_role_id` and `passcode` are tri-state Patch
// fields because the wire distinguishes "leave alone" (omitted) from
// "clear" (null); see Patch for the encoding rationale.
struct UpdateGroupInput {
  std::optional<std::string> name;
  std::optional<std::string> visibility;
  // Replaces the whole metadata object when present. Same raw-JSON
  // contract as CreateGroupInput::metadata_json.
  std::optional<std::string> metadata_json;
  Patch<std::string> default_role_id;
  // Set = replace the passcode; clear() = remove the join gate; omit =
  // keep whatever is there.
  Patch<std::string> passcode;
};

// A group member. `status` is one of "active" | "invited" | "left" |
// "kicked" | "banned" (kept as a string for the same forward-compat
// reason as Group::visibility).
struct Member {
  std::string id;
  std::string group_id;
  // The game's external user id, exactly as your auth provider issues
  // it (never a Junjo-internal id).
  std::string user_id;
  std::string status;
  std::vector<std::string> roles;
  // Raw JSON object text; see Group::metadata_json.
  std::string metadata_json;
  // notes_public: visible to other group members. notes_private:
  // officer-only.
  std::optional<std::string> notes_public;
  std::optional<std::string> notes_private;
  std::string joined_at;
  // Only meaningful when status == "banned". Absent = permanent ban; a
  // timestamp in the past means the ban has lapsed (lazy expiry).
  std::optional<std::string> banned_until;
};

// Input for MembersApi::set_notes. Both fields are tri-state: set a
// string, clear() to null the note out, or leave omitted. Notes cap at
// 5000 chars server-side.
struct SetMemberNotesInput {
  Patch<std::string> notes_public;
  Patch<std::string> notes_private;
};

// A role within a group.
struct Role {
  std::string id;
  std::string group_id;
  std::string name;
  // Higher number = more authority.
  std::int64_t priority = 0;
  // 7-char hex color ("#ff5050") when set.
  std::optional<std::string> color;
  bool is_default = false;
  std::vector<std::string> permissions;
  std::string created_at;
};

// Input for RolesApi::create. Roles get permissions via
// RolesApi::grant_permission, never at creation time. Name caps at 64
// chars server-side; color must be a 7-char hex color.
struct CreateRoleInput {
  std::string name;
  std::int64_t priority = 0;
  std::optional<std::string> color;
  std::optional<bool> is_default;
};

// Input for RolesApi::update (PATCH semantics). `color` is tri-state:
// clear() removes the color, omit leaves it.
struct UpdateRoleInput {
  std::optional<std::string> name;
  std::optional<std::int64_t> priority;
  Patch<std::string> color;
  std::optional<bool> is_default;
};

// An invitation into a group. `target_user_id` absent = open invite
// (anyone with the code); set = addressed to that user.
struct Invitation {
  std::string id;
  std::string group_id;
  std::string code;
  std::optional<std::string> role_id;
  std::optional<std::string> target_user_id;
  // Absent when issued by the server itself with no acting user.
  std::optional<std::string> created_by;
  std::string created_at;
  // Absent = never expires.
  std::optional<std::string> expires_at;
  std::optional<std::string> used_at;
  std::optional<std::string> used_by;
};

// The composed invite link plus the invitation it points at, from
// GroupsApi::invite_by_link. `url` is invite_base_url + "/invite/" +
// the percent-encoded invitation code.
struct InviteByLinkResult {
  Invitation invitation;
  std::string url;
};

// One rejected row from GroupsApi::bulk_invite. `row` is the 1-indexed
// source line (blank lines counted) so the caller can map the failure
// back to the input. Rejections cover a user id over the server's
// length cap and a user id banned from the game or the group.
struct BulkInviteError {
  std::int64_t row = 0;
  std::string reason;
};

// Outcome of GroupsApi::bulk_invite. `invited` counts newly created
// invitations; `skipped` counts rows dropped without error (already an
// active member, a duplicate within the batch, or a pending invite
// already outstanding); `errors` carries per-row rejections. The server
// caps the batch at 1000 rows and each user id at 255 characters and
// enforces both; the SDK sends the body verbatim and imposes no cap of
// its own.
struct BulkInviteResult {
  std::int64_t invited = 0;
  std::int64_t skipped = 0;
  std::vector<BulkInviteError> errors;
};

// Where a permission-check decision came from. The server contract is
// closed (exactly these four); an unrecognized wire value fails the
// call as InvalidWireData rather than guessing.
enum class PermissionSource {
  // Granted through a role the member holds; see
  // PermissionCheckResult::via_role_id.
  Role,
  // A per-member override decided it (in either direction).
  Override,
  // No role or override mentioned the permission; the default (deny)
  // applied.
  Default,
  // The user is not an active member of the group (or does not exist).
  None,
};

// Result of Client::check.
struct PermissionCheckResult {
  bool allowed = false;
  PermissionSource source = PermissionSource::None;
  // When source == Role, the role that granted it; absent otherwise.
  std::optional<std::string> via_role_id;
};

// A per-member permission override (grant or revoke regardless of
// roles). From MembersApi::override_permission / list_permission_overrides.
struct MemberPermissionOverride {
  std::string group_id;
  std::string user_id;
  std::string permission;
  // true = grant regardless of roles; false = revoke regardless.
  bool grant = false;
  std::string set_at;
  // Absent when set by the server itself with no acting user.
  std::optional<std::string> set_by;
};

// A directed group-to-group relationship (A -> B). `type` is an open
// dev-defined string ("ally", "enemy", "trade-partner", ...).
struct GroupRelationship {
  std::string group_a_id;
  std::string group_b_id;
  std::string type;
  std::string since;
  // Absent when set by the server itself with no acting user.
  std::optional<std::string> set_by;
};

// A game-wide ban: the user cannot join or accept invitations into ANY
// group in the game while it is active. Per-group bans live on
// GroupsApi::ban as Member::status == "banned" instead; enforcement
// checks game-level first, then per-group.
struct Ban {
  std::string id;
  std::string game_id;
  // The dev's external user id, same convention as Member::user_id
  // (never a Junjo-internal id).
  std::string user_id;
  std::string banned_at;
  // Absent = permanent. A timestamp in the past means the ban has
  // lapsed (lazy expiry; the server does not auto-clean expired rows).
  std::optional<std::string> expires_at;
  std::optional<std::string> reason;
  // External user id of the acting moderator; absent when issued
  // server-side. Wire field: bannedBy.
  std::optional<std::string> banned_by;
};

// One row of a group's ban-event timeline (GroupsApi::ban_history).
// Append-only; one row per set/lift.
struct BanHistoryEntry {
  std::string id;
  std::string game_id;
  std::string user_id;
  // "game" | "group" (string for forward compatibility; group-scoped
  // history only ever returns "group" rows today).
  std::string scope;
  // Absent on game-wide rows.
  std::optional<std::string> group_id;
  // "set" = ban issued; "lifted" = explicitly removed (lazy expiry
  // writes no row).
  std::string kind;
  std::optional<std::string> reason;
  // Absent = permanent.
  std::optional<std::string> expires_at;
  std::string event_at;
  // Absent when issued server-side with no acting user.
  std::optional<std::string> actor_user_id;
};

// ---------------------------------------------------------------------
// Friends
//
// Identity note: several friends wire fields are named *JunjoUserId for
// historical reasons, but their VALUES are the dev's external user ids
// (resolved by the server before serialization; same convention as
// Member::user_id). The C++ structs drop the misleading "junjo" from
// the field names and note the wire name where they differ.
// ---------------------------------------------------------------------

// A pending friend request.
struct FriendRequest {
  std::string id;
  std::string game_id;
  // The original sender. Wire field: actorJunjoUserId.
  std::string actor_user_id;
  // The original target. Wire field: targetJunjoUserId.
  std::string target_user_id;
  std::string created_at;
};

// One side of a mutual friendship, from the queried user's point of
// view: `user_id` is the OTHER party.
struct Friendship {
  std::string id;
  std::string game_id;
  // The other party. Wire field: junjoUserId.
  std::string user_id;
  // Friendship start (the accept time; for auto-accepted pairs, the
  // send time).
  std::string since;
};

// Outcome discriminator of FriendRequestsApi::send. The server
// contract is closed (exactly these two); an unrecognized wire value
// fails the call as InvalidWireData because the status decides which
// payload field is meaningful and a guess would leave both dead.
enum class FriendRequestStatus {
  // A request row was created and awaits the target's answer;
  // FriendRequestSendResult::request is populated.
  Pending,
  // The game runs with requestsRequired=false (the request WAS the
  // acceptance); FriendRequestSendResult::friendship is populated.
  AutoAccepted,
};

// Stable wire name for a FriendRequestStatus ("pending" /
// "auto-accepted"). The returned view points at a string literal with
// static storage duration.
[[nodiscard]] JUNJO_API std::string_view to_string(FriendRequestStatus status) noexcept;

// Result of FriendRequestsApi::send; see FriendRequestStatus for which
// optional is populated.
struct FriendRequestSendResult {
  FriendRequestStatus status = FriendRequestStatus::Pending;
  std::optional<FriendRequest> request;
  std::optional<Friendship> friendship;
};

// A user's pending friend requests, both directions. A direction
// filtered out by ListFriendRequestsOptions::direction comes back
// empty.
struct FriendRequestList {
  std::vector<FriendRequest> inbound;
  std::vector<FriendRequest> outbound;
};

// A user-to-user block, from the queried user's point of view.
struct Block {
  std::string id;
  std::string game_id;
  // The blocked party. Wire field: junjoUserId.
  std::string user_id;
  std::string blocked_at;
};

// A per-user label pinned on friends. Tags are per-(user, game) and
// private to their owner; each party tags a friendship independently.
struct FriendTag {
  std::string id;
  std::string game_id;
  // The tag owner. Wire field: junjoUserId.
  std::string user_id;
  std::string name;
  // 7-char hex color ("#ff5050") when set.
  std::optional<std::string> color;
  std::string created_at;
};

// Result of FriendTagsApi::assign: the friend's full tag set after the
// replace.
struct FriendTagAssignment {
  // Wire field: friendJunjoUserId.
  std::string friend_user_id;
  std::vector<std::string> tag_ids;
};

// Who may see a user's friends list. Carries an Unknown enumerator so
// a newer server adding a visibility level does not turn into a
// client-side parse failure; Unknown is never valid as an input
// (FriendVisibilityApi::set rejects it with InvalidConfig).
enum class FriendsListVisibility {
  // Wire: "private".
  Private,
  // Wire: "friends-only".
  FriendsOnly,
  // Wire: "public".
  Public,
  // A wire value this SDK version does not know (forward
  // compatibility). See friends_list_visibility_from_wire.
  Unknown,
};

// Stable wire name for a FriendsListVisibility ("friends-only");
// Unknown maps to "unknown". The returned view points at a string
// literal with static storage duration.
[[nodiscard]] JUNJO_API std::string_view to_string(FriendsListVisibility visibility) noexcept;

// Maps a wire string to the matching FriendsListVisibility;
// unrecognized strings map to FriendsListVisibility::Unknown.
[[nodiscard]] JUNJO_API FriendsListVisibility friends_list_visibility_from_wire(
    std::string_view wire) noexcept;

// A user's friends-list visibility settings. From
// FriendVisibilityApi::get / set.
struct UserVisibilitySettings {
  std::string game_id;
  // Wire field: junjoUserId.
  std::string user_id;
  FriendsListVisibility friends_list_visibility = FriendsListVisibility::Private;
  // The game-config allowlist the user may pick from.
  std::vector<FriendsListVisibility> allowed;
  // Absent until the user first overrides the game default.
  std::optional<std::string> updated_at;
};

// A mutual-friend suggestion from FriendsApi::suggestions.
struct FriendSuggestion {
  // The suggested user. Wire field: junjoUserId.
  std::string user_id;
  std::int64_t mutual_count = 0;
  // Up to 5 of the mutual friends, for "you know A, B, +3 others"
  // affordances. Wire field: sampleMutualJunjoUserIds.
  std::vector<std::string> sample_mutual_user_ids;
};

// The viewer-perspective relationship state between two users. Carries
// an Unknown enumerator so a newer server adding a state does not turn
// into a client-side parse failure.
enum class FriendshipState {
  // Mutual friendship exists. Wire: "friends".
  Friends,
  // Viewer has sent a request to other, awaiting. Wire:
  // "request_outgoing".
  RequestOutgoing,
  // Other has sent a request to viewer, awaiting. Wire:
  // "request_incoming".
  RequestIncoming,
  // Viewer has blocked other. Wire: "blocked_by_me".
  BlockedByMe,
  // Other has blocked viewer. Wire: "blocked_by_them".
  BlockedByThem,
  // No relationship. Wire: "none".
  None,
  // A wire value this SDK version does not know (forward
  // compatibility). See friendship_state_from_wire.
  Unknown,
};

// Stable wire name for a FriendshipState ("request_outgoing"); Unknown
// maps to "unknown". The returned view points at a string literal with
// static storage duration.
[[nodiscard]] JUNJO_API std::string_view to_string(FriendshipState state) noexcept;

// Maps a wire string to the matching FriendshipState; unrecognized
// strings map to FriendshipState::Unknown.
[[nodiscard]] JUNJO_API FriendshipState friendship_state_from_wire(std::string_view wire) noexcept;

// Result of FriendsApi::get_relationship. `since` semantics by state:
// Friends = friendship start, Request* = when the request was sent,
// Blocked* = when the block happened, None = absent.
struct FriendshipRelationship {
  FriendshipState state = FriendshipState::None;
  std::optional<std::string> since;
};

// ---------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------

// One row of a group's audit log (AuditApi::list). `action` is one of
// the server's audit-action strings ("member.kicked", "role.created",
// ...); kept as a string so a newer server adding an action is not a
// client-side parse failure.
struct AuditEntry {
  std::string id;
  std::string group_id;
  // Absent when the action was taken by the system (e.g. invitation
  // expiry).
  std::optional<std::string> actor_user_id;
  std::string action;
  // Free-form pointer to whatever the action targeted: a user id, role
  // id, permission key. Shape depends on `action`.
  std::optional<std::string> target_id;
  // Action-specific detail as raw JSON object text; same contract as
  // Group::metadata_json. Wire field: payload.
  std::string payload_json;
  std::string created_at;
};

// ---------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------

// Wire format the delivery worker applies to a webhook endpoint.
// Carries an Unknown enumerator so a newer server adding a format does
// not turn every endpoint listing into a client-side parse failure;
// Unknown is never valid as an input (create/update reject it with
// InvalidConfig).
enum class WebhookFormat {
  // Raw JunjoEvent JSON with HMAC signature headers (the default). See
  // junjo/webhooks.hpp verify_webhook.
  Junjo,
  // Discord-shaped payload posted to a Discord webhook URL; no HMAC
  // (Discord authenticates via the URL token).
  Discord,
  // Slack-shaped payload posted to a Slack webhook URL; no HMAC.
  Slack,
  // A wire value this SDK version does not know (forward
  // compatibility). See webhook_format_from_wire.
  Unknown,
};

// Stable wire name for a WebhookFormat ("junjo"); Unknown maps to
// "unknown". The returned view points at a string literal with static
// storage duration.
[[nodiscard]] JUNJO_API std::string_view to_string(WebhookFormat format) noexcept;

// Maps a wire string to the matching WebhookFormat; unrecognized
// strings map to WebhookFormat::Unknown.
[[nodiscard]] JUNJO_API WebhookFormat webhook_format_from_wire(std::string_view wire) noexcept;

// A webhook endpoint registration. The signing secret is NOT part of
// this shape; it is surfaced exactly once, on create (see
// WebhookEndpointWithSecret).
struct WebhookEndpoint {
  std::string id;
  std::string game_id;
  std::string url;
  // Subscribed event-type strings ("member.joined", ...). Empty =
  // match every event type. Kept as strings so a newer server's event
  // types round-trip untouched.
  std::vector<std::string> events;
  WebhookFormat format = WebhookFormat::Junjo;
  std::string created_at;
  // Set = the endpoint is muted: matching events do not enqueue
  // deliveries.
  std::optional<std::string> disabled_at;
};

// Returned exactly once, by WebhookEndpointsApi::create. Persist the
// secret immediately: list and update never surface it again.
struct WebhookEndpointWithSecret : WebhookEndpoint {
  std::string secret;
};

}  // namespace junjo
