package io.junjo.sdk.model;

import java.util.Objects;

/** One triple of a batch permission check. */
public record PermissionCheckRequest(String userId, String groupId, String permission) {
    /** Rejects nulls. */
    public PermissionCheckRequest {
        Objects.requireNonNull(userId, "userId");
        Objects.requireNonNull(groupId, "groupId");
        Objects.requireNonNull(permission, "permission");
    }
}
