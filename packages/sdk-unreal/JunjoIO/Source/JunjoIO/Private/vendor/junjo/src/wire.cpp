// Junjo.io SDK for C++

#include "wire.hpp"

#include <cstdint>
#include <limits>

namespace junjo::detail {

Error wire_error(std::string message, int status) {
  return Error{
      .code = ErrorCode::InvalidWireData, .message = std::move(message), .status = status};
}

bool read_string(const Json& obj, const char* key, std::string& out) {
  const auto it = obj.find(key);
  if (it == obj.end() || !it->is_string()) return false;
  out = it->get<std::string>();
  return true;
}

bool read_nullable_string(const Json& obj, const char* key, std::optional<std::string>& out) {
  const auto it = obj.find(key);
  if (it == obj.end() || it->is_null()) {
    out = std::nullopt;
    return true;
  }
  if (!it->is_string()) return false;
  out = it->get<std::string>();
  return true;
}

bool read_bool(const Json& obj, const char* key, bool& out) {
  const auto it = obj.find(key);
  if (it == obj.end() || !it->is_boolean()) return false;
  out = it->get<bool>();
  return true;
}

bool read_int64(const Json& obj, const char* key, std::int64_t& out) {
  const auto it = obj.find(key);
  if (it == obj.end() || !it->is_number_integer()) return false;
  // A wire value above INT64_MAX parses into nlohmann's unsigned
  // storage and still passes is_number_integer(); get<int64_t> would
  // wrap it, so anything the signed range cannot hold is invalid.
  if (it->is_number_unsigned() &&
      it->get<std::uint64_t>() >
          static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
    return false;
  }
  out = it->get<std::int64_t>();
  return true;
}

bool read_string_array(const Json& obj, const char* key, std::vector<std::string>& out) {
  const auto it = obj.find(key);
  if (it == obj.end() || !it->is_array()) return false;
  std::vector<std::string> items;
  items.reserve(it->size());
  for (const Json& element : *it) {
    if (!element.is_string()) return false;
    items.push_back(element.get<std::string>());
  }
  out = std::move(items);
  return true;
}

bool read_metadata(const Json& obj, const char* key, std::string& out) {
  const auto it = obj.find(key);
  if (it != obj.end() && it->is_object()) {
    out = it->dump();
    return true;
  }
  if (it == obj.end() || it->is_null()) {
    // Absent metadata is tolerated as empty rather than rejected; the
    // server always sends it today.
    out = "{}";
    return true;
  }
  return false;
}

Result<Group> deserialize_group(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("group response was not a JSON object", status);
  }
  Group group;
  if (!read_string(wire, "id", group.id) || !read_string(wire, "gameId", group.game_id) ||
      !read_string(wire, "kind", group.kind) || !read_string(wire, "name", group.name) ||
      !read_string(wire, "visibility", group.visibility) ||
      !read_string(wire, "createdAt", group.created_at) ||
      !read_string(wire, "updatedAt", group.updated_at)) {
    return wire_error("group is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "defaultRoleId", group.default_role_id) ||
      !read_nullable_string(wire, "parentGroupId", group.parent_group_id) ||
      !read_nullable_string(wire, "softDeletedAt", group.soft_deleted_at)) {
    return wire_error("group has a mistyped nullable field", status);
  }
  if (!read_int64(wire, "memberCount", group.member_count)) {
    return wire_error("group is missing integer field memberCount", status);
  }
  if (!read_bool(wire, "hasPasscode", group.has_passcode)) {
    return wire_error("group is missing boolean field hasPasscode", status);
  }
  if (!read_metadata(wire, "metadata", group.metadata_json)) {
    return wire_error("group field metadata was not a JSON object", status);
  }
  return group;
}

Result<Member> deserialize_member(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("member response was not a JSON object", status);
  }
  Member member;
  if (!read_string(wire, "id", member.id) || !read_string(wire, "groupId", member.group_id) ||
      !read_string(wire, "userId", member.user_id) ||
      !read_string(wire, "status", member.status) ||
      !read_string(wire, "joinedAt", member.joined_at)) {
    return wire_error("member is missing a required string field", status);
  }
  if (!read_string_array(wire, "roles", member.roles)) {
    return wire_error("member is missing string-array field roles", status);
  }
  if (!read_nullable_string(wire, "notesPublic", member.notes_public) ||
      !read_nullable_string(wire, "notesPrivate", member.notes_private) ||
      !read_nullable_string(wire, "bannedUntil", member.banned_until)) {
    return wire_error("member has a mistyped nullable field", status);
  }
  if (!read_metadata(wire, "metadata", member.metadata_json)) {
    return wire_error("member field metadata was not a JSON object", status);
  }
  return member;
}

