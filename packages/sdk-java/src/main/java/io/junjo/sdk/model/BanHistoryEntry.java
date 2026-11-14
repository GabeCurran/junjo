package io.junjo.sdk.model;

import java.time.Instant;

/**
 * One set or lift of a ban. Lazy expiry writes no entry.
 *
 * @param userId the person, rendered
 * @param scope {@code game} or {@code group}
 * @param groupId the group of a {@code group} entry, or null for a {@code game} entry
 * @param kind {@code set} for an issued ban, {@code lifted} for a lift
 * @param reason the reason at that moment, or null
 * @param expiresAt the expiry at that moment, or null
 * @param actorUserId who set or lifted it, rendered, or null
 * @param issuer the free-text issuer of a game ban, or null
 */
public record BanHistoryEntry(
        String id,
        String gameId,
        String userId,
        String scope,
        String groupId,
        String kind,
        String reason,
        Instant expiresAt,
        Instant eventAt,
        String actorUserId,
        String issuer) {}
