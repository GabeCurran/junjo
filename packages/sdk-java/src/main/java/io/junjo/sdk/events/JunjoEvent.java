package io.junjo.sdk.events;

import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.GroupRelationship;
import io.junjo.sdk.model.Invitation;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.permissions.ContextInheritance;
import java.time.Instant;
import java.util.List;

/**
 * An event, keyed by {@link #type()}. The set is closed for this SDK version; a stream skips types
 * it does not know (while still advancing its position), so a newer server never breaks this
 * client.
 *
 * <p>Group-scoped events also implement {@link GroupScoped}; events about one member implement
 * {@link MemberScoped}. A version field reads 0 when the event carried none, which disables
 * version skipping for that event.
 *
 * <p>User ids named {@code userId} are rendered by the API key's namespace preference; fields
 * ending in {@code JunjoUserId} are internal person ids.
 */
public sealed interface JunjoEvent {
    EventType type();

    EventMeta meta();

    /** The event's own random id, stable across webhooks and streams; not the stream position. */
    default String id() {
        return meta().id();
    }

    /** Where the write behind the event came from. */
    default EventOrigin origin() {
        return meta().origin();
    }

    /**
     * Fields every event carries.
     *
     * @param id the event's random id, not the stream position
     * @param origin where the write behind the event came from; {@link EventOrigin#NONE} when the
     *     event carried none
     */
    record EventMeta(String id, String gameId, Instant occurredAt, EventOrigin origin) {
        /** Reads a null origin as {@link EventOrigin#NONE}. */
        public EventMeta {
            if (origin == null) origin = EventOrigin.NONE;
        }

        /** Fields without an origin. */
        public EventMeta(String id, String gameId, Instant occurredAt) {
            this(id, gameId, occurredAt, EventOrigin.NONE);
        }
    }

    /**
     * Where the write behind an event came from. A writer that keeps its own copy of the data can
     * drop the events it caused by matching these.
     *
     * @param apiKeyId the id of the per-game API key that made the write, or null for admin writes,
     *     changes the server makes on its own, and events from servers older than the field
     * @param tag the write's {@code Junjo-Write-Tag} as sent, or null
     */
    record EventOrigin(String apiKeyId, String tag) {
        /** No key and no tag. */
        public static final EventOrigin NONE = new EventOrigin(null, null);
    }

    /** An event routed to one group. */
    interface GroupScoped {
        String groupId();
    }

    /** An event about one member of a group, carrying the member version after the change. */
    interface MemberScoped extends GroupScoped {
        String userId();

        /** The member version after the change, or 0 when the event carried none. */
        long memberVersion();
    }

    record MemberJoined(EventMeta meta, String groupId, String userId, Member member, long memberVersion)
            implements JunjoEvent, MemberScoped {
        @Override
        public EventType type() {
            return EventType.MEMBER_JOINED;
        }
    }

    /**
     * {@code member.left}.
     *
     * @param reason {@code left} or {@code kicked}
     * @param kickedBy the kicking moderator the kick named, or null
     */
    record MemberLeft(EventMeta meta, String groupId, String userId, String reason, String kickedBy, long memberVersion)
            implements JunjoEvent, MemberScoped {
        @Override
        public EventType type() {
            return EventType.MEMBER_LEFT;
        }
    }

    record MemberInvited(EventMeta meta, String groupId, Invitation invitation) implements JunjoEvent, GroupScoped {
        @Override
        public EventType type() {
            return EventType.MEMBER_INVITED;
        }
    }

    /**
     * {@code member.updated}: a change signal naming the changed parts.
     *
     * @param changed any of {@code metadata}, {@code notes}, {@code overrides}
     */
    record MemberUpdated(EventMeta meta, String groupId, String userId, List<String> changed, long memberVersion)
            implements JunjoEvent, MemberScoped {
        @Override
        public EventType type() {
            return EventType.MEMBER_UPDATED;
        }
    }

