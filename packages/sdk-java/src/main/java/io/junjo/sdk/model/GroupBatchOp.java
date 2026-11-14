package io.junjo.sdk.model;

import java.time.Instant;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * One write of a group batch. Each op is the write of one single-group call, with that call's
 * path parameters as fields; it applies to the batch's group. Null optional fields are not sent.
 */
public sealed interface GroupBatchOp {
    /** The most ops one batch accepts. */
    int MAX_OPS = 50;

    /** The op's wire name. */
    String op();

    /** As {@code members().add}, without the {@code If-None-Match} header. */
    static MemberAdd memberAdd(String userId) {
        return new MemberAdd(userId, null, null, false);
    }

    /**
     * As {@code members().add}.
     *
     * @param roleId a role to assign in the same op, or null
     * @param actorUserId the acting moderator, or null
     * @param createOnly whether the op applies only when the user has no membership row in any
     *     status, the batch form of {@code If-None-Match: *}
     */
    static MemberAdd memberAdd(String userId, String roleId, String actorUserId, boolean createOnly) {
        return new MemberAdd(userId, roleId, actorUserId, createOnly);
    }

    /** As {@code groups().kick}. {@code reason} and {@code actorUserId} may be null. */
    static MemberKick memberKick(String userId, String reason, String actorUserId) {
        return new MemberKick(userId, reason, actorUserId);
    }

    /** As {@code groups().leave}. */
    static MemberLeave memberLeave(String userId) {
        return new MemberLeave(userId);
    }

    /**
     * As {@code groups().ban}. {@code reason}, {@code expiresAt} (null for permanent) and
     * {@code actorUserId} may be null.
     */
    static MemberBan memberBan(String userId, String reason, Instant expiresAt, String actorUserId) {
        return new MemberBan(userId, reason, expiresAt, actorUserId);
    }

    /** As {@code groups().unban}. {@code actorUserId} may be null. */
    static MemberUnban memberUnban(String userId, String actorUserId) {
        return new MemberUnban(userId, actorUserId);
    }

    /** As {@code members().setMetadata}: replaces the whole metadata object. */
    static MemberUpdate memberMetadata(String userId, Map<String, ?> metadata) {
        return new MemberUpdate(userId, copy(Objects.requireNonNull(metadata, "metadata")), null);
    }

    /** As {@code members().setNotes}. */
    static MemberUpdate memberNotes(String userId, SetMemberNotesInput notes) {
        return new MemberUpdate(userId, null, Objects.requireNonNull(notes, "notes"));
    }

    /** As {@code members().assignRole}. {@code actorUserId} may be null. */
    static MemberRoleAdd memberRoleAdd(String userId, String roleId, String actorUserId) {
        return new MemberRoleAdd(userId, roleId, actorUserId);
    }

    /** As {@code members().removeRole}. {@code actorUserId} may be null. */
    static MemberRoleRemove memberRoleRemove(String userId, String roleId, String actorUserId) {
        return new MemberRoleRemove(userId, roleId, actorUserId);
    }

    /** As {@code groups().update}; the input must not set a passcode. */
    static GroupUpdate groupUpdate(UpdateGroupInput input) {
        return new GroupUpdate(input);
    }

    /** As {@code roles().grantPermission} with the entry's value and context, for a role of this group. */
    static RoleEntrySet roleEntrySet(String roleId, PermissionEntry entry) {
        return new RoleEntrySet(roleId, entry);
    }

    /** As {@code roles().revokePermission}, for a role of this group. A null context is global. */
    static RoleEntryRemove roleEntryRemove(String roleId, String permission, Context context) {
        return new RoleEntryRemove(roleId, permission, context);
    }

    /** As {@code groups().setRelationship} from this group toward {@code otherGroupId}. */
    static RelationshipSet relationshipSet(String otherGroupId, String type, boolean mutual, String actorUserId) {
        return new RelationshipSet(otherGroupId, type, mutual, actorUserId);
    }

    /** As {@code groups().clearRelationship} from this group toward {@code otherGroupId}. */
    static RelationshipClear relationshipClear(String otherGroupId, boolean mutual, String actorUserId) {
        return new RelationshipClear(otherGroupId, mutual, actorUserId);
    }

    private static Map<String, Object> copy(Map<String, ?> metadata) {
        return Collections.unmodifiableMap(new LinkedHashMap<>(metadata));
    }

    /** {@code member.add}; the result is the member. */
    record MemberAdd(String userId, String roleId, String actorUserId, boolean createOnly) implements GroupBatchOp {
        public MemberAdd {
            Objects.requireNonNull(userId, "userId");
        }

        @Override
        public String op() {
            return "member.add";
        }
    }

