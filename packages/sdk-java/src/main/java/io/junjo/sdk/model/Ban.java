package io.junjo.sdk.model;

import java.time.Instant;

/**
 * A game ban: it applies in every group of the game.
 *
 * @param userId the banned person's id, rendered by the key's namespace preference
 * @param expiresAt when it lapses, or null for permanent
 * @param reason the reason, or null
 * @param bannedBy the acting user, or null
 * @param issuer free-text issuer recorded with the ban, or null
 * @param version the person's moderation version
 */
public record Ban(
        String id,
        String gameId,
        String userId,
        Instant bannedAt,
        Instant expiresAt,
        String reason,
        String bannedBy,
        String issuer,
        long version) {
    /**
     * Expiry is lazy on the server, so a stored ban can be past its expiry.
     *
     * @return whether the ban is in force at {@code now}
     */
    public boolean isActiveAt(Instant now) {
        return expiresAt == null || expiresAt.isAfter(now);
    }
}
