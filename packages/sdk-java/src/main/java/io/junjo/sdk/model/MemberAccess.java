package io.junjo.sdk.model;

import java.util.List;
import java.util.Map;

/**
 * One member's inputs to permission resolution (status, directly held roles and overrides),
 * plus the member's metadata.
 *
 * @param status the membership status; only {@link MemberStatus#ACTIVE} exercises permissions
 * @param version the member version
 * @param displayName the person's display name as picked for the caller, or null
 * @param metadata the member's free-form metadata; empty when none is set
 */
public record MemberAccess(
        String groupId,
        String userId,
        MemberStatus status,
        List<String> roleIds,
        List<MemberPermissionOverride> overrides,
        long version,
        String displayName,
        Map<String, Object> metadata) {
    /** Copies the lists; a null metadata reads as empty. */
    public MemberAccess {
        roleIds = List.copyOf(roleIds);
        overrides = List.copyOf(overrides);
        metadata = metadata == null ? Map.of() : metadata;
    }
}
