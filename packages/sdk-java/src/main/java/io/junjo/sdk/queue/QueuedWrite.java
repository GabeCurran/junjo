package io.junjo.sdk.queue;

import io.junjo.sdk.WriteOptions;
import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.Route;
import io.junjo.sdk.internal.Routes;
import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.SetMemberNotesInput;
import java.time.Instant;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * One write the {@link WriteQueue} can persist and replay: method, path, JSON body and an optional
 * {@code If-Match}. Immutable. The factories build the same request as the matching API call, and
 * are named after it.
 *
 * <p>{@code lift} marks a write that removes a ban or a sanction. Replaying a lift that finds
 * nothing to lift (see {@link io.junjo.sdk.JunjoException#isNotActive()}) counts as success: the
 * state the write asked for already holds.
 *
 * @param path the path and query, starting with {@code /v1/}
 * @param body the JSON body text, or null
 * @param ifMatch the entity tag to send as {@code If-Match}, or null
 * @param lift whether this write lifts a ban or a sanction
 * @param label a short description for logs and callbacks; defaults to the method and path
 */
public record QueuedWrite(String method, String path, String body, String ifMatch, boolean lift, String label) {
    private static final Set<String> METHODS = Set.of("POST", "PUT", "PATCH", "DELETE");

    /**
     * @throws IllegalArgumentException when the method is not a write method or the path does not
     *     start with {@code /v1/}
     */
    public QueuedWrite {
        Objects.requireNonNull(method, "method");
        Objects.requireNonNull(path, "path");
        if (!METHODS.contains(method)) {
            throw new IllegalArgumentException("queued writes use POST, PUT, PATCH or DELETE");
        }
        if (!path.startsWith("/v1/")) throw new IllegalArgumentException("path must start with /v1/");
        if (label == null) label = method + " " + path;
    }

    /** A copy sending {@code If-Match: "version"}. */
    public QueuedWrite ifMatch(long version) {
        return new QueuedWrite(method, path, body, WriteOptions.etag(version), lift, label);
    }

    /** A copy sending {@code If-Match} with the entity tag verbatim. */
    public QueuedWrite ifMatch(String etag) {
        return new QueuedWrite(method, path, body, Objects.requireNonNull(etag, "etag"), lift, label);
    }

    public QueuedWrite withLabel(String text) {
        return new QueuedWrite(method, path, body, ifMatch, lift, text);
    }

    /**
     * A write to any route.
     *
     * @param path the encoded path, starting with {@code /v1/}
     * @param body a plain Java body (map, list or request input), or null
     */
    public static QueuedWrite custom(String method, String path, Object body) {
        return new QueuedWrite(method, path, ApiSupport.encode(body), null, false, null);
    }

    /** As {@code members().add}. {@code roleId} and {@code actorUserId} may be null. */
    public static QueuedWrite addMember(String groupId, String userId, String roleId, String actorUserId) {
        return of(Routes.addMember(groupId, userId, roleId, actorUserId), "add member");
    }

    /** As {@code members().assignRole}. {@code actorUserId} may be null. */
    public static QueuedWrite assignRole(String groupId, String userId, String roleId, String actorUserId) {
        return of(Routes.assignRole(groupId, userId, roleId, actorUserId), "assign role");
    }

    /** As {@code members().removeRole}. {@code actorUserId} may be null. */
    public static QueuedWrite removeRole(String groupId, String userId, String roleId, String actorUserId) {
        return of(Routes.removeRole(groupId, userId, roleId, actorUserId), "remove role");
    }

    /** As {@code members().overridePermission}. */
    public static QueuedWrite overridePermission(String groupId, String userId, String permission, boolean grant) {
        return of(Routes.overridePermission(groupId, userId, permission, grant), "override permission");
    }

    /** As {@code members().clearPermissionOverride}. */
    public static QueuedWrite clearPermissionOverride(String groupId, String userId, String permission) {
        return of(Routes.clearPermissionOverride(groupId, userId, permission), "clear permission override");
    }

    /** As {@code members().setMetadata}. */
    public static QueuedWrite setMetadata(String groupId, String userId, Map<String, ?> metadata) {
        return of(Routes.setMetadata(groupId, userId, metadata), "set metadata");
    }

    /** As {@code members().setNotes}. */
    public static QueuedWrite setNotes(String groupId, String userId, SetMemberNotesInput notes) {
        return of(Routes.setNotes(groupId, userId, notes), "set notes");
    }

    /** As {@code groups().kick}. {@code reason} may be null. */
    public static QueuedWrite kick(String groupId, String userId, String reason) {
        return of(Routes.kick(groupId, userId, reason), "kick");
    }

    /** As {@code groups().ban}. {@code reason}, {@code expiresAt} and {@code actorUserId} may be null. */
    public static QueuedWrite groupBan(
            String groupId, String userId, String reason, Instant expiresAt, String actorUserId) {
        return of(Routes.groupBan(groupId, userId, reason, expiresAt, actorUserId), "group ban");
    }

    /** As {@code groups().unban}; a lift. {@code actorUserId} may be null. */
    public static QueuedWrite groupUnban(String groupId, String userId, String actorUserId) {
        return of(Routes.groupUnban(groupId, userId, actorUserId), "group unban");
    }

    /** As {@code bans().add}. */
    public static QueuedWrite addBan(CreateBanInput input) {
        return of(Routes.addBan(input), "add ban");
    }

    /** As {@code bans().remove}; a lift. {@code actorUserId} may be null. */
    public static QueuedWrite removeBan(String userId, String actorUserId) {
        return of(Routes.removeBan(userId, actorUserId), "remove ban");
    }

    /** As {@code sanctions().add}. */
    public static QueuedWrite addSanction(AddSanctionInput input) {
        return of(Routes.addSanction(input), "add sanction");
    }

    /** As {@code sanctions().remove}; a lift. {@code actorUserId} may be null. */
    public static QueuedWrite removeSanction(String userId, String type, String actorUserId) {
        return of(Routes.removeSanction(userId, type, actorUserId), "remove sanction");
    }

    private static QueuedWrite of(Route route, String label) {
        String body = ApiSupport.encode(route.body());
        return new QueuedWrite(route.method(), route.path(), body, null, route.lift(), label);
    }
}
