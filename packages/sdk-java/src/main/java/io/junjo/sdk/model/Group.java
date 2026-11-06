package io.junjo.sdk.model;

import java.time.Instant;
import java.util.Map;

/**
 * A group.
 *
 * @param name the name, unique per game
 * @param visibility {@code public}, {@code invite-only} or {@code secret}
 * @param defaultRoleId the role new members receive, or null
 * @param parentGroupId the parent group, or null for a top-level group
 * @param hasPasscode whether joining requires a passcode
 * @param softDeletedAt when the group was soft-deleted, or null
 */
public record Group(
        String id,
        String gameId,
        String kind,
        String name,
        String visibility,
        Map<String, Object> metadata,
        String defaultRoleId,
        String parentGroupId,
        long memberCount,
        boolean hasPasscode,
        Instant createdAt,
        Instant updatedAt,
        Instant softDeletedAt) {}
