package io.junjo.sdk.model;

import java.time.Instant;

/**
 * One of a person's ids.
 *
 * @param namespace the text before the id's first {@code :}, or null when it has none
 * @param displayName this id's own display name, or null
 */
public record LinkedIdentity(String userId, String namespace, Instant linkedAt, String displayName) {}
