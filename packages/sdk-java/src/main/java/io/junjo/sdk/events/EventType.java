package io.junjo.sdk.events;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Every game stream event type this SDK decodes. This enum is the single source of the wire
 * spellings: the decoder, each event record's {@link JunjoEvent#type()}, the stream's type filter
 * and the mirror's filter all read them from here.
 *
 * <p>A newer server may send types missing here; the stream skips them while still advancing its
 * position.
 */
public enum EventType {
    MEMBER_JOINED("member.joined"),
    MEMBER_LEFT("member.left"),
    MEMBER_INVITED("member.invited"),
    MEMBER_UPDATED("member.updated"),
    MEMBER_BANNED("member.banned"),
    MEMBER_UNBANNED("member.unbanned"),
    ROLE_CREATED("role.created"),
    ROLE_CHANGED("role.changed"),
    ROLE_UPDATED("role.updated"),
    ROLE_DELETED("role.deleted"),
    PERMISSION_GRANTED("permission.granted"),
    PERMISSION_REVOKED("permission.revoked"),
    GROUP_UPDATED("group.updated"),
    GROUP_DELETED("group.deleted"),
    GROUP_RELATIONSHIP_CHANGED("group.relationship.changed"),
    FRIEND_REQUEST_SENT("friend.request.sent"),
    FRIEND_REQUEST_ACCEPTED("friend.request.accepted"),
    FRIEND_REQUEST_DECLINED("friend.request.declined"),
    FRIEND_REQUEST_CANCELLED("friend.request.cancelled"),
    FRIEND_REMOVED("friend.removed"),
    FRIEND_BLOCKED("friend.blocked"),
    FRIEND_UNBLOCKED("friend.unblocked"),
    GAME_USER_BANNED("game.user.banned"),
    GAME_USER_UNBANNED("game.user.unbanned"),
    GAME_USER_SANCTIONED("game.user.sanctioned"),
    GAME_USER_UNSANCTIONED("game.user.unsanctioned"),
    IDENTITY_LINKED("identity.linked"),
    IDENTITY_UNLINKED("identity.unlinked"),
    IDENTITY_UPDATED("identity.updated"),
    PERMISSIONS_CONFIG_UPDATED("permissions.config.updated");

    private static final Map<String, EventType> BY_WIRE = new HashMap<>();

    static {
        for (EventType t : values()) BY_WIRE.put(t.wire, t);
    }

    private final String wire;

    EventType(String wire) {
        this.wire = wire;
    }

    /** The spelling the server uses on the wire. */
    public String wire() {
        return wire;
    }

    /** Empty for a spelling this SDK version does not know. */
    public static Optional<EventType> fromWire(String value) {
        return Optional.ofNullable(BY_WIRE.get(value));
    }
}
