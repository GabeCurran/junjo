package io.junjo.sdk.model;

/**
 * The outcome of a permission check.
 *
 * @param allowed whether the permission is held
 * @param viaRoleId the deciding role when {@code source} is {@link PermissionSource#ROLE}, else null
 * @param viaGroupId on inherited checks with a decisive answer, the group that decided; else null
 * @param context the deciding entry's context, folded; {@link Context#GLOBAL} when a global entry
 *     decided or nothing did
 */
public record PermissionCheckResult(
        boolean allowed, PermissionSource source, String viaRoleId, String viaGroupId, Context context) {
    /** A null context reads as {@link Context#GLOBAL}. */
    public PermissionCheckResult {
        if (context == null) context = Context.GLOBAL;
    }

    /** A result decided by a global entry, or by nothing. */
    public PermissionCheckResult(boolean allowed, PermissionSource source, String viaRoleId, String viaGroupId) {
        this(allowed, source, viaRoleId, viaGroupId, Context.GLOBAL);
    }

    public static PermissionCheckResult of(boolean allowed, PermissionSource source) {
        return new PermissionCheckResult(allowed, source, null, null, Context.GLOBAL);
    }
}
