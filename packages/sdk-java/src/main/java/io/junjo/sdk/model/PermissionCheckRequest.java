package io.junjo.sdk.model;

import java.util.Objects;

/**
 * One entry of a batch permission check.
 *
 * @param context the check's context; {@link Context#GLOBAL} (the default) sees only global entries
 */
public record PermissionCheckRequest(String userId, String groupId, String permission, Context context) {
    /** Rejects nulls in the ids and the key; a null context reads as {@link Context#GLOBAL}. */
    public PermissionCheckRequest {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(groupId, "groupId");
        Objects.requireNonNull(permission, "permission");
        if (context == null) context = Context.GLOBAL;
    }

    /** A check without a context. */
    public PermissionCheckRequest(String userId, String groupId, String permission) {
        this(userId, groupId, permission, Context.GLOBAL);
    }
}