Result<Role> deserialize_role(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("role response was not a JSON object", status);
  }
  Role role;
  if (!read_string(wire, "id", role.id) || !read_string(wire, "groupId", role.group_id) ||
      !read_string(wire, "name", role.name) || !read_string(wire, "createdAt", role.created_at)) {
    return wire_error("role is missing a required string field", status);
  }
  if (!read_int64(wire, "priority", role.priority)) {
    return wire_error("role is missing integer field priority", status);
  }
  if (!read_nullable_string(wire, "color", role.color)) {
    return wire_error("role field color was not a string or null", status);
  }
  if (!read_bool(wire, "isDefault", role.is_default)) {
    return wire_error("role is missing boolean field isDefault", status);
  }
  if (!read_string_array(wire, "permissions", role.permissions)) {
    return wire_error("role is missing string-array field permissions", status);
  }
  return role;
}

Result<Invitation> deserialize_invitation(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("invitation response was not a JSON object", status);
  }
  Invitation invitation;
  if (!read_string(wire, "id", invitation.id) ||
      !read_string(wire, "groupId", invitation.group_id) ||
      !read_string(wire, "code", invitation.code) ||
      !read_string(wire, "createdAt", invitation.created_at)) {
    return wire_error("invitation is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "roleId", invitation.role_id) ||
      !read_nullable_string(wire, "targetUserId", invitation.target_user_id) ||
      !read_nullable_string(wire, "createdBy", invitation.created_by) ||
      !read_nullable_string(wire, "expiresAt", invitation.expires_at) ||
      !read_nullable_string(wire, "usedAt", invitation.used_at) ||
      !read_nullable_string(wire, "usedBy", invitation.used_by)) {
    return wire_error("invitation has a mistyped nullable field", status);
  }
  return invitation;
}

Result<BulkInviteResult> deserialize_bulk_invite_result(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("bulk invite response was not a JSON object", status);
  }
  BulkInviteResult result;
  if (!read_int64(wire, "invited", result.invited) ||
      !read_int64(wire, "skipped", result.skipped)) {
    return wire_error("bulk invite response is missing integer field invited or skipped", status);
  }
  const auto errors_it = wire.find("errors");
  if (errors_it == wire.end() || !errors_it->is_array()) {
    return wire_error("bulk invite response is missing array field errors", status);
  }
  result.errors.reserve(errors_it->size());
  for (const Json& element : *errors_it) {
    if (!element.is_object()) {
      return wire_error("bulk invite error entry was not a JSON object", status);
    }
    BulkInviteError entry;
    if (!read_int64(element, "row", entry.row)) {
      return wire_error("bulk invite error entry is missing integer field row", status);
    }
    if (!read_string(element, "reason", entry.reason)) {
      return wire_error("bulk invite error entry is missing string field reason", status);
    }
    result.errors.push_back(std::move(entry));
  }
  return result;
}

Result<GroupRelationship> deserialize_group_relationship(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("relationship response was not a JSON object", status);
  }
  GroupRelationship relationship;
  if (!read_string(wire, "groupAId", relationship.group_a_id) ||
      !read_string(wire, "groupBId", relationship.group_b_id) ||
      !read_string(wire, "type", relationship.type) ||
      !read_string(wire, "since", relationship.since)) {
    return wire_error("relationship is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "setBy", relationship.set_by)) {
    return wire_error("relationship field setBy was not a string or null", status);
  }
  return relationship;
}

Result<MemberPermissionOverride> deserialize_member_permission_override(const Json& wire,
                                                                        int status) {
  if (!wire.is_object()) {
    return wire_error("permission override response was not a JSON object", status);
  }
  MemberPermissionOverride override;
  if (!read_string(wire, "groupId", override.group_id) ||
      !read_string(wire, "userId", override.user_id) ||
      !read_string(wire, "permission", override.permission) ||
      !read_string(wire, "setAt", override.set_at)) {
    return wire_error("permission override is missing a required string field", status);
  }
  if (!read_bool(wire, "grant", override.grant)) {
    return wire_error("permission override is missing boolean field grant", status);
  }
  if (!read_nullable_string(wire, "setBy", override.set_by)) {
    return wire_error("permission override field setBy was not a string or null", status);
  }
  return override;
}

