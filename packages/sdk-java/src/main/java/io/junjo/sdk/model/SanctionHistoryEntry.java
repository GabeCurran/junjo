package io.junjo.sdk.model;

import java.time.Instant;

/**
 * One set or lift of a sanction. Lazy expiry writes no entry.
 *
 * @param userId the person, rendered
 * @param kind {@code set} for a create or replace, {@code lifted} for a lift
 * @param reason the reason at that moment, or null
 * @param expiresAt the expiry at that moment, or null
 * @param eventAt when the sanction started, was replaced, or was lifted
 * @param actorUserId who set or lifted it, rendered, or null
 * @param issuer the free-text issuer on {@code set} entries, or null
 */
public record SanctionHistoryEntry(
        String id,
        String gameId,
        String userId,
        String type,
        String kind,
        String reason,
        Instant expiresAt,
        Instant eventAt,
        String actorUserId,
        String issuer) {}
