package io.junjo.sdk.model;

import java.time.Instant;

/**
 * A directed relationship between two groups.
 *
 * @param setBy the acting user, or null
 */
public record GroupRelationship(String groupAId, String groupBId, String type, Instant since, String setBy) {}
