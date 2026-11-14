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
 * <p>{@code writeTag} is sent as {@code Junjo-Write-Tag}: 1 to {@value #WRITE_TAG_MAX_LENGTH}
 * printable ASCII characters, no spaces. Every event the write causes carries it as the tag of its
 * {@link io.junjo.sdk.events.JunjoEvent#origin() origin}. It overrides the client-level tag for
 * this call.
 *
 * @param idempotencyKey the idempotency key, or null
 * @param ifMatch the entity tag in its quoted form, or null
 * @param timeout a per-call request timeout, or null for the client default
 * @param ifNoneMatch {@code "*"}, or null
 * @param writeTag the write tag, or null to send the client-level tag
 */
public record WriteOptions(
        String idempotencyKey, String ifMatch, Duration timeout, String ifNoneMatch, String writeTag) {
    /** The {@code If-None-Match} value that makes a write create-only. */
    public static final String ANY = "*";

    /** The longest write tag the server accepts. */
    public static final int WRITE_TAG_MAX_LENGTH = 128;

    static final String WRITE_TAG_RULE =
            "writeTag must be 1 to " + WRITE_TAG_MAX_LENGTH + " printable ASCII characters with no spaces";

    /** Validates the key, the entity tags and the write tag. */
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
        if (writeTag != null && !isValidWriteTag(writeTag)) {
            throw new IllegalArgumentException(WRITE_TAG_RULE);
        }
    }

    /** Options without a write tag. */
    public WriteOptions(String idempotencyKey, String ifMatch, Duration timeout, String ifNoneMatch) {
        this(idempotencyKey, ifMatch, timeout, ifNoneMatch, null);
    }

    /** Options without {@code If-None-Match} or a write tag. */
    public WriteOptions(String idempotencyKey, String ifMatch, Duration timeout) {
        this(idempotencyKey, ifMatch, timeout, null, null);
    }

    private static final WriteOptions NONE = new WriteOptions(null, null, null, null, null);

    /** Options that add nothing. */
    public static WriteOptions none() {
        return NONE;
    }

    public static WriteOptions idempotent(String key) {
        return new WriteOptions(key, null, null, null, null);
    }

    /** Options carrying a fresh random idempotency key. */
    public static WriteOptions idempotent() {
        return idempotent(UUID.randomUUID().toString());
    }

    public WriteOptions withIdempotencyKey(String key) {
        return new WriteOptions(key, ifMatch, timeout, ifNoneMatch, writeTag);
    }

    /** Applies the write only while the target is at {@code version}, sent as {@code If-Match: "version"}. */
    public WriteOptions withIfMatch(long version) {
        return new WriteOptions(idempotencyKey, etag(version), timeout, ifNoneMatch, writeTag);
    }

    /** Applies the write only while the target carries {@code etag}, sent verbatim. */
    public WriteOptions withIfMatch(String etag) {
        return new WriteOptions(idempotencyKey, etag, timeout, ifNoneMatch, writeTag);
    }

    /**
     * Applies the write only while the target does not exist in any state, sent as
     * {@code If-None-Match: *}.
     */
    public WriteOptions withIfNoneMatchAny() {
        return new WriteOptions(idempotencyKey, ifMatch, timeout, ANY, writeTag);
    }

    public WriteOptions withTimeout(Duration requestTimeout) {
        return new WriteOptions(idempotencyKey, ifMatch, requestTimeout, ifNoneMatch, writeTag);
    }

    /**
     * Sends {@code tag} as {@code Junjo-Write-Tag} on this write instead of the client-level tag.
     *
     * @param tag the write tag, or null to send the client-level tag
     * @throws IllegalArgumentException when the tag is not 1 to {@value #WRITE_TAG_MAX_LENGTH}
     *     printable ASCII characters without spaces
     */
    public WriteOptions withWriteTag(String tag) {
        return new WriteOptions(idempotencyKey, ifMatch, timeout, ifNoneMatch, tag);
    }

    /** The strong, quoted entity tag for a version number. */
    public static String etag(long version) {
        return "\"" + version + "\"";
    }

    static boolean isValidKey(String key) {
        return isPrintableAscii(key, 255);
    }

    /** Whether the server accepts {@code tag} as a {@code Junjo-Write-Tag}. */
    static boolean isValidWriteTag(String tag) {
        return isPrintableAscii(tag, WRITE_TAG_MAX_LENGTH);
    }

    // 1 to max characters, each in 0x21-0x7E: printable ASCII without the space.
    private static boolean isPrintableAscii(String value, int max) {
        if (value.isEmpty() || value.length() > max) return false;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x21 || c > 0x7e) return false;
        }
        return true;
    }
}
