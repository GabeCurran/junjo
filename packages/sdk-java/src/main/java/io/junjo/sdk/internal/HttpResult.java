package io.junjo.sdk.internal;

import java.net.http.HttpHeaders;
import java.nio.charset.StandardCharsets;

/**
 * A completed 2xx (or error) response with its body fully read.
 *
 * <p>Internal: not part of the supported API.
 */
public record HttpResult(int status, byte[] body, HttpHeaders headers) {
    /** The body decoded as UTF-8. */
    public String bodyString() {
        return body == null ? "" : new String(body, StandardCharsets.UTF_8);
    }

    /** The {@code Junjo-Stream-Position} header, or null. */
    public String streamPosition() {
        return headers.firstValue(Transport.POSITION_HEADER).orElse(null);
    }

    /** The {@code ETag} header, or null. */
    public String etag() {
        return headers.firstValue("ETag").orElse(null);
    }
}
