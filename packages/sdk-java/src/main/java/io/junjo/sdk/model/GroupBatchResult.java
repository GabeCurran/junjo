package io.junjo.sdk.model;

import java.util.Objects;
import java.util.Optional;

/**
 * What one op of a group batch answered, as of right after that op: what the op's single call
 * returns. The kind follows the op, see {@link GroupBatchOp}; an op that answers nothing reads as
 * {@link #NONE}.
 */
public sealed interface GroupBatchResult {
    /** The result of an op that answers nothing. */
    GroupBatchResult NONE = new Empty();

    /** The member, when the op answered one. */
    default Optional<Member> asMember() {
        return Optional.empty();
    }

    /** The group, when the op answered one. */
    default Optional<Group> asGroup() {
        return Optional.empty();
    }

    /** The role, when the op answered one. */
    default Optional<Role> asRole() {
        return Optional.empty();
    }

    /** The relationship, when the op answered one. */
    default Optional<GroupRelationship> asRelationship() {
        return Optional.empty();
    }

    /** A member op's result. */
    record MemberResult(Member member) implements GroupBatchResult {
        public MemberResult {
            Objects.requireNonNull(member, "member");
        }

        @Override
        public Optional<Member> asMember() {
            return Optional.of(member);
        }
    }

    /** A {@code group.update} result; it carries no version. */
    record GroupResult(Group group) implements GroupBatchResult {
        public GroupResult {
            Objects.requireNonNull(group, "group");
        }

        @Override
        public Optional<Group> asGroup() {
            return Optional.of(group);
        }
    }

    /** A role entry op's result. */
    record RoleResult(Role role) implements GroupBatchResult {
        public RoleResult {
            Objects.requireNonNull(role, "role");
        }

        @Override
        public Optional<Role> asRole() {
            return Optional.of(role);
        }
    }

    /** A {@code relationship.set} result. */
    record RelationshipResult(GroupRelationship relationship) implements GroupBatchResult {
        public RelationshipResult {
            Objects.requireNonNull(relationship, "relationship");
        }

        @Override
        public Optional<GroupRelationship> asRelationship() {
            return Optional.of(relationship);
        }
    }

    /** No result; use {@link #NONE}. */
    record Empty() implements GroupBatchResult {}
}
