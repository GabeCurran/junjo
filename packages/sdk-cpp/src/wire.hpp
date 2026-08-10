// Junjo.io SDK for C++
//
// Internal wire (de)serialization shared by every API surface: field
// readers, per-type deserializers mirroring the server serializers
// (packages/server/src/routes/*.ts), and the response-classification
// templates that turn a Result<JsonBody> into domain values. Not
// installed.
#pragma once

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "junjo/error.hpp"
#include "junjo/result.hpp"
#include "junjo/types.hpp"

#include "json.hpp"
#include "request_executor.hpp"

namespace junjo::detail {

[[nodiscard]] Error wire_error(std::string message, int status);

// ---------------------------------------------------------------------
// Field readers. All are lenient about absence only where the contract
// is (nullable fields); a present-but-wrong-type field is always a
// deserialization failure so silent data loss cannot slip through.
// ---------------------------------------------------------------------

// Reads a required string field into `out`; false (leaving `out`
// untouched) when the field is missing or not a string.
[[nodiscard]] bool read_string(const Json& obj, const char* key, std::string& out);

// Reads a nullable string field: JSON null and absent both become
// nullopt (lenient on absence so server-side field retirement is not a
// client-side parse failure). Present-but-wrong-type is a wire error.
[[nodiscard]] bool read_nullable_string(const Json& obj, const char* key,
                                        std::optional<std::string>& out);

[[nodiscard]] bool read_bool(const Json& obj, const char* key, bool& out);

[[nodiscard]] bool read_int64(const Json& obj, const char* key, std::int64_t& out);

// Reads a required array-of-strings field.
[[nodiscard]] bool read_string_array(const Json& obj, const char* key,
                                     std::vector<std::string>& out);

// Reads a metadata object into raw JSON text. Absent and null are
// tolerated as "{}" (the server always sends the field today);
// present-but-not-an-object fails.
[[nodiscard]] bool read_metadata(const Json& obj, const char* key, std::string& out);

// ---------------------------------------------------------------------
// Deserializers. Unknown fields are ignored by construction (fields
// are pulled by name); missing or mistyped required fields fail as
// InvalidWireData carrying the response status.
// ---------------------------------------------------------------------

[[nodiscard]] Result<Group> deserialize_group(const Json& wire, int status);
[[nodiscard]] Result<Member> deserialize_member(const Json& wire, int status);
[[nodiscard]] Result<Role> deserialize_role(const Json& wire, int status);
[[nodiscard]] Result<Invitation> deserialize_invitation(const Json& wire, int status);
[[nodiscard]] Result<BulkInviteResult> deserialize_bulk_invite_result(const Json& wire, int status);
[[nodiscard]] Result<GroupRelationship> deserialize_group_relationship(const Json& wire,
                                                                       int status);
[[nodiscard]] Result<MemberPermissionOverride> deserialize_member_permission_override(
    const Json& wire, int status);
[[nodiscard]] Result<BanHistoryEntry> deserialize_ban_history_entry(const Json& wire, int status);
[[nodiscard]] Result<PermissionCheckResult> deserialize_permission_check_result(const Json& wire,
                                                                                int status);
[[nodiscard]] Result<Ban> deserialize_ban(const Json& wire, int status);
[[nodiscard]] Result<FriendRequest> deserialize_friend_request(const Json& wire, int status);
[[nodiscard]] Result<Friendship> deserialize_friendship(const Json& wire, int status);
[[nodiscard]] Result<FriendRequestSendResult> deserialize_friend_request_send_result(
    const Json& wire, int status);
[[nodiscard]] Result<FriendRequestList> deserialize_friend_request_list(const Json& wire,
                                                                        int status);
[[nodiscard]] Result<Block> deserialize_block(const Json& wire, int status);
[[nodiscard]] Result<FriendTag> deserialize_friend_tag(const Json& wire, int status);
[[nodiscard]] Result<FriendTagAssignment> deserialize_friend_tag_assignment(const Json& wire,
                                                                            int status);
[[nodiscard]] Result<UserVisibilitySettings> deserialize_user_visibility_settings(const Json& wire,
                                                                                  int status);
[[nodiscard]] Result<FriendSuggestion> deserialize_friend_suggestion(const Json& wire, int status);
[[nodiscard]] Result<FriendshipRelationship> deserialize_friendship_relationship(const Json& wire,
                                                                                 int status);
[[nodiscard]] Result<AuditEntry> deserialize_audit_entry(const Json& wire, int status);
[[nodiscard]] Result<WebhookEndpoint> deserialize_webhook_endpoint(const Json& wire, int status);
[[nodiscard]] Result<WebhookEndpointWithSecret> deserialize_webhook_endpoint_with_secret(
    const Json& wire, int status);

// ---------------------------------------------------------------------
// Input serialization helpers.
// ---------------------------------------------------------------------

// Parses a caller-supplied metadata_json string into a JSON object.
// Fails with InvalidConfig (client-side, no request made) when the
// text is not a valid JSON object serialization.
[[nodiscard]] Result<Json> parse_metadata_input(const std::string& metadata_json);

// Applies a tri-state Patch to a body object: omitted writes nothing,
// cleared writes JSON null, set writes the value.
void apply_patch(Json& body, const char* key, const Patch<std::string>& patch);

// ---------------------------------------------------------------------
// Response plumbing. Each template consumes the executor result and
// produces the domain-typed Result the public surface returns.
// ---------------------------------------------------------------------

template <typename T>
using WireDeserializer = Result<T> (*)(const Json&, int);

// A 2xx response whose body deserializes as one T.
template <typename T>
[[nodiscard]] Result<T> to_value(Result<JsonBody> response, WireDeserializer<T> deserialize) {
  if (!response.has_value()) {
    return std::move(response).error();
  }
  const JsonBody& body = response.value();
  if (!body.value.has_value()) {
    return wire_error("response had no body", body.status);
  }
  return deserialize(*body.value, body.status);
}

// Like to_value, but not_found maps to an empty optional rather than
// an error, mirroring the TS SDK's null-on-404 semantics.
template <typename T>
[[nodiscard]] Result<std::optional<T>> to_optional_value(Result<JsonBody> response,
                                                         WireDeserializer<T> deserialize) {
  if (!response.has_value()) {
    if (response.error().code == ErrorCode::NotFound) {
      return std::optional<T>{};
    }
    return std::move(response).error();
  }
  const JsonBody& body = response.value();
  if (!body.value.has_value()) {
    return wire_error("response had no body", body.status);
  }
  Result<T> value = deserialize(*body.value, body.status);
  if (!value.has_value()) {
    return std::move(value).error();
  }
  return std::optional<T>(std::move(value).value());
}

// A 2xx response whose body is a JSON array of T.
template <typename T>
[[nodiscard]] Result<std::vector<T>> to_array(Result<JsonBody> response,
                                              WireDeserializer<T> deserialize) {
  if (!response.has_value()) {
    return std::move(response).error();
  }
  const JsonBody& body = response.value();
  if (!body.value.has_value() || !body.value->is_array()) {
    return wire_error("response body was not a JSON array", body.status);
  }
  std::vector<T> items;
  items.reserve(body.value->size());
  for (const Json& element : *body.value) {
    Result<T> item = deserialize(element, body.status);
    if (!item.has_value()) {
      return std::move(item).error();
    }
    items.push_back(std::move(item).value());
  }
  return items;
}

// A 2xx response shaped { items: [...] } with no cursor (the friends
// routes' un-paginated collection shape: blocks, tags, suggestions).
template <typename T>
[[nodiscard]] Result<std::vector<T>> to_items_array(Result<JsonBody> response,
                                                    WireDeserializer<T> deserialize) {
  if (!response.has_value()) {
    return std::move(response).error();
  }
  const JsonBody& body = response.value();
  if (!body.value.has_value() || !body.value->is_object()) {
    return wire_error("items response was not a JSON object", body.status);
  }
  const auto items_it = body.value->find("items");
  if (items_it == body.value->end() || !items_it->is_array()) {
    return wire_error("items response is missing array field items", body.status);
  }
  std::vector<T> items;
  items.reserve(items_it->size());
  for (const Json& element : *items_it) {
    Result<T> item = deserialize(element, body.status);
    if (!item.has_value()) {
      return std::move(item).error();
    }
    items.push_back(std::move(item).value());
  }
  return items;
}

// A 2xx response shaped { items: [...], nextCursor: string | null }.
template <typename T>
[[nodiscard]] Result<Page<T>> to_page(Result<JsonBody> response,
                                      WireDeserializer<T> deserialize) {
  if (!response.has_value()) {
    return std::move(response).error();
  }
  const JsonBody& body = response.value();
  if (!body.value.has_value() || !body.value->is_object()) {
    return wire_error("page response was not a JSON object", body.status);
  }
  const Json& wire = *body.value;
  const auto items_it = wire.find("items");
  if (items_it == wire.end() || !items_it->is_array()) {
    return wire_error("page response is missing array field items", body.status);
  }
  Page<T> page;
  page.items.reserve(items_it->size());
  for (const Json& element : *items_it) {
    Result<T> item = deserialize(element, body.status);
    if (!item.has_value()) {
      return std::move(item).error();
    }
    page.items.push_back(std::move(item).value());
  }
  if (!read_nullable_string(wire, "nextCursor", page.next_cursor)) {
    return wire_error("page response field nextCursor was not a string or null", body.status);
  }
  return page;
}

// Success with the body (if any) discarded. Mirrors TS methods that
// resolve void.
[[nodiscard]] Result<void> to_void(Result<JsonBody> response);

}  // namespace junjo::detail