    /**
     * {@code member.banned}: a group ban.
     *
     * @param reason the reason, or null
     * @param bannedUntil the expiry, or null for permanent
     */
    record MemberBanned(
            EventMeta meta, String groupId, String userId, String reason, Instant bannedUntil, long memberVersion)
            implements JunjoEvent, MemberScoped {
        @Override
        public EventType type() {
            return EventType.MEMBER_BANNED;
        }
    }

    record MemberUnbanned(EventMeta meta, String groupId, String userId, long memberVersion)
            implements JunjoEvent, MemberScoped {
        @Override
        public EventType type() {
            return EventType.MEMBER_UNBANNED;
        }
    }

    record RoleCreated(EventMeta meta, String groupId, Role role) implements JunjoEvent, GroupScoped {
        @Override
        public EventType type() {
            return EventType.ROLE_CREATED;
        }
    }

    /**
     * {@code role.changed}: roles assigned to or removed from a member.
     *
     * @param actorUserId the acting moderator, or null
     */
    record RoleChanged(
            EventMeta meta,
            String groupId,
            String userId,
            List<String> added,
            List<String> removed,
            String actorUserId,
            long memberVersion)
            implements JunjoEvent, MemberScoped {
        @Override
        public EventType type() {
            return EventType.ROLE_CHANGED;
        }
    }

    /**
     * {@code role.updated}: a change signal naming the changed fields.
     */
    record RoleUpdated(EventMeta meta, String groupId, String roleId, List<String> changed)
            implements JunjoEvent, GroupScoped {
        @Override
        public EventType type() {
            return EventType.ROLE_UPDATED;
        }
    }

    record RoleDeleted(EventMeta meta, String groupId, String roleId) implements JunjoEvent, GroupScoped {
        @Override
        public EventType type() {
            return EventType.ROLE_DELETED;
        }
    }

    record PermissionGranted(EventMeta meta, String groupId, String roleId, String permission)
            implements JunjoEvent, GroupScoped {
        @Override
        public EventType type() {
            return EventType.PERMISSION_GRANTED;
        }
    }

    record PermissionRevoked(EventMeta meta, String groupId, String roleId, String permission)
            implements JunjoEvent, GroupScoped {
        @Override
        public EventType type() {
            return EventType.PERMISSION_REVOKED;
        }
    }

    /**
     * {@code group.updated}.
     *
     * @param group the group after the change
     * @param actorUserId the user the write named as its actor, or null
     */
    record GroupUpdated(EventMeta meta, String groupId, Group group, String actorUserId)
            implements JunjoEvent, GroupScoped {
        /** An unattributed change. */
        public GroupUpdated(EventMeta meta, String groupId, Group group) {
            this(meta, groupId, group, null);
        }

        @Override
        public EventType type() {
            return EventType.GROUP_UPDATED;
        }
    }

    /**
     * {@code group.deleted}.
     *
     * @param actorUserId the user the write named as its actor, or null
     */
    record GroupDeleted(EventMeta meta, String groupId, String actorUserId) implements JunjoEvent, GroupScoped {
        /** An unattributed delete. */
        public GroupDeleted(EventMeta meta, String groupId) {
            this(meta, groupId, null);
        }

        @Override
        public EventType type() {
            return EventType.GROUP_DELETED;
        }
    }

    /**
     * {@code group.relationship.changed}.
     *
     * @param relationship the relationship, or null when cleared
     * @param actorUserId the user the write named as its actor, or null
     */
    record GroupRelationshipChanged(
            EventMeta meta, String groupId, String otherGroupId, GroupRelationship relationship, String actorUserId)
            implements JunjoEvent, GroupScoped {
        /** An unattributed change. */
        public GroupRelationshipChanged(
                EventMeta meta, String groupId, String otherGroupId, GroupRelationship relationship) {
            this(meta, groupId, otherGroupId, relationship, null);
        }

        @Override
        public EventType type() {
            return EventType.GROUP_RELATIONSHIP_CHANGED;
        }
    }

