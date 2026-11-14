package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.BanHistoryEntry;
import io.junjo.sdk.model.CreateGroupInput;
import io.junjo.sdk.model.GroupBatchOp;
import io.junjo.sdk.model.GroupBatchResponse;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.GroupRelationship;
import io.junjo.sdk.model.Invitation;
import io.junjo.sdk.model.ListGroupsOptions;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.PageOptions;
import io.junjo.sdk.model.UpdateGroupInput;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Groups: create, read, update, delete and restore; membership by invitation, join and leave;
 * kicks and per-group bans; relationships between groups; and the sub-group hierarchy.
 *
 * <p>Kicks and group bans accept {@code If-Match} against the member version. Group update and
 * delete accept {@code If-Match} against the group version ({@link Group#version()}), quoted or
 * bare; a group changed since fails with {@code 412 precondition_failed} whose
 * {@code details.version} is the current version.
 */
public final class GroupsApi {
    private final ApiSupport api;

    GroupsApi(ApiSupport api) {
        this.api = api;
    }

    /** Reads a group without viewer scoping. Empty when it does not exist or is soft-deleted. */
    public CompletableFuture<Optional<Group>> get(String groupId) {
        return api.getOptional(Routes.group(groupId), Wire::group);
    }

    /** Same as {@link #create(CreateGroupInput, WriteOptions)} with default options. */
    public CompletableFuture<Group> create(CreateGroupInput input) {
        return create(input, WriteOptions.none());
    }

    public CompletableFuture<Group> create(CreateGroupInput input, WriteOptions opts) {
        return api.write(Routes.createGroup(input), opts, Wire::group);
    }

    /** Lists groups, newest first. {@code opts} may be null. */
    public CompletableFuture<JunjoResponse<Page<Group>>> list(ListGroupsOptions opts) {
        ListGroupsOptions o = opts == null ? ListGroupsOptions.defaults() : opts;
        String path = new Paths.Query()
                .add("limit", o.limit())
                .add("cursor", o.cursor())
                .add("kind", o.kind())
                .add("viewer", o.viewer())
                .appendTo("/v1/groups");
        return api.getPage(path, Wire::group);
    }

    /** Same as {@link #update(String, UpdateGroupInput, WriteOptions)} with default options. */
    public CompletableFuture<Group> update(String groupId, UpdateGroupInput input) {
        return update(groupId, input, WriteOptions.none());
    }

    /** Updates the fields set on {@code input}. Honours {@code If-Match} against the group version. */
    public CompletableFuture<Group> update(String groupId, UpdateGroupInput input, WriteOptions opts) {
        return api.write(Routes.updateGroup(groupId, input), opts, Wire::group);
    }

    /** Same as {@link #delete(String, boolean, String, WriteOptions)}: a soft delete with no actor. */
    public CompletableFuture<Void> delete(String groupId) {
        return delete(groupId, false, null, WriteOptions.none());
    }

    /**
     * Deletes a group. A soft delete can be undone with {@link #restore} within the server's
     * retention window and is idempotent for a group already soft-deleted; a hard delete removes
     * the group and everything in it for good. Honours {@code If-Match} against the group version.
     *
     * @param hard whether to skip the soft-delete window
     * @param actorUserId the acting user, recorded in audit and on the {@code group.deleted} event, or null
     */
    public CompletableFuture<Void> delete(String groupId, boolean hard, String actorUserId, WriteOptions opts) {
        return api.writeVoid(Routes.deleteGroup(groupId, hard, actorUserId), opts);
    }

    /** Same as {@link #restore(String, WriteOptions)} with default options. */
    public CompletableFuture<Group> restore(String groupId) {
        return restore(groupId, WriteOptions.none());
    }

    /**
     * Undoes a soft delete. Idempotent for a group that is not deleted; fails with
     * {@code restore_window_expired} once the retention window has passed.
     */
    public CompletableFuture<Group> restore(String groupId, WriteOptions opts) {
        return api.write(Routes.restoreGroup(groupId), opts, Wire::group);
    }

    // ------------------------------------------------------------------ membership

    /** Same as {@link #inviteByUserId(String, String, String, WriteOptions)} with no role and default options. */
    public CompletableFuture<Invitation> inviteByUserId(String groupId, String userId) {
        return inviteByUserId(groupId, userId, null, WriteOptions.none());
    }

    /**
     * Invites one user.
     *
     * @param roleId the role granted on accept, or null
     */
    public CompletableFuture<Invitation> inviteByUserId(
            String groupId, String userId, String roleId, WriteOptions opts) {
        return api.write(Routes.invite(groupId, userId, roleId, null), opts, Wire::invitation);
    }

    /** Same as {@link #inviteByCode(String, String, String, WriteOptions)} with no role, no expiry and default options. */
    public CompletableFuture<Invitation> inviteByCode(String groupId) {
        return inviteByCode(groupId, null, null, WriteOptions.none());
    }

    /**
     * Creates an open invitation, addressed to nobody and redeemable by its code.
     *
     * @param roleId the role granted on accept, or null
     * @param expiresIn a positive integer followed by {@code s}, {@code m}, {@code h} or {@code d},
     *     or null for no expiry
     */
    public CompletableFuture<Invitation> inviteByCode(
            String groupId, String roleId, String expiresIn, WriteOptions opts) {
        return api.write(Routes.invite(groupId, null, roleId, expiresIn), opts, Wire::invitation);
    }

    /** Same as {@link #acceptInvitation(String, String, WriteOptions)} with default options. */
    public CompletableFuture<Member> acceptInvitation(String code, String userId) {
        return acceptInvitation(code, userId, WriteOptions.none());
    }

    /** Redeems an invitation for {@code userId}, who becomes an active member. */
    public CompletableFuture<Member> acceptInvitation(String code, String userId, WriteOptions opts) {
        return api.write(Routes.acceptInvitation(code, userId), opts, Wire::member);
    }

    /** Same as {@link #declineInvitation(String, String, WriteOptions)} with no user and default options. */
    public CompletableFuture<Void> declineInvitation(String code) {
        return declineInvitation(code, null, WriteOptions.none());
    }

    /**
     * Declines an invitation.
     *
     * @param userId the declining user, or null
     */
    public CompletableFuture<Void> declineInvitation(String code, String userId, WriteOptions opts) {
        return api.writeVoid(Routes.declineInvitation(code, userId), opts);
    }

    /** Same as {@link #join(String, String, String, WriteOptions)} with no passcode and default options. */
    public CompletableFuture<Member> join(String groupId, String userId) {
        return join(groupId, userId, null, WriteOptions.none());
    }

    /**
     * Open join. Only a {@code public} group admits it: an invite-only group fails with
     * {@code 403} and a secret one with {@code 404}. A group with a passcode fails with
     * {@code passcode_required} or {@code passcode_invalid} unless the right one is given.
     *
     * @param passcode the group's passcode, or null
     */
    public CompletableFuture<Member> join(String groupId, String userId, String passcode, WriteOptions opts) {
        return api.write(Routes.join(groupId, userId, passcode), opts, Wire::member);
    }

    /** Same as {@link #leave(String, String, WriteOptions)} with default options. */
    public CompletableFuture<Member> leave(String groupId, String userId) {
        return leave(groupId, userId, WriteOptions.none());
    }

    public CompletableFuture<Member> leave(String groupId, String userId, WriteOptions opts) {
        return api.write(Routes.leave(groupId, userId), opts, Wire::member);
    }

    /** Same as {@link #kick(String, String, String, String, WriteOptions)} with no reason, no actor and default options. */
    public CompletableFuture<Member> kick(String groupId, String userId) {
        return kick(groupId, userId, null, null, WriteOptions.none());
    }

    /** Same as {@link #kick(String, String, String, String, WriteOptions)} with no actor. */
    public CompletableFuture<Member> kick(String groupId, String userId, String reason, WriteOptions opts) {
        return kick(groupId, userId, reason, null, opts);
    }

    /**
     * Kicks an active member. Idempotent for a member in any other status.
     *
     * @param reason up to 500 characters, or null
     * @param actorUserId the kicking moderator, carried as {@code kickedBy} on the
     *     {@code member.left} event, or null
     */
    public CompletableFuture<Member> kick(
            String groupId, String userId, String reason, String actorUserId, WriteOptions opts) {
        return api.write(Routes.kick(groupId, userId, reason, actorUserId), opts, Wire::member);
    }

    /** Same as {@link #ban(String, String, String, Instant, String, WriteOptions)}, permanent and unattributed. */
    public CompletableFuture<Member> ban(String groupId, String userId) {
        return ban(groupId, userId, null, null, null, WriteOptions.none());
    }

    /**
     * Bans a user from one group: they cannot rejoin by public join or invitation while it lasts.
     * For a game ban use {@link BansApi#add}.
     *
     * @param reason up to 500 characters, or null
     * @param expiresAt when the ban lapses, or null for permanent
     * @param actorUserId the acting moderator, or null
     */
    public CompletableFuture<Member> ban(
            String groupId, String userId, String reason, Instant expiresAt, String actorUserId, WriteOptions opts) {
        return api.write(Routes.groupBan(groupId, userId, reason, expiresAt, actorUserId), opts, Wire::member);
    }

    /** Same as {@link #unban(String, String, String, WriteOptions)} with no actor and default options. */
    public CompletableFuture<Member> unban(String groupId, String userId) {
        return unban(groupId, userId, null, WriteOptions.none());
    }

    /**
     * Lifts a group ban. With no active ban it fails with {@code not_found} for which
     * {@link JunjoException#isNotActive()} is true; an unknown group fails with a plain
     * {@code not_found}.
     *
     * @param actorUserId the acting moderator, or null
     */
    public CompletableFuture<Member> unban(String groupId, String userId, String actorUserId, WriteOptions opts) {
        return api.write(Routes.groupUnban(groupId, userId, actorUserId), opts, Wire::member);
    }

    /**
     * Every set and lift of a ban in this group, across all users, newest first. Game bans are not
     * included. {@code opts} may be null.
     */
    public CompletableFuture<JunjoResponse<Page<BanHistoryEntry>>> banHistory(String groupId, PageOptions opts) {
        PageOptions o = opts == null ? PageOptions.defaults() : opts;
        String path = new Paths.Query()
                .add("limit", o.limit())
                .add("cursor", o.cursor())
                .appendTo(Routes.group(groupId) + "/bans/history");
        return api.getPage(path, Wire::banHistory);
    }

    // ------------------------------------------------------------------ batches

    /** Same as {@link #batch(String, List, WriteOptions)} with default options. */
    public CompletableFuture<GroupBatchResponse> batch(String groupId, List<GroupBatchOp> ops) {
        return batch(groupId, ops, WriteOptions.none());
    }

    /**
     * Applies {@code ops} to the group in order, in one transaction: all of them or none. Honours
     * {@code If-Match} against the group version; a group changed since fails with
     * {@code 412 precondition_failed} whose {@code details.version} is the current version, and
     * nothing is written. A failing op fails the whole batch with that op's own error, and
     * {@link JunjoException#opIndex()} names it. Result {@code i} is what op {@code i}'s single
     * call answers, as of right after op {@code i}.
     *
     * @throws IllegalArgumentException when {@code ops} holds fewer than 1 or more than
     *     {@link GroupBatchOp#MAX_OPS} ops
     */
    public CompletableFuture<GroupBatchResponse> batch(String groupId, List<GroupBatchOp> ops, WriteOptions opts) {
        List<GroupBatchOp> sent = List.copyOf(ops);
        return api.write(Routes.groupBatch(groupId, sent), opts, o -> Wire.batchResponse(o, sent));
    }

    // ------------------------------------------------------------------ relationships

    /**
     * Same as {@link #setRelationship(String, String, String, boolean, String, WriteOptions)}, one-sided
     * and unattributed.
     */
    public CompletableFuture<GroupRelationship> setRelationship(String groupAId, String groupBId, String type) {
        return setRelationship(groupAId, groupBId, type, false, null, WriteOptions.none());
    }

    /**
     * Sets group A's relationship toward group B, replacing any earlier type.
     *
     * @param mutual whether to set the same type from B toward A in the same write
     * @param actorUserId the acting user, recorded as the relationship's {@code setBy}, in audit and
     *     on the event, or null
     */
    public CompletableFuture<GroupRelationship> setRelationship(
            String groupAId, String groupBId, String type, boolean mutual, String actorUserId, WriteOptions opts) {
        return api.write(
                Routes.setRelationship(groupAId, groupBId, type, mutual, actorUserId), opts, Wire::relationship);
    }

    /** Same as {@link #clearRelationship(String, String, boolean, String, WriteOptions)}, one-sided and unattributed. */
    public CompletableFuture<Void> clearRelationship(String groupAId, String groupBId) {
        return clearRelationship(groupAId, groupBId, false, null, WriteOptions.none());
    }

    /**
     * Clears group A's relationship toward group B.
     *
     * @param mutual whether to clear B's relationship toward A in the same write
     * @param actorUserId the acting user, recorded in audit and on the event, or null
     */
    public CompletableFuture<Void> clearRelationship(
            String groupAId, String groupBId, boolean mutual, String actorUserId, WriteOptions opts) {
        return api.writeVoid(Routes.clearRelationship(groupAId, groupBId, mutual, actorUserId), opts);
    }

    /** Group A's relationship toward group B. Empty when there is none or either group is missing. */
    public CompletableFuture<Optional<GroupRelationship>> getRelationship(String groupAId, String groupBId) {
        return api.getOptional(Routes.relationship(groupAId, groupBId), Wire::relationship);
    }

    /** Every relationship the group holds toward others (its A side), ordered by the other group's id. */
    public CompletableFuture<List<GroupRelationship>> listRelationships(String groupId) {
        return api.getList(Routes.group(groupId) + "/relationships", "relationships", Wire::relationship);
    }

    // ------------------------------------------------------------------ hierarchy

    /** Same as {@link #setParent(String, String, WriteOptions)} with default options. */
    public CompletableFuture<Group> setParent(String groupId, String parentGroupId) {
        return setParent(groupId, parentGroupId, WriteOptions.none());
    }

    /**
     * Sets or clears the group's parent. A parent that would make a cycle fails with
     * {@code parent_cycle}.
     *
     * @param parentGroupId the new parent, or null to make the group top-level
     */
    public CompletableFuture<Group> setParent(String groupId, String parentGroupId, WriteOptions opts) {
        return api.write(Routes.setParent(groupId, parentGroupId), opts, Wire::group);
    }

    /** The group's direct children. */
    public CompletableFuture<List<Group>> listChildren(String groupId) {
        return api.getList(Routes.group(groupId) + "/children", "children", Wire::group);
    }
}
