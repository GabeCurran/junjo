package io.junjo.sdk;

import java.time.Duration;
import java.util.Objects;

/**
 * Automatic retry settings for single requests.
 *
 * <p>Only requests that are safe to repeat are retried: GETs, read-only POSTs (the batch
 * permission check), and writes that carry an {@code Idempotency-Key}. Other writes are sent once,
 * because repeating one after a lost response could apply it twice.
 *
 * <p>A retry follows a network error, a timeout, any 5xx, 408, 429, and 409
 * {@code idempotency_key_in_progress}. The wait is exponential backoff with full jitter: a uniform
 * random delay between zero and {@code min(maxDelay, baseDelay * 2^(attempt - 1))}. A response
 * carrying {@code Retry-After} waits exactly that long instead; when it asks for more than
 * {@code maxRetryAfter}, the call fails at once with the server's error rather than holding the
 * caller's future for that long.
 *
 * @param maxAttempts total attempts including the first, at least 1
 * @param baseDelay the backoff base
 * @param maxDelay the cap on one backoff wait
 * @param maxRetryAfter the longest {@code Retry-After} the SDK waits out on its own
 */
public record RetryPolicy(int maxAttempts, Duration baseDelay, Duration maxDelay, Duration maxRetryAfter) {
    /** Validates the settings. */
    public RetryPolicy {
        if (maxAttempts < 1) throw new IllegalArgumentException("maxAttempts must be at least 1");
        Objects.requireNonNull(baseDelay, "baseDelay");
        Objects.requireNonNull(maxDelay, "maxDelay");
        Objects.requireNonNull(maxRetryAfter, "maxRetryAfter");
        if (baseDelay.isNegative() || maxDelay.isNegative() || maxRetryAfter.isNegative()) {
            throw new IllegalArgumentException("delays must not be negative");
        }
    }

    /** 3 attempts, 250 ms base, 10 s cap, and up to 30 s of {@code Retry-After}. */
    public static RetryPolicy defaults() {
        return new RetryPolicy(3, Duration.ofMillis(250), Duration.ofSeconds(10), Duration.ofSeconds(30));
    }

    /** A policy that never retries. */
    public static RetryPolicy none() {
        return new RetryPolicy(1, Duration.ZERO, Duration.ZERO, Duration.ZERO);
    }

    public RetryPolicy withMaxAttempts(int attempts) {
        return new RetryPolicy(attempts, baseDelay, maxDelay, maxRetryAfter);
    }
}
