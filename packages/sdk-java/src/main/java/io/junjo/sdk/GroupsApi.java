package io.junjo.sdk;

import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.CreateGroupInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.ListGroupsOptions;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.Page;
import java.time.Instant;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;

/**
 * Groups: create, read, list, and per-group kicks and bans. Kicks and group bans accept
 * {@code If-Match} against the member version.
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

    /** Same as {@link #kick(String, String, String, WriteOptions)} with no reason and default options. */
    public CompletableFuture<Member> kick(String groupId, String userId) {
        return kick(groupId, userId, null, WriteOptions.none());
    }

    /**
     * Kicks an active member. Idempotent for a member in any other status.
     *
     * @param reason up to 500 characters, or null
     */
    public CompletableFuture<Member> kick(String groupId, String userId, String reason, WriteOptions opts) {
        return api.write(Routes.kick(groupId, userId, reason), opts, Wire::member);
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
}
