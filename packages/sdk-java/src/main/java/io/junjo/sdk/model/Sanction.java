package io.junjo.sdk.model;

import java.time.Instant;

/**
 * A game-wide restriction on a person, with a type your game defines. At most one is active per
 * person and type; it is active until lifted or until {@code expiresAt} passes. Expiry is lazy:
 * nothing fires when a sanction lapses, so callers judge {@link #isActiveAt(Instant)} themselves.
 *
 * @param id the sanction id; null when the value was built from an event, which carries none
 * @param userId the sanctioned person, rendered by the key's namespace preference
 * @param reason the reason, or null
 * @param issuer free-text issuer, or null
 * @param issuedBy the person who issued it, rendered, or null
 * @param expiresAt when it lapses, or null for permanent
 * @param version the person's moderation version (shared with bans)
 */
public record Sanction(
        String id,
        String userId,
        String type,
        String reason,
        String issuer,
        String issuedBy,
        Instant startedAt,
        Instant expiresAt,
        long version) {
    /**
     * @return whether the sanction is in force at {@code now}
     */
    public boolean isActiveAt(Instant now) {
        return expiresAt == null || expiresAt.isAfter(now);
    }
}