Result<BanHistoryEntry> deserialize_ban_history_entry(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("ban history entry was not a JSON object", status);
  }
  BanHistoryEntry entry;
  if (!read_string(wire, "id", entry.id) || !read_string(wire, "gameId", entry.game_id) ||
      !read_string(wire, "userId", entry.user_id) || !read_string(wire, "scope", entry.scope) ||
      !read_string(wire, "kind", entry.kind) || !read_string(wire, "eventAt", entry.event_at)) {
    return wire_error("ban history entry is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "groupId", entry.group_id) ||
      !read_nullable_string(wire, "reason", entry.reason) ||
      !read_nullable_string(wire, "expiresAt", entry.expires_at) ||
      !read_nullable_string(wire, "actorUserId", entry.actor_user_id)) {
    return wire_error("ban history entry has a mistyped nullable field", status);
  }
  return entry;
}

Result<PermissionCheckResult> deserialize_permission_check_result(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("permission check response was not a JSON object", status);
  }
  PermissionCheckResult result;
  if (!read_bool(wire, "allowed", result.allowed)) {
    return wire_error("permission check is missing boolean field allowed", status);
  }
  std::string source;
  if (!read_string(wire, "source", source)) {
    return wire_error("permission check is missing string field source", status);
  }
  // Closed server contract: exactly these four values. An unknown one
  // is a wire failure, never a silent default.
  if (source == "role") {
    result.source = PermissionSource::Role;
  } else if (source == "override") {
    result.source = PermissionSource::Override;
  } else if (source == "default") {
    result.source = PermissionSource::Default;
  } else if (source == "none") {
    result.source = PermissionSource::None;
  } else {
    return wire_error("permission check field source had unknown value: " + source, status);
  }
  if (!read_nullable_string(wire, "viaRoleId", result.via_role_id)) {
    return wire_error("permission check field viaRoleId was not a string", status);
  }
  return result;
}

Result<Ban> deserialize_ban(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("ban response was not a JSON object", status);
  }
  Ban ban;
  if (!read_string(wire, "id", ban.id) || !read_string(wire, "gameId", ban.game_id) ||
      !read_string(wire, "userId", ban.user_id) ||
      !read_string(wire, "bannedAt", ban.banned_at)) {
    return wire_error("ban is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "expiresAt", ban.expires_at) ||
      !read_nullable_string(wire, "reason", ban.reason) ||
      !read_nullable_string(wire, "bannedBy", ban.banned_by)) {
    return wire_error("ban has a mistyped nullable field", status);
  }
  return ban;
}

Result<FriendRequest> deserialize_friend_request(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("friend request was not a JSON object", status);
  }
  FriendRequest request;
  if (!read_string(wire, "id", request.id) || !read_string(wire, "gameId", request.game_id) ||
      !read_string(wire, "actorJunjoUserId", request.actor_user_id) ||
      !read_string(wire, "targetJunjoUserId", request.target_user_id) ||
      !read_string(wire, "createdAt", request.created_at)) {
    return wire_error("friend request is missing a required string field", status);
  }
  return request;
}

Result<Friendship> deserialize_friendship(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("friendship was not a JSON object", status);
  }
  Friendship friendship;
  if (!read_string(wire, "id", friendship.id) ||
      !read_string(wire, "gameId", friendship.game_id) ||
      !read_string(wire, "junjoUserId", friendship.user_id) ||
      !read_string(wire, "since", friendship.since)) {
    return wire_error("friendship is missing a required string field", status);
  }
  return friendship;
}

Result<FriendRequestSendResult> deserialize_friend_request_send_result(const Json& wire,
                                                                       int status) {
  if (!wire.is_object()) {
    return wire_error("friend request send result was not a JSON object", status);
  }
  FriendRequestSendResult result;
  std::string send_status;
  if (!read_string(wire, "status", send_status)) {
    return wire_error("friend request send result is missing string field status", status);
  }
  // Closed contract: the status decides which payload field below is
  // meaningful, so an unknown value is a wire failure rather than a
  // guess that would leave both optionals dead.
  if (send_status == "pending") {
    result.status = FriendRequestStatus::Pending;
  } else if (send_status == "auto-accepted") {
    result.status = FriendRequestStatus::AutoAccepted;
  } else {
    return wire_error("friend request send result field status had unknown value: " + send_status,
                      status);
  }
  const auto request_it = wire.find("request");
  if (request_it != wire.end() && !request_it->is_null()) {
    Result<FriendRequest> request = deserialize_friend_request(*request_it, status);
    if (!request.has_value()) return std::move(request).error();
    result.request = std::move(request).value();
  }
  const auto friendship_it = wire.find("friendship");
  if (friendship_it != wire.end() && !friendship_it->is_null()) {
    Result<Friendship> friendship = deserialize_friendship(*friendship_it, status);
    if (!friendship.has_value()) return std::move(friendship).error();
    result.friendship = std::move(friendship).value();
  }
  return result;
}

