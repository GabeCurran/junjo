package io.junjo.sdk.model;

import java.util.Objects;

/**
 * One entry on a role or member: {@code value} true grants the key, false denies it.
 */
public record PermissionEntry(String permission, boolean value) {
    /** Rejects a null key. */
    public PermissionEntry {
        Objects.requireNonNull(permission, "permission");
    }

    public static PermissionEntry grant(String permission) {
        return new PermissionEntry(permission, true);
    }

    public static PermissionEntry deny(String permission) {
        return new PermissionEntry(permission, false);
    }
}
