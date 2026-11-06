package io.junjo.sdk.internal;

import java.util.Objects;

/**
 * One write as the server sees it: method, path and body. Built only by {@link Routes}, so a write
 * sent directly and the same write sent through the write queue cannot differ.
 *
 * <p>Internal: not part of the supported API.
 *
 * @param path the encoded path, starting with {@code /v1/}
 * @param body a plain Java body (map, list or request input), or null for none
 * @param lift whether the write lifts a ban or a sanction, so that a {@code not_active} answer
 *     means the requested state already holds
 */
public record Route(String method, String path, Object body, boolean lift) {
    public Route {
        Objects.requireNonNull(method, "method");
        Objects.requireNonNull(path, "path");
    }
}
