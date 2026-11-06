package io.junjo.sdk.internal;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.StringJoiner;

/**
 * URL path and query encoding. Every caller-supplied id is encoded as one path segment, so an id
 * containing {@code /}, {@code ?}, {@code #} or {@code :} can never change the route.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Paths {
    private Paths() {}

    /**
     * Percent-encodes one path segment or query value (spaces as {@code %20}).
     */
    public static String seg(String value) {
        if (value == null) throw new IllegalArgumentException("path segment must not be null");
        return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
    }

    /** Builds a query string from name/value pairs, skipping null values. */
    public static final class Query {
        private final StringJoiner joiner = new StringJoiner("&");

        /**
         * @param value the value; null skips the parameter
         */
        public Query add(String name, Object value) {
            if (value != null) joiner.add(seg(name) + "=" + seg(String.valueOf(value)));
            return this;
        }

        /**
         * @return the path with {@code ?query} when any parameter was added
         */
        public String appendTo(String path) {
            String q = joiner.toString();
            return q.isEmpty() ? path : path + "?" + q;
        }
    }
}
