package io.junjo.sdk;

import java.time.Duration;
import java.util.UUID;

/**
 * Per-call options for writes.
 *
 * <p>{@code idempotencyKey} is sent as {@code Idempotency-Key}: the server returns the stored
 * result for a repeat with the same key (within its retention window) instead of running the
 * write again. A write carrying a key is also eligible for automatic retries. Keys are 1 to 255
 * printable ASCII characters, scoped to the API key.
 *
 * <p>{@code ifMatch} is sent as {@code If-Match}: the write applies only when the target's current
 * version equals it, and is refused with {@code 412 precondition_failed} otherwise.
 *
 * <p>{@code ifNoneMatch} is sent as {@code If-None-Match}. Its only value is {@code "*"}, which makes
 * a create-only write: it applies only when the target does not exist yet in any state, and is
 * refused with {@code 412 precondition_failed} otherwise. {@code members().add} honours it.
 *
 * @param idempotencyKey the idempotency key, or null
 * @param ifMatch the entity tag in its quoted form, or null
 * @param timeout a per-call request timeout, or null for the client default
 * @param ifNoneMatch {@code "*"}, or null
 */
public record WriteOptions(String idempotencyKey, String ifMatch, Duration timeout, String ifNoneMatch) {
    /** The {@code If-None-Match} value that makes a write create-only. */
    public static final String ANY = "*";

    /** Validates the key and the entity tags. */
    public WriteOptions {
        if (idempotencyKey != null && !isValidKey(idempotencyKey)) {
            throw new IllegalArgumentException("idempotencyKey must be 1 to 255 printable ASCII characters");
        }
        if (ifMatch != null && ifMatch.isBlank()) {
            throw new IllegalArgumentException("ifMatch must not be blank");
        }
        if (ifNoneMatch != null && !ANY.equals(ifNoneMatch)) {
            throw new IllegalArgumentException("ifNoneMatch must be \"*\" or null");
        }
    }

    /** Options without {@code If-None-Match}. */
    public WriteOptions(String idempotencyKey, String ifMatch, Duration timeout) {
        this(idempotencyKey, ifMatch, timeout, null);
    }

    private static final WriteOptions NONE = new WriteOptions(null, null, null, null);

    /** Options that add nothing. */
    public static WriteOptions none() {
        return NONE;
    }

    public static WriteOptions idempotent(String key) {
        return new WriteOptions(key, null, null, null);
    }

    /** Options carrying a fresh random idempotency key. */
    public static WriteOptions idempotent() {
        return idempotent(UUID.randomUUID().toString());
    }

    public WriteOptions withIdempotencyKey(String key) {
        return new WriteOptions(key, ifMatch, timeout, ifNoneMatch);
    }

    /** Applies the write only while the target is at {@code version}, sent as {@code If-Match: "version"}. */
    public WriteOptions withIfMatch(long version) {
        return new WriteOptions(idempotencyKey, etag(version), timeout, ifNoneMatch);
    }

    /** Applies the write only while the target carries {@code etag}, sent verbatim. */
    public WriteOptions withIfMatch(String etag) {
        return new WriteOptions(idempotencyKey, etag, timeout, ifNoneMatch);
    }

    /**
     * Applies the write only while the target does not exist in any state, sent as
     * {@code If-None-Match: *}.
     */
    public WriteOptions withIfNoneMatchAny() {
        return new WriteOptions(idempotencyKey, ifMatch, timeout, ANY);
    }

    public WriteOptions withTimeout(Duration requestTimeout) {
        return new WriteOptions(idempotencyKey, ifMatch, requestTimeout, ifNoneMatch);
    }

    /** The strong, quoted entity tag for a version number. */
    public static String etag(long version) {
        return "\"" + version + "\"";
    }

    static boolean isValidKey(String key) {
        if (key.isEmpty() || key.length() > 255) return false;
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c < 0x21 || c > 0x7e) return false;
        }
        return true;
    }
}
