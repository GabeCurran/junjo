package io.junjo.sdk.model;

import java.util.Objects;

/**
 * One entry on a role or member: {@code value} true grants the key, false denies it.
 * {@code context} limits the entry to checks made in a matching context; {@link Context#GLOBAL}
 * (the default) applies it everywhere. An entry's identity is its key and context together, so a
 * role can hold one key globally and again per context.
 */
public record PermissionEntry(String permission, boolean value, Context context) {
    /** Rejects a null key; a null context reads as {@link Context#GLOBAL}. */
    public PermissionEntry {
        Objects.requireNonNull(permission, "permission");
        if (context == null) context = Context.GLOBAL;
    }

    /** A global entry. */
    public PermissionEntry(String permission, boolean value) {
        this(permission, value, Context.GLOBAL);
    }

    public static PermissionEntry grant(String permission) {
        return new PermissionEntry(permission, true);
    }

    public static PermissionEntry deny(String permission) {
        return new PermissionEntry(permission, false);
    }

    /** A grant limited to {@code context}. */
    public static PermissionEntry grant(String permission, Context context) {
        return new PermissionEntry(permission, true, context);
    }

    /** A deny limited to {@code context}. */
    public static PermissionEntry deny(String permission, Context context) {
        return new PermissionEntry(permission, false, context);
    }
}
