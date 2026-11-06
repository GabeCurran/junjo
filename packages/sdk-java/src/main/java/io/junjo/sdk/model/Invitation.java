package io.junjo.sdk.model;

import java.time.Instant;

/**
 * An invitation to a group.
 *
 * @param roleId the role granted on accept, or null
 * @param targetUserId the invited user, or null for an open invitation
 * @param createdBy the issuer, or null
 * @param expiresAt when it expires, or null
 * @param usedAt when it was used, or null
 * @param usedBy who used it, or null
 */
public record Invitation(
        String id,
        String groupId,
        String code,
        String roleId,
        String targetUserId,
        String createdBy,
        Instant createdAt,
        Instant expiresAt,
        Instant usedAt,
        String usedBy) {}
