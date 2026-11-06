package io.junjo.sdk.internal;

import java.time.Duration;
import java.util.concurrent.ThreadLocalRandom;

/**
 * Exponential backoff with full jitter. Full jitter (a uniform draw between zero and the cap)
 * spreads clients that failed at the same moment instead of having them retry in lockstep.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Backoff {
    // Keeps base * 2^n finite on long outages.
    private static final int MAX_EXPONENT = 30;

    private Backoff() {}

    /**
     * The cap for a retry: {@code min(max, base * 2^retryIndex)}.
     *
     * @param retryIndex 0 for the first retry
     * @param max the ceiling
     * @return the cap in milliseconds
     */
    public static long capMillis(int retryIndex, Duration base, Duration max) {
        int exp = Math.max(0, Math.min(retryIndex, MAX_EXPONENT));
        long baseMs = base.toMillis();
        long maxMs = max.toMillis();
        if (baseMs <= 0) return 0;
        long cap = baseMs > (Long.MAX_VALUE >> exp) ? Long.MAX_VALUE : baseMs << exp;
        return Math.min(cap, maxMs);
    }

    /**
     * A full-jitter delay: uniform in {@code [0, cap]}.
     *
     * @param retryIndex 0 for the first retry
     * @param max the ceiling
     * @return the delay in milliseconds
     */
    public static long fullJitterMillis(int retryIndex, Duration base, Duration max) {
        long cap = capMillis(retryIndex, base, max);
        return cap <= 0 ? 0 : ThreadLocalRandom.current().nextLong(cap + 1);
    }
}
