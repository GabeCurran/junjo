package io.junjo.sdk.internal;

import io.junjo.sdk.WriteOptions;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

/**
 * One HTTP request as the transport sends it.
 *
 * <p>Internal: not part of the supported API.
 *
 * @param path the path and query, starting with {@code /}
 * @param body the JSON body, or null for none
 * @param retryable whether repeating the request is harmless
 * @param timeout a per-call timeout, or null for the client default
 */
public record Call(
        String method, String path, String body, Map<String, String> headers, boolean retryable, Duration timeout) {
    /** Copies the headers defensively. */
    public Call {
        Objects.requireNonNull(method, "method");
        Objects.requireNonNull(path, "path");
        headers = Map.copyOf(headers == null ? Map.of() : headers);
    }

    public static Call get(String path) {
        return new Call("GET", path, null, Map.of(), true, null);
    }

    /**
     * A write. It is retryable only when the options carry an {@code Idempotency-Key}.
     *
     * @param body the JSON body, or null
     * @param opts the write options, or null
     */
    public static Call write(String method, String path, String body, WriteOptions opts) {
        Map<String, String> headers = new LinkedHashMap<>();
        boolean retryable = false;
        Duration timeout = null;
        if (opts != null) {
            if (opts.idempotencyKey() != null) {
                headers.put("Idempotency-Key", opts.idempotencyKey());
                retryable = true;
            }
            if (opts.ifMatch() != null) headers.put("If-Match", opts.ifMatch());
            timeout = opts.timeout();
        }
        return new Call(method, path, body, headers, retryable, timeout);
    }

    /** A POST that only reads, so repeating it is harmless. */
    public static Call readPost(String path, String body) {
        return new Call("POST", path, body, Map.of(), true, null);
    }

    public Call withHeaders(Map<String, String> extra) {
        if (extra == null || extra.isEmpty()) return this;
        Map<String, String> merged = new LinkedHashMap<>(headers);
        merged.putAll(extra);
        return new Call(method, path, body, merged, retryable, timeout);
    }
}
