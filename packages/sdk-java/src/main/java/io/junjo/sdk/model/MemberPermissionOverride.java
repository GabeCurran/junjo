package io.junjo.sdk.model;

import java.time.Instant;

/**
 * A member's personal permission entry, which takes precedence over every role.
 *
 * @param setBy the acting user, or null
 */
public record MemberPermissionOverride(
        String groupId, String userId, String permission, boolean grant, Instant setAt, String setBy) {}