namespace {

// Reads one of the friend-request-list direction arrays.
[[nodiscard]] Result<void> read_request_array(const Json& wire, const char* key,
                                              std::vector<FriendRequest>& out, int status) {
  const auto it = wire.find(key);
  if (it == wire.end() || !it->is_array()) {
    return wire_error(std::string("friend request list is missing array field ") + key, status);
  }
  out.reserve(it->size());
  for (const Json& element : *it) {
    Result<FriendRequest> request = deserialize_friend_request(element, status);
    if (!request.has_value()) return std::move(request).error();
    out.push_back(std::move(request).value());
  }
  return Result<void>::ok();
}

}  // namespace

Result<FriendRequestList> deserialize_friend_request_list(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("friend request list was not a JSON object", status);
  }
  FriendRequestList list;
  Result<void> inbound = read_request_array(wire, "inbound", list.inbound, status);
  if (!inbound.has_value()) return std::move(inbound).error();
  Result<void> outbound = read_request_array(wire, "outbound", list.outbound, status);
  if (!outbound.has_value()) return std::move(outbound).error();
  return list;
}

Result<Block> deserialize_block(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("block was not a JSON object", status);
  }
  Block block;
  if (!read_string(wire, "id", block.id) || !read_string(wire, "gameId", block.game_id) ||
      !read_string(wire, "junjoUserId", block.user_id) ||
      !read_string(wire, "blockedAt", block.blocked_at)) {
    return wire_error("block is missing a required string field", status);
  }
  return block;
}

Result<FriendTag> deserialize_friend_tag(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("friend tag was not a JSON object", status);
  }
  FriendTag tag;
  if (!read_string(wire, "id", tag.id) || !read_string(wire, "gameId", tag.game_id) ||
      !read_string(wire, "junjoUserId", tag.user_id) || !read_string(wire, "name", tag.name) ||
      !read_string(wire, "createdAt", tag.created_at)) {
    return wire_error("friend tag is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "color", tag.color)) {
    return wire_error("friend tag field color was not a string or null", status);
  }
  return tag;
}

Result<FriendTagAssignment> deserialize_friend_tag_assignment(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("friend tag assignment was not a JSON object", status);
  }
  FriendTagAssignment assignment;
  if (!read_string(wire, "friendJunjoUserId", assignment.friend_user_id)) {
    return wire_error("friend tag assignment is missing string field friendJunjoUserId", status);
  }
  if (!read_string_array(wire, "tagIds", assignment.tag_ids)) {
    return wire_error("friend tag assignment is missing string-array field tagIds", status);
  }
  return assignment;
}

Result<UserVisibilitySettings> deserialize_user_visibility_settings(const Json& wire,
                                                                    int status) {
  if (!wire.is_object()) {
    return wire_error("visibility settings were not a JSON object", status);
  }
  UserVisibilitySettings settings;
  std::string visibility;
  if (!read_string(wire, "gameId", settings.game_id) ||
      !read_string(wire, "junjoUserId", settings.user_id) ||
      !read_string(wire, "friendsListVisibility", visibility)) {
    return wire_error("visibility settings are missing a required string field", status);
  }
  // Open enum: a level this SDK predates maps to Unknown rather than
  // failing the call (see FriendsListVisibility).
  settings.friends_list_visibility = friends_list_visibility_from_wire(visibility);
  std::vector<std::string> allowed;
  if (!read_string_array(wire, "allowed", allowed)) {
    return wire_error("visibility settings are missing string-array field allowed", status);
  }
  settings.allowed.reserve(allowed.size());
  for (const std::string& one : allowed) {
    settings.allowed.push_back(friends_list_visibility_from_wire(one));
  }
  if (!read_nullable_string(wire, "updatedAt", settings.updated_at)) {
    return wire_error("visibility settings field updatedAt was not a string or null", status);
  }
  return settings;
}

