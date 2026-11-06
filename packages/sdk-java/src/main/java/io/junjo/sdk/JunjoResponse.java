package io.junjo.sdk;

/**
 * A read result together with the metadata a cache needs: the stream position the snapshot was
 * read at and the entity tag of the returned state.
 *
 * <p>The position comes from {@code Junjo-Stream-Position}. The server reads it before the data,
 * so the value reflects every event up to the position and possibly a few after it. Subscribing
 * to the game stream from this position therefore misses nothing, and may repeat a change the
 * value already shows.
 *
 * @param streamPosition the stream position, or null when the server sent none
 * @param etag the entity tag in its quoted form, or null when the server sent none
 * @param <T> the value type
 */
public record JunjoResponse<T>(T value, String streamPosition, String etag) {}