    /** {@code member.kick}; the result is the member. */
    record MemberKick(String userId, String reason, String actorUserId) implements GroupBatchOp {
        public MemberKick {
            Objects.requireNonNull(userId, "userId");
        }

        @Override
        public String op() {
            return "member.kick";
        }
    }

    /** {@code member.leave}; the result is the member. */
    record MemberLeave(String userId) implements GroupBatchOp {
        public MemberLeave {
            Objects.requireNonNull(userId, "userId");
        }

        @Override
        public String op() {
            return "member.leave";
        }
    }

    /** {@code member.ban}; the result is the member. */
    record MemberBan(String userId, String reason, Instant expiresAt, String actorUserId) implements GroupBatchOp {
        public MemberBan {
            Objects.requireNonNull(userId, "userId");
        }

        @Override
        public String op() {
            return "member.ban";
        }
    }

    /** {@code member.unban}; the result is the member. */
    record MemberUnban(String userId, String actorUserId) implements GroupBatchOp {
        public MemberUnban {
            Objects.requireNonNull(userId, "userId");
        }

        @Override
        public String op() {
            return "member.unban";
        }
    }

    /**
     * {@code member.update}; the result is the member.
     *
     * @param metadata the new metadata object, or null to leave it
     * @param notes the notes to change, or null to leave both
     */
    record MemberUpdate(String userId, Map<String, Object> metadata, SetMemberNotesInput notes)
            implements GroupBatchOp {
        /** @throws IllegalArgumentException when neither metadata nor notes are given */
        public MemberUpdate {
            Objects.requireNonNull(userId, "userId");
            if (metadata == null && notes == null) {
                throw new IllegalArgumentException("member.update must change metadata or notes");
            }
            if (metadata != null) metadata = copy(metadata);
        }

        @Override
        public String op() {
            return "member.update";
        }
    }

    /** {@code member.role.add}; the result is the member. */
    record MemberRoleAdd(String userId, String roleId, String actorUserId) implements GroupBatchOp {
        public MemberRoleAdd {
            Objects.requireNonNull(userId, "userId");
            Objects.requireNonNull(roleId, "roleId");
        }

        @Override
        public String op() {
            return "member.role.add";
        }
    }

    /** {@code member.role.remove}; the result is the member. */
    record MemberRoleRemove(String userId, String roleId, String actorUserId) implements GroupBatchOp {
        public MemberRoleRemove {
            Objects.requireNonNull(userId, "userId");
            Objects.requireNonNull(roleId, "roleId");
        }

        @Override
        public String op() {
            return "member.role.remove";
        }
    }

    /** {@code group.update}; the result is the group, without a version. */
    record GroupUpdate(UpdateGroupInput input) implements GroupBatchOp {
        /** @throws IllegalArgumentException when the input sets a passcode, which a batch cannot set */
        public GroupUpdate {
            Objects.requireNonNull(input, "input");
            if (input.fields().containsKey("passcode")) {
                throw new IllegalArgumentException("a batch cannot set the passcode; use groups().update");
            }
        }

        @Override
        public String op() {
            return "group.update";
        }
    }

    /** {@code role.entry.set}; the result is the role. */
    record RoleEntrySet(String roleId, PermissionEntry entry) implements GroupBatchOp {
        public RoleEntrySet {
            Objects.requireNonNull(roleId, "roleId");
            Objects.requireNonNull(entry, "entry");
        }

        @Override
        public String op() {
            return "role.entry.set";
        }
    }

    /** {@code role.entry.remove}; the result is the role. */
    record RoleEntryRemove(String roleId, String permission, Context context) implements GroupBatchOp {
        /** A null context reads as {@link Context#GLOBAL}. */
        public RoleEntryRemove {
            Objects.requireNonNull(roleId, "roleId");
            Objects.requireNonNull(permission, "permission");
            if (context == null) context = Context.GLOBAL;
        }

        @Override
        public String op() {
            return "role.entry.remove";
        }
    }

    /** {@code relationship.set}; the result is this group's relationship toward the other. */
    record RelationshipSet(String otherGroupId, String type, boolean mutual, String actorUserId)
            implements GroupBatchOp {
        public RelationshipSet {
            Objects.requireNonNull(otherGroupId, "otherGroupId");
            Objects.requireNonNull(type, "type");
        }

        @Override
        public String op() {
            return "relationship.set";
        }
    }

    /** {@code relationship.clear}; the result is empty. */
    record RelationshipClear(String otherGroupId, boolean mutual, String actorUserId) implements GroupBatchOp {
        public RelationshipClear {
            Objects.requireNonNull(otherGroupId, "otherGroupId");
        }

        @Override
        public String op() {
            return "relationship.clear";
        }
    }
}
