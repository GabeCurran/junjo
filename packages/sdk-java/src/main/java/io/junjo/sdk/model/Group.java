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
 * @param version the group's version as a decimal string: the stream position of the latest event
 *     about the group or anything in it. Single-group responses carry it (and send it as the ETag);
 *     lists, event payloads and older servers do not, and it is null there. Pass it as
 *     {@code If-Match} to make a group update or delete conditional.
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
        Instant softDeletedAt,
        String version) {
    /** A group without a version. */
    public Group(
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
            Instant softDeletedAt) {
        this(id, gameId, kind, name, visibility, metadata, defaultRoleId, parentGroupId, memberCount, hasPasscode,
                createdAt, updatedAt, softDeletedAt, null);
    }
}
