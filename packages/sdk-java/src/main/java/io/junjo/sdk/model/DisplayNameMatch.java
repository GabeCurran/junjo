package io.junjo.sdk.model;

import java.time.Instant;

/**
 * One id found by display name.
 *
 * @param userId the matching id itself, not rendered
 */
public record DisplayNameMatch(String userId, String displayName, Instant displayNameUpdatedAt) {}
