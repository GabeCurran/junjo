package io.junjo.sdk;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Paths;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.internal.Wire;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.ImportResult;
import io.junjo.sdk.model.ListMembersOptions;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberImport;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.SetMemberNotesInput;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.StringJoiner;
import java.util.concurrent.CompletableFuture;

/**
 * Group members: direct add, reads, metadata and notes, role assignment, personal overrides and
 * bulk import. Kicks and group bans live on {@link GroupsApi}.
 *
 * <p>Member-scoped writes accept {@code If-Match} against the member version (see
 * {@link WriteOptions#withIfMatch(long)}).
 */
public final class MembersApi {
    /** The most ids one {@link #getAccessMany} request accepts. */
    public static final int ACCESS_BATCH_MAX = 100;

    private final ApiSupport api;

    MembersApi(ApiSupport api) {
        this.api = api;
    }

    /** Same as {@link #add(String, String, String, String, WriteOptions)} with no role, actor or options. */
    public CompletableFuture<Member> add(String groupId, String userId) {
        return add(groupId, userId, null, null, WriteOptions.none());
    }

    /**
     * Adds a user to a group directly, ignoring the group's visibility. Bans are still enforced.
     * Idempotent for an active member.
     *
     * @param roleId a role to assign in the same write, or null
     * @param actorUserId the acting moderator, or null
     */
    public CompletableFuture<Member> add(
            String groupId, String userId, String roleId, String actorUserId, WriteOptions opts) {
        return api.write(Routes.addMember(groupId, userId, roleId, actorUserId), opts, Wire::member);
    }

    /** Empty when the user has no membership row in the group. */
    public CompletableFuture<Optional<Member>> get(String groupId, String userId) {
        return api.getOptional(Routes.member(groupId, userId), Wire::member);
    }

    /** Lists a group's members, newest first. {@code opts} may be null. */
    public CompletableFuture<JunjoResponse<Page<Member>>> list(String groupId, ListMembersOptions opts) {
        ListMembersOptions o = opts == null ? ListMembersOptions.defaults() : opts;
        String statuses = null;
        if (!o.statuses().isEmpty()) {
            StringJoiner j = new StringJoiner(",");
            for (MemberStatus s : o.statuses()) j.add(s.wire());
            statuses = j.toString();
        }
        String path = new Paths.Query()
                .add("limit", o.limit())
                .add("cursor", o.cursor())
                .add("status", statuses)
                .appendTo(Routes.group(groupId) + "/members");
        return api.getPage(path, Wire::member);
    }

    /**
     * Reads one member's status, direct roles and overrides. The response carries the stream
     * position and the member version as the ETag. Fails with {@code not_found} when the user has
     * no membership row.
     */
    public CompletableFuture<JunjoResponse<MemberAccess>> getAccess(String groupId, String userId) {
        return api.getResponse(
                Routes.member(groupId, userId) + "/access", r -> Wire.access(Json.parseObject(r.bodyString())));
    }

    /**
     * Reads the access of up to {@link #ACCESS_BATCH_MAX} users of one group in one request. The
     * result is aligned with {@code userIds}: empty where the id names no member. Any linked id
     * finds its person, and each access carries the rendered id, so match results by position,
     * not by {@code userId}. The response carries the stream position and no ETag. Fails with
     * {@code not_found} for an unknown group.
     *
     * @throws IllegalArgumentException when {@code userIds} is empty or longer than the cap
     */
    public CompletableFuture<JunjoResponse<List<Optional<MemberAccess>>>> getAccessMany(
            String groupId, List<String> userIds) {
        List<String> ids = List.copyOf(userIds);
        if (ids.isEmpty() || ids.size() > ACCESS_BATCH_MAX) {
            throw new IllegalArgumentException("getAccessMany takes 1 to " + ACCESS_BATCH_MAX + " ids");
        }
        return api.readPost(Routes.group(groupId) + "/members/access", Map.of("userIds", ids)).thenApply(r -> {
            JsonArray items = Json.arr(Json.parseObject(r.bodyString()), "items");
            if (items.size() != ids.size()) {
                throw Json.wire("access batch returned " + items.size() + " items for " + ids.size() + " ids");
            }
            List<Optional<MemberAccess>> out = new ArrayList<>(items.size());
            for (JsonElement el : items) {
                if (el.isJsonNull()) out.add(Optional.empty());
                else if (el.isJsonObject()) out.add(Optional.of(Wire.access(el.getAsJsonObject())));
                else throw Json.wire("access batch item is neither an object nor null");
            }
            return new JunjoResponse<>(List.copyOf(out), r.streamPosition(), r.etag());
        });
    }

    /** Same as {@link #setMetadata(String, String, Map, WriteOptions)} with default options. */
    public CompletableFuture<Member> setMetadata(String groupId, String userId, Map<String, ?> metadata) {
        return setMetadata(groupId, userId, metadata, WriteOptions.none());
    }

    /** Replaces the member's whole metadata object. */
    public CompletableFuture<Member> setMetadata(
            String groupId, String userId, Map<String, ?> metadata, WriteOptions opts) {
        return api.write(Routes.setMetadata(groupId, userId, metadata), opts, Wire::member);
    }

    /** Same as {@link #setNotes(String, String, SetMemberNotesInput, WriteOptions)} with default options. */
    public CompletableFuture<Member> setNotes(String groupId, String userId, SetMemberNotesInput notes) {
        return setNotes(groupId, userId, notes, WriteOptions.none());
    }

