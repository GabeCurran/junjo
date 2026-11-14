package io.junjo.sdk.internal;

import static io.junjo.sdk.internal.Json.instant;
import static io.junjo.sdk.internal.Json.obj;
import static io.junjo.sdk.internal.Json.optInstant;
import static io.junjo.sdk.internal.Json.optLong;
import static io.junjo.sdk.internal.Json.optObj;
import static io.junjo.sdk.internal.Json.optStr;
import static io.junjo.sdk.internal.Json.str;
import static io.junjo.sdk.internal.Json.strList;

import com.google.gson.JsonObject;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.JunjoEvent.EventMeta;
import io.junjo.sdk.events.JunjoEvent.EventOrigin;
import java.util.Optional;

/**
 * Decodes one event's JSON into its {@link JunjoEvent} record.
 *
 * <p>A type this SDK does not know decodes to null, so the caller can skip it. Malformed JSON, or
 * a known type missing a required field, throws {@link JunjoException} with code
 * {@code invalid_wire_data}.
 *
 * <p>Internal: not part of the supported API.
 */
public final class EventDecoder {
    private EventDecoder() {}

    /** Null for a type this SDK does not know. */
    public static JunjoEvent decode(String data) {
        return decode(Json.parseObject(data));
    }

    /** Null for a type this SDK does not know. */
    public static JunjoEvent decode(JsonObject o) {
        Optional<EventType> known = EventType.fromWire(str(o, "type"));
        if (known.isEmpty()) return null;
        EventMeta m = new EventMeta(str(o, "id"), str(o, "gameId"), instant(o, "occurredAt"), origin(o));
        return switch (known.get()) {
            case MEMBER_JOINED -> new JunjoEvent.MemberJoined(
                    m, str(o, "groupId"), str(o, "userId"), Wire.member(obj(o, "member")), mv(o));
            case MEMBER_LEFT -> new JunjoEvent.MemberLeft(
                    m, str(o, "groupId"), str(o, "userId"), str(o, "reason"), optStr(o, "kickedBy"), mv(o));
            case MEMBER_INVITED -> new JunjoEvent.MemberInvited(
                    m, str(o, "groupId"), Wire.invitation(obj(o, "invitation")));
            case MEMBER_UPDATED -> new JunjoEvent.MemberUpdated(
                    m, str(o, "groupId"), str(o, "userId"), strList(o, "changed"), mv(o));
            case MEMBER_BANNED -> new JunjoEvent.MemberBanned(
                    m, str(o, "groupId"), str(o, "userId"), optStr(o, "reason"), optInstant(o, "bannedUntil"), mv(o));
            case MEMBER_UNBANNED -> new JunjoEvent.MemberUnbanned(m, str(o, "groupId"), str(o, "userId"), mv(o));
            case ROLE_CREATED -> new JunjoEvent.RoleCreated(m, str(o, "groupId"), Wire.role(obj(o, "role")));
            case ROLE_CHANGED -> new JunjoEvent.RoleChanged(
                    m,
                    str(o, "groupId"),
                    str(o, "userId"),
                    strList(o, "added"),
                    strList(o, "removed"),
                    optStr(o, "actorUserId"),
                    mv(o));
            case ROLE_UPDATED -> new JunjoEvent.RoleUpdated(
                    m, str(o, "groupId"), str(o, "roleId"), strList(o, "changed"));
            case ROLE_DELETED -> new JunjoEvent.RoleDeleted(m, str(o, "groupId"), str(o, "roleId"));
            case PERMISSION_GRANTED -> new JunjoEvent.PermissionGranted(
                    m, str(o, "groupId"), str(o, "roleId"), str(o, "permission"));
            case PERMISSION_REVOKED -> new JunjoEvent.PermissionRevoked(
                    m, str(o, "groupId"), str(o, "roleId"), str(o, "permission"));
            case GROUP_UPDATED -> new JunjoEvent.GroupUpdated(
                    m, str(o, "groupId"), Wire.group(obj(o, "group")), optStr(o, "actorUserId"));
            case GROUP_DELETED -> new JunjoEvent.GroupDeleted(m, str(o, "groupId"), optStr(o, "actorUserId"));
            case GROUP_RELATIONSHIP_CHANGED -> {
                JsonObject rel = optObj(o, "relationship");
                yield new JunjoEvent.GroupRelationshipChanged(
                        m,
                        str(o, "groupId"),
                        str(o, "otherGroupId"),
                        rel == null ? null : Wire.relationship(rel),
                        optStr(o, "actorUserId"));
            }
            case FRIEND_REQUEST_SENT -> new JunjoEvent.FriendRequestSent(
                    m, str(o, "requestId"), str(o, "actorJunjoUserId"), str(o, "targetJunjoUserId"));
            case FRIEND_REQUEST_ACCEPTED -> new JunjoEvent.FriendRequestAccepted(
                    m,
                    str(o, "relationshipId"),
                    str(o, "actorJunjoUserId"),
                    str(o, "targetJunjoUserId"),
                    instant(o, "respondedAt"));
            case FRIEND_REQUEST_DECLINED -> new JunjoEvent.FriendRequestDeclined(
                    m, str(o, "requestId"), str(o, "actorJunjoUserId"), str(o, "targetJunjoUserId"));
            case FRIEND_REQUEST_CANCELLED -> new JunjoEvent.FriendRequestCancelled(
                    m, str(o, "requestId"), str(o, "actorJunjoUserId"), str(o, "targetJunjoUserId"));
            case FRIEND_REMOVED -> new JunjoEvent.FriendRemoved(
                    m, str(o, "removedByJunjoUserId"), str(o, "otherJunjoUserId"));
            case FRIEND_BLOCKED -> new JunjoEvent.FriendBlocked(m, str(o, "byJunjoUserId"), str(o, "otherJunjoUserId"));
            case FRIEND_UNBLOCKED -> new JunjoEvent.FriendUnblocked(
                    m, str(o, "byJunjoUserId"), str(o, "otherJunjoUserId"));
            case GAME_USER_BANNED -> new JunjoEvent.GameUserBanned(
                    m,
                    str(o, "junjoUserId"),
                    str(o, "userId"),
                    optStr(o, "reason"),
                    optInstant(o, "expiresAt"),
                    optLong(o, "moderationVersion", 0));
            case GAME_USER_UNBANNED -> new JunjoEvent.GameUserUnbanned(
                    m, str(o, "junjoUserId"), str(o, "userId"), optLong(o, "moderationVersion", 0));
            case GAME_USER_SANCTIONED -> new JunjoEvent.GameUserSanctioned(
                    m,
                    str(o, "userId"),
                    str(o, "sanctionType"),
                    optStr(o, "reason"),
                    optInstant(o, "expiresAt"),
                    optLong(o, "moderationVersion", 0));
            case GAME_USER_UNSANCTIONED -> new JunjoEvent.GameUserUnsanctioned(
                    m, str(o, "userId"), str(o, "sanctionType"), optLong(o, "moderationVersion", 0));
            case IDENTITY_UPDATED -> new JunjoEvent.IdentityUpdated(
                    m, str(o, "userId"), str(o, "changedUserId"), optStr(o, "displayName"), strList(o, "changed"));
            case IDENTITY_LINKED -> new JunjoEvent.IdentityLinked(
                    m, str(o, "userId"), str(o, "linkedUserId"), strList(o, "identities"));
            case IDENTITY_UNLINKED -> new JunjoEvent.IdentityUnlinked(
                    m, str(o, "userId"), str(o, "unlinkedUserId"), strList(o, "identities"));
            case PERMISSIONS_CONFIG_UPDATED -> new JunjoEvent.PermissionsConfigUpdated(
                    m, Wire.mode(o), Wire.contexts(o));
        };
    }

    // Absent or null on events from servers older than the field: no key, no tag.
    private static EventOrigin origin(JsonObject o) {
        JsonObject origin = optObj(o, "origin");
        if (origin == null) return EventOrigin.NONE;
        return new EventOrigin(optStr(origin, "apiKeyId"), optStr(origin, "tag"));
    }

    private static long mv(JsonObject o) {
        return optLong(o, "memberVersion", 0);
    }
}