    record FriendRequestSent(EventMeta meta, String requestId, String actorJunjoUserId, String targetJunjoUserId)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_REQUEST_SENT;
        }
    }

    /**
     * {@code friend.request.accepted}.
     */
    record FriendRequestAccepted(
            EventMeta meta,
            String relationshipId,
            String actorJunjoUserId,
            String targetJunjoUserId,
            Instant respondedAt)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_REQUEST_ACCEPTED;
        }
    }

    /**
     * {@code friend.request.declined}.
     */
    record FriendRequestDeclined(EventMeta meta, String requestId, String actorJunjoUserId, String targetJunjoUserId)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_REQUEST_DECLINED;
        }
    }

    /**
     * {@code friend.request.cancelled}.
     */
    record FriendRequestCancelled(EventMeta meta, String requestId, String actorJunjoUserId, String targetJunjoUserId)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_REQUEST_CANCELLED;
        }
    }

    record FriendRemoved(EventMeta meta, String removedByJunjoUserId, String otherJunjoUserId) implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_REMOVED;
        }
    }

    record FriendBlocked(EventMeta meta, String byJunjoUserId, String otherJunjoUserId) implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_BLOCKED;
        }
    }

    record FriendUnblocked(EventMeta meta, String byJunjoUserId, String otherJunjoUserId) implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.FRIEND_UNBLOCKED;
        }
    }

    /**
     * {@code game.user.banned}.
     *
     * @param reason the reason, or null
     * @param expiresAt the expiry, or null for permanent
     * @param moderationVersion the person's moderation version after the change, or 0 when absent
     */
    record GameUserBanned(
            EventMeta meta, String junjoUserId, String userId, String reason, Instant expiresAt, long moderationVersion)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.GAME_USER_BANNED;
        }
    }

    /**
     * {@code game.user.unbanned}.
     *
     * @param moderationVersion the person's moderation version after the change, or 0 when absent
     */
    record GameUserUnbanned(EventMeta meta, String junjoUserId, String userId, long moderationVersion)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.GAME_USER_UNBANNED;
        }
    }

    /**
     * {@code game.user.sanctioned}: a sanction was created or replaced.
     *
     * @param reason the reason, or null
     * @param expiresAt the expiry, or null for permanent
     * @param moderationVersion the person's moderation version after the change, or 0 when absent
     */
    record GameUserSanctioned(
            EventMeta meta,
            String userId,
            String sanctionType,
            String reason,
            Instant expiresAt,
            long moderationVersion)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.GAME_USER_SANCTIONED;
        }
    }

    /**
     * {@code game.user.unsanctioned}: a sanction was lifted. Lazy expiry emits nothing.
     *
     * @param moderationVersion the person's moderation version after the change, or 0 when absent
     */
    record GameUserUnsanctioned(EventMeta meta, String userId, String sanctionType, long moderationVersion)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.GAME_USER_UNSANCTIONED;
        }
    }

    /**
     * {@code identity.updated}: a change signal for one id's own fields.
     *
     * @param changedUserId the id whose value changed, not rendered
     * @param displayName the changed id's new display name, or null when cleared
     */
    record IdentityUpdated(
            EventMeta meta, String userId, String changedUserId, String displayName, List<String> changed)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.IDENTITY_UPDATED;
        }
    }

    /**
     * {@code identity.linked}.
     *
     * @param identities every id the person holds, earliest first
     */
    record IdentityLinked(EventMeta meta, String userId, String linkedUserId, List<String> identities)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.IDENTITY_LINKED;
        }
    }

    /**
     * {@code identity.unlinked}.
     */
    record IdentityUnlinked(EventMeta meta, String userId, String unlinkedUserId, List<String> identities)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.IDENTITY_UNLINKED;
        }
    }

    /**
     * {@code permissions.config.updated}: the game's permission mode or context inheritance
     * changed. Game-scoped, so no group stream carries it.
     *
     * @param mode the permission mode after the change
     * @param contexts the context inheritance after the change
     */
    record PermissionsConfigUpdated(EventMeta meta, PermissionMode mode, ContextInheritance contexts)
            implements JunjoEvent {
        @Override
        public EventType type() {
            return EventType.PERMISSIONS_CONFIG_UPDATED;
        }
    }
}