    /** Sets or clears the notes the input names; the other note is left as it is. */
    public CompletableFuture<Member> setNotes(
            String groupId, String userId, SetMemberNotesInput notes, WriteOptions opts) {
        return api.write(Routes.setNotes(groupId, userId, notes), opts, Wire::member);
    }

    /** Same as {@link #assignRole(String, String, String, String, WriteOptions)} with no actor or options. */
    public CompletableFuture<Member> assignRole(String groupId, String userId, String roleId) {
        return assignRole(groupId, userId, roleId, null, WriteOptions.none());
    }

    /**
     * Assigns a role. Idempotent.
     *
     * @param actorUserId the acting moderator, or null
     */
    public CompletableFuture<Member> assignRole(
            String groupId, String userId, String roleId, String actorUserId, WriteOptions opts) {
        return api.write(Routes.assignRole(groupId, userId, roleId, actorUserId), opts, Wire::member);
    }

    /** Same as {@link #removeRole(String, String, String, String, WriteOptions)} with no actor or options. */
    public CompletableFuture<Member> removeRole(String groupId, String userId, String roleId) {
        return removeRole(groupId, userId, roleId, null, WriteOptions.none());
    }

    /**
     * Removes a role. Idempotent.
     *
     * @param actorUserId the acting moderator, or null
     */
    public CompletableFuture<Member> removeRole(
            String groupId, String userId, String roleId, String actorUserId, WriteOptions opts) {
        return api.write(Routes.removeRole(groupId, userId, roleId, actorUserId), opts, Wire::member);
    }

    /** Same as {@link #overridePermission(String, String, String, boolean, WriteOptions)} with default options. */
    public CompletableFuture<MemberPermissionOverride> overridePermission(
            String groupId, String userId, String permission, boolean grant) {
        return overridePermission(groupId, userId, permission, grant, WriteOptions.none());
    }

    /**
     * Sets a personal override, which beats every role: {@code grant} true grants the key, false
     * denies it. The response is the override, not the member, so it carries no member version;
     * read {@link #getAccess} for the version after the write.
     */
    public CompletableFuture<MemberPermissionOverride> overridePermission(
            String groupId, String userId, String permission, boolean grant, WriteOptions opts) {
        return overridePermission(groupId, userId, permission, grant, Context.GLOBAL, opts);
    }

    /**
     * Same as {@link #overridePermission(String, String, String, boolean, Context, WriteOptions)}
     * with default options.
     */
    public CompletableFuture<MemberPermissionOverride> overridePermission(
            String groupId, String userId, String permission, boolean grant, Context context) {
        return overridePermission(groupId, userId, permission, grant, context, WriteOptions.none());
    }

    /**
     * Sets a personal override that applies only to checks in {@code context}. It is separate from
     * the key's global override and from its overrides in other contexts; {@link Context#GLOBAL}
     * sets the global one. Like every override it beats every role entry, whatever the entry's
     * context.
     */
    public CompletableFuture<MemberPermissionOverride> overridePermission(
            String groupId, String userId, String permission, boolean grant, Context context, WriteOptions opts) {
        return api.write(
                Routes.overridePermission(groupId, userId, permission, grant, context), opts, Wire::override);
    }

    /** Same as {@link #clearPermissionOverride(String, String, String, WriteOptions)} with default options. */
    public CompletableFuture<Void> clearPermissionOverride(String groupId, String userId, String permission) {
        return clearPermissionOverride(groupId, userId, permission, WriteOptions.none());
    }

    /** Clears a personal global override. Idempotent. */
    public CompletableFuture<Void> clearPermissionOverride(
            String groupId, String userId, String permission, WriteOptions opts) {
        return clearPermissionOverride(groupId, userId, permission, Context.GLOBAL, opts);
    }

    /**
     * Same as {@link #clearPermissionOverride(String, String, String, Context, WriteOptions)} with
     * default options.
     */
    public CompletableFuture<Void> clearPermissionOverride(
            String groupId, String userId, String permission, Context context) {
        return clearPermissionOverride(groupId, userId, permission, context, WriteOptions.none());
    }

    /**
     * Clears the personal override for the key in exactly {@code context}; {@link Context#GLOBAL}
     * clears the global one. Idempotent.
     */
    public CompletableFuture<Void> clearPermissionOverride(
            String groupId, String userId, String permission, Context context, WriteOptions opts) {
        return api.writeVoid(Routes.clearPermissionOverride(groupId, userId, permission, context), opts);
    }

    /** Same as {@link #importMembers(String, MemberImport, WriteOptions)} with default options. */
    public CompletableFuture<ImportResult> importMembers(String groupId, MemberImport request) {
        return importMembers(groupId, request, WriteOptions.none());
    }

    /**
     * Imports memberships in one all-or-nothing write. A refused import fails with
     * {@code bad_request} (or {@code banned}) and lists every failing row in
     * {@link JunjoException#importRowErrors()}. Re-running an identical import reports every row
     * {@code unchanged} and writes nothing.
     */
    public CompletableFuture<ImportResult> importMembers(String groupId, MemberImport request, WriteOptions opts) {
        return api.write(Routes.importMembers(groupId, request), opts, Wire::importResult);
    }
}
