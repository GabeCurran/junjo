package io.junjo.sdk.model;

/**
 * The outcome of a permission check.
 *
 * @param allowed whether the permission is held
 * @param viaRoleId the deciding role when {@code source} is {@link PermissionSource#ROLE}, else null
 * @param viaGroupId on inherited checks with a decisive answer, the group that decided; else null
 */
public record PermissionCheckResult(boolean allowed, PermissionSource source, String viaRoleId, String viaGroupId) {
    public static PermissionCheckResult of(boolean allowed, PermissionSource source) {
        return new PermissionCheckResult(allowed, source, null, null);
    }
}
