package io.junjo.sdk;

import io.junjo.sdk.internal.Json;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalInt;
import java.util.OptionalLong;

/**
 * Raised for every failed SDK operation: a non-2xx answer carrying the server's error envelope,
 * a transport failure, or a response the SDK could not parse.
 *
 * <p>{@link #code()} is the stable branch point. Server codes pass through verbatim even when this
 * SDK version does not know them, so a switch over codes needs a default branch. The SDK adds its
 * own codes for failures that happened without a usable response: {@link #NETWORK_ERROR},
 * {@link #TIMEOUT}, {@link #CANCELLED}, {@link #INVALID_WIRE_DATA} and {@link #STREAM_OVERFLOW},
 * plus {@link #UNKNOWN} for a non-2xx answer that did not carry the envelope.
 *
 * <p>{@link #status()} is 0 when no HTTP response was received. A {@code network_error} or
 * {@code timeout} on a write leaves it unknown whether the server applied the write.
 */
public final class JunjoException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    /** The connection failed or broke before a complete response arrived. */
    public static final String NETWORK_ERROR = "network_error";
    /** The configured request timeout elapsed first. */
    public static final String TIMEOUT = "timeout";
    /** The call was cancelled, or the client closed while it was pending. */
    public static final String CANCELLED = "cancelled";
    /** A response (or stream frame) could not be parsed into the documented wire shape. */
    public static final String INVALID_WIRE_DATA = "invalid_wire_data";
    /** A streamed line exceeded the SDK's cap, so the stream is broken and reading stopped. */
    public static final String STREAM_OVERFLOW = "stream_overflow";
    /** A non-2xx response that did not carry the Junjo error envelope. */
    public static final String UNKNOWN = "unknown";

    private final String code;
    private final int status;
    private final String requestId;
    private final Long retryAfterSeconds;
    private final Map<String, Object> details;

    /**
     * @param status the HTTP status, or 0 when no response was received
     * @param requestId the server's correlation id, or null
     * @param retryAfterSeconds the parsed {@code Retry-After} header in seconds, or null
     * @param details the envelope's {@code details} object, or null
     * @param cause the underlying cause, or null
     */
    public JunjoException(
            String code,
            int status,
            String message,
            String requestId,
            Long retryAfterSeconds,
            Map<String, Object> details,
            Throwable cause) {
        super(message, cause);
        this.code = code;
        this.status = status;
        this.requestId = requestId;
        this.retryAfterSeconds = retryAfterSeconds;
        this.details = details == null ? null : Collections.unmodifiableMap(details);
    }

    /** A failure that produced no HTTP response; {@code cause} may be null. */
    public JunjoException(String code, String message, Throwable cause) {
        this(code, 0, message, null, null, null, cause);
    }

    /** A server envelope code or one of the SDK codes on this class. */
    public String code() {
        return code;
    }

    /** The HTTP status, or 0 when no response was received. */
    public int status() {
        return status;
    }

    /** The server's correlation id, matching its {@code x-request-id} header. */
    public Optional<String> requestId() {
        return Optional.ofNullable(requestId);
    }

    /** The {@code Retry-After} delay the server asked for, in seconds. */
    public OptionalLong retryAfterSeconds() {
        return retryAfterSeconds == null ? OptionalLong.empty() : OptionalLong.of(retryAfterSeconds);
    }

    /**
     * The envelope's optional {@code details} object, converted to plain Java values (maps, lists,
     * strings, {@code Long} or {@code Double} numbers, booleans and nulls). Empty when the envelope
     * carried none.
     */
    public Optional<Map<String, Object>> details() {
        return Optional.ofNullable(details);
    }

    /**
     * The per-row failures a bulk import reports under {@code details.rows}. Rows that do not have
     * the documented shape are skipped rather than failing the read. Empty when the details carry
     * none.
     */
    public List<ImportRowError> importRowErrors() {
        if (details == null || !(details.get("rows") instanceof List<?> rows)) {
            return List.of();
        }
        List<ImportRowError> out = new ArrayList<>();
        for (Object row : rows) {
            if (!(row instanceof Map<?, ?> map)) continue;
            Object index = map.get("index");
            if (!(index instanceof Number n)) continue;
            out.add(new ImportRowError(
                    n.intValue(),
                    Json.stringOrNull(map.get("userId")),
                    Json.stringOrNull(map.get("code")),
                    Json.stringOrNull(map.get("message"))));
        }
        return List.copyOf(out);
    }

    /**
     * The index of the op that failed a group batch, from {@code details.opIndex}. Empty for a
     * failure of the batch as a whole (a malformed envelope, a stale {@code If-Match}) and for every
     * other call.
     */
    public OptionalInt opIndex() {
        if (details != null && details.get("opIndex") instanceof Number n) return OptionalInt.of(n.intValue());
        return OptionalInt.empty();
    }

    /** True when the request may have reached the server without a response. */
    public boolean isTransportFailure() {
        return NETWORK_ERROR.equals(code) || TIMEOUT.equals(code);
    }

    /**
     * True for a lift's "nothing to lift" answer: {@code 404 not_found} with
     * {@code details.reason = "not_active"}. The state the lift asked for already holds, so a
     * replayed or racing lift may treat it as success. Any other {@code not_found} (an unknown
     * group, for one) is false.
     */
    public boolean isNotActive() {
        return status == 404
                && "not_found".equals(code)
                && details != null
                && "not_active".equals(details.get("reason"));
    }

    /**
     * One failing row of a bulk membership import.
     *
     * @param index the row's position in the request
     * @param userId the row's user id, or null when the server omitted it
     */
    public record ImportRowError(int index, String userId, String code, String message) {}
}
