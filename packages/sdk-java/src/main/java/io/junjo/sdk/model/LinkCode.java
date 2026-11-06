package io.junjo.sdk.model;

import java.time.Instant;

/**
 * A single-use link code.
 *
 * @param code the code, two groups of four characters
 */
public record LinkCode(String code, Instant expiresAt) {}
