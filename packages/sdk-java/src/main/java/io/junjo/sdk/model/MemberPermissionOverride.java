package io.junjo.sdk.model;

import java.time.Instant;

/**
 * A member's personal permission entry, which takes precedence over every role.
 *
 * @param setBy the acting user, or null
 * @param context the override's context, folded; {@link Context#GLOBAL} for a global override
 */
public record MemberPermissionOverride(
        String groupId, String userId, String permission, boolean grant, Instant setAt, String setBy,
        Context context) {
    /** A null context reads as {@link Context#GLOBAL}. */
    public MemberPermissionOverride {
        if (context == null) context = Context.GLOBAL;
    }

    /** A global override. */
    public MemberPermissionOverride(
            String groupId, String userId, String permission, boolean grant, Instant setAt, String setBy) {
        this(groupId, userId, permission, grant, setAt, setBy, Context.GLOBAL);
    }
}
