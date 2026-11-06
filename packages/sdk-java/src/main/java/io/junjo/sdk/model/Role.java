package io.junjo.sdk.model;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A role in a group.
 *
 * @param priority higher means more authority; breaks ties between equal entries
 * @param color the display color, or null
 * @param isDefault whether new members receive it
 */
public record Role(
        String id,
        String groupId,
        String name,
        long priority,
        String color,
        boolean isDefault,
        List<String> permissions,
        List<PermissionEntry> entries,
        List<String> parents,
        Map<String, Object> metadata,
        Instant createdAt) {
    /** Copies the lists. */
    public Role {
        permissions = List.copyOf(permissions);
        entries = List.copyOf(entries);
        parents = List.copyOf(parents);
    }
}
