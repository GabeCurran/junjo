package io.junjo.sdk.model;

import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * A user's membership in a group.
 *
 * @param userId the user's external id, rendered by the key's namespace preference
 * @param notesPublic the public note, or null
 * @param notesPrivate the staff note, or null
 * @param bannedUntil the group ban expiry when banned, or null (permanent or not banned)
 * @param version the member version, bumped by every change to the member
 * @param displayName the person's display name as picked for the caller, or null
 */
public record Member(
        String id,
        String groupId,
        String userId,
        MemberStatus status,
        List<String> roles,
        Map<String, Object> metadata,
        String notesPublic,
        String notesPrivate,
        Instant joinedAt,
        Instant bannedUntil,
        long version,
        String displayName) {
    /** Copies the role list. */
    public Member {
        roles = List.copyOf(roles);
    }
}