Result<FriendSuggestion> deserialize_friend_suggestion(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("friend suggestion was not a JSON object", status);
  }
  FriendSuggestion suggestion;
  if (!read_string(wire, "junjoUserId", suggestion.user_id)) {
    return wire_error("friend suggestion is missing string field junjoUserId", status);
  }
  if (!read_int64(wire, "mutualCount", suggestion.mutual_count)) {
    return wire_error("friend suggestion is missing integer field mutualCount", status);
  }
  if (!read_string_array(wire, "sampleMutualJunjoUserIds", suggestion.sample_mutual_user_ids)) {
    return wire_error("friend suggestion is missing string-array field sampleMutualJunjoUserIds",
                      status);
  }
  return suggestion;
}

Result<FriendshipRelationship> deserialize_friendship_relationship(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("relationship probe response was not a JSON object", status);
  }
  FriendshipRelationship relationship;
  std::string state;
  if (!read_string(wire, "state", state)) {
    return wire_error("relationship probe is missing string field state", status);
  }
  // Open enum: a state this SDK predates maps to Unknown rather than
  // failing the call (see FriendshipState).
  relationship.state = friendship_state_from_wire(state);
  if (!read_nullable_string(wire, "since", relationship.since)) {
    return wire_error("relationship probe field since was not a string or null", status);
  }
  return relationship;
}

Result<AuditEntry> deserialize_audit_entry(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("audit entry was not a JSON object", status);
  }
  AuditEntry entry;
  if (!read_string(wire, "id", entry.id) || !read_string(wire, "groupId", entry.group_id) ||
      !read_string(wire, "action", entry.action) ||
      !read_string(wire, "createdAt", entry.created_at)) {
    return wire_error("audit entry is missing a required string field", status);
  }
  if (!read_nullable_string(wire, "actorUserId", entry.actor_user_id) ||
      !read_nullable_string(wire, "targetId", entry.target_id)) {
    return wire_error("audit entry has a mistyped nullable field", status);
  }
  if (!read_metadata(wire, "payload", entry.payload_json)) {
    return wire_error("audit entry field payload was not a JSON object", status);
  }
  return entry;
}

Result<WebhookEndpoint> deserialize_webhook_endpoint(const Json& wire, int status) {
  if (!wire.is_object()) {
    return wire_error("webhook endpoint was not a JSON object", status);
  }
  WebhookEndpoint endpoint;
  std::string format;
  if (!read_string(wire, "id", endpoint.id) || !read_string(wire, "gameId", endpoint.game_id) ||
      !read_string(wire, "url", endpoint.url) || !read_string(wire, "format", format) ||
      !read_string(wire, "createdAt", endpoint.created_at)) {
    return wire_error("webhook endpoint is missing a required string field", status);
  }
  // Open enum: a format this SDK predates maps to Unknown rather than
  // failing every endpoint listing (see WebhookFormat).
  endpoint.format = webhook_format_from_wire(format);
  if (!read_string_array(wire, "events", endpoint.events)) {
    return wire_error("webhook endpoint is missing string-array field events", status);
  }
  if (!read_nullable_string(wire, "disabledAt", endpoint.disabled_at)) {
    return wire_error("webhook endpoint field disabledAt was not a string or null", status);
  }
  return endpoint;
}

Result<WebhookEndpointWithSecret> deserialize_webhook_endpoint_with_secret(const Json& wire,
                                                                           int status) {
  Result<WebhookEndpoint> base = deserialize_webhook_endpoint(wire, status);
  if (!base.has_value()) return std::move(base).error();
  WebhookEndpointWithSecret endpoint;
  static_cast<WebhookEndpoint&>(endpoint) = std::move(base).value();
  if (!read_string(wire, "secret", endpoint.secret)) {
    return wire_error("webhook endpoint create response is missing string field secret", status);
  }
  return endpoint;
}

Result<Json> parse_metadata_input(const std::string& metadata_json) {
  std::optional<Json> parsed = parse_json(metadata_json);
  if (!parsed.has_value() || !parsed->is_object()) {
    return Error{.code = ErrorCode::InvalidConfig,
                 .message = "metadata_json must be the serialization of a JSON object"};
  }
  return std::move(*parsed);
}

void apply_patch(Json& body, const char* key, const Patch<std::string>& patch) {
  if (patch.is_omitted()) return;
  if (patch.is_cleared()) {
    body[key] = nullptr;
    return;
  }
  body[key] = patch.value();
}

Result<void> to_void(Result<JsonBody> response) {
  if (!response.has_value()) {
    return std::move(response).error();
  }
  return Result<void>::ok();
}

}  // namespace junjo::detail
