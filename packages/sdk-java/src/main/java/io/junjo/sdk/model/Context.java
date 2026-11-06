package io.junjo.sdk.model;

import java.util.Collections;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;
import java.util.regex.Pattern;

/**
 * The conditions under which a permission entry applies, and the conditions a check is made in:
 * context key to value. The empty context is global: an entry with it applies to every check, and
 * a check with it sees only global entries.
 *
 * <p>Immutable. Values are folded on construction with an ASCII-only lowercase fold ({@code A-Z}
 * to {@code a-z}, nothing else), the fold the server applies on write and on check in every
 * permission mode, so two spellings that differ only in ASCII case are the same context. Keys are
 * not folded. Equality compares the folded values; {@link #canonicalKey()} is the server's storage
 * form.
 *
 * <p>{@link #of(Map)} and its shorthands apply the server's write rules: keys match
 * {@link #KEY_PATTERN}, at most {@link #MAX_KEYS} keys, and values of 1 to
 * {@link #VALUE_MAX_LENGTH} UTF-16 code units with no control characters.
 */
public final class Context {
    /** The pattern every context key matches. */
    public static final String KEY_PATTERN = "^[a-z][a-z0-9_]{0,31}$";
    /** The most keys one entry or check carries. */
    public static final int MAX_KEYS = 2;
    /** The longest value, in UTF-16 code units. */
    public static final int VALUE_MAX_LENGTH = 64;

    /** The global context. */
    public static final Context GLOBAL = new Context(Collections.emptySortedMap());

    private static final Pattern KEY = Pattern.compile(KEY_PATTERN);

    private final Map<String, String> values;
    private final String canonicalKey;

    private Context(Map<String, String> sorted) {
        this.values = Collections.unmodifiableMap(sorted);
        this.canonicalKey = canonical(sorted);
    }

    /**
     * A context from key/value pairs; an empty map is {@link #GLOBAL}.
     *
     * @throws IllegalArgumentException when a key or value breaks the write rules, or there are
     *     more than {@link #MAX_KEYS} keys
     */
    public static Context of(Map<String, String> values) {
        Objects.requireNonNull(values, "values");
        problem(values).ifPresent(p -> {
            throw new IllegalArgumentException(p);
        });
        return folded(values);
    }

    /** A one-key context. */
    public static Context of(String key, String value) {
        return of(Map.of(Objects.requireNonNull(key, "key"), Objects.requireNonNull(value, "value")));
    }

    /** A two-key context. */
    public static Context of(String key1, String value1, String key2, String value2) {
        return of(Map.of(
                Objects.requireNonNull(key1, "key1"), Objects.requireNonNull(value1, "value1"),
                Objects.requireNonNull(key2, "key2"), Objects.requireNonNull(value2, "value2")));
    }

    /**
     * A context as the server returned it. Values are folded but the write rules are not applied,
     * so a context written under a newer server's limits still reads. Null and an empty map are
     * {@link #GLOBAL}; null keys or values are dropped.
     */
    public static Context fromWire(Map<String, String> values) {
        if (values == null || values.isEmpty()) return GLOBAL;
        TreeMap<String, String> sorted = new TreeMap<>();
        values.forEach((k, v) -> {
            if (k != null && v != null) sorted.put(k, fold(v));
        });
        return sorted.isEmpty() ? GLOBAL : new Context(sorted);
    }

    /**
     * The reason a context breaks the write rules, or empty when it is acceptable. Checks the
     * number of keys, each key against {@link #KEY_PATTERN}, and each value's length and
     * characters.
     */
    public static Optional<String> problem(Map<String, String> values) {
        if (values.size() > MAX_KEYS) return Optional.of("context may have at most " + MAX_KEYS + " keys");
        for (String key : new TreeMap<>(values).keySet()) {
            Optional<String> keyProblem = keyProblem(key);
            if (keyProblem.isPresent()) return keyProblem;
            Optional<String> valueProblem = valueProblem(values.get(key));
            if (valueProblem.isPresent()) return valueProblem;
        }
        return Optional.empty();
    }

    /** The reason a context key is refused, or empty when it matches {@link #KEY_PATTERN}. */
    public static Optional<String> keyProblem(String key) {
        if (key == null || !KEY.matcher(key).matches()) {
            return Optional.of("context key " + quote(key) + " must match " + KEY_PATTERN);
        }
        return Optional.empty();
    }

    /**
     * The reason a context value is refused, or empty when it is 1 to {@link #VALUE_MAX_LENGTH}
     * UTF-16 code units with no control characters (Unicode category Cc).
     */
    public static Optional<String> valueProblem(String value) {
        if (value == null || value.isEmpty() || value.length() > VALUE_MAX_LENGTH) {
            return Optional.of("context value " + quote(value) + " must be 1 to " + VALUE_MAX_LENGTH + " characters");
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
                return Optional.of("context value " + quote(value) + " must not contain control characters");
            }
        }
        return Optional.empty();
    }

    /** Folds ASCII letters to lowercase and leaves every other character as it is. */
    public static String fold(String value) {
        char[] chars = null;
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c >= 'A' && c <= 'Z') {
                if (chars == null) chars = value.toCharArray();
                chars[i] = (char) (c + 32);
            }
        }
        return chars == null ? value : new String(chars);
    }

    private static Context folded(Map<String, String> values) {
        if (values.isEmpty()) return GLOBAL;
        TreeMap<String, String> sorted = new TreeMap<>();
        values.forEach((k, v) -> sorted.put(k, fold(v)));
        return new Context(sorted);
    }

    /** The folded values, sorted by key. */
    public Map<String, String> values() {
        return values;
    }

    /** The folded value for a key, when the context has it. */
    public Optional<String> get(String key) {
        return Optional.ofNullable(values.get(key));
    }

    /** Whether this is the global context. */
    public boolean isGlobal() {
        return values.isEmpty();
    }

    /** The number of keys. */
    public int size() {
        return values.size();
    }

    /**
     * A copy with one key set or replaced.
     *
     * @throws IllegalArgumentException when the result breaks the write rules
     */
    public Context with(String key, String value) {
        TreeMap<String, String> next = new TreeMap<>(values);
        next.put(Objects.requireNonNull(key, "key"), Objects.requireNonNull(value, "value"));
        return of(next);
    }

    /**
     * The canonical form the server stores and compares: {@code ""} for the global context,
     * otherwise the JSON array of {@code [key, value]} pairs sorted by key, without whitespace.
     */
    public String canonicalKey() {
        return canonicalKey;
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof Context c && c.canonicalKey.equals(canonicalKey);
    }

    @Override
    public int hashCode() {
        return canonicalKey.hashCode();
    }

    /** The canonical key, or {@code {}} for the global context. */
    @Override
    public String toString() {
        return isGlobal() ? "{}" : canonicalKey;
    }

    private static String canonical(Map<String, String> sorted) {
        if (sorted.isEmpty()) return "";
        StringBuilder out = new StringBuilder("[");
        boolean first = true;
        for (Map.Entry<String, String> e : sorted.entrySet()) {
            if (!first) out.append(',');
            first = false;
            out.append('[');
            jsonString(out, e.getKey());
            out.append(',');
            jsonString(out, e.getValue());
            out.append(']');
        }
        return out.append(']').toString();
    }

    // The escaping of ECMAScript JSON.stringify: quote, backslash, C0 controls and lone surrogates
    // are escaped; every other character is written as it is.
    private static void jsonString(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) {
                        unicodeEscape(out, c);
                    } else if (Character.isHighSurrogate(c)) {
                        if (i + 1 < s.length() && Character.isLowSurrogate(s.charAt(i + 1))) {
                            out.append(c).append(s.charAt(++i));
                        } else {
                            unicodeEscape(out, c);
                        }
                    } else if (Character.isLowSurrogate(c)) {
                        unicodeEscape(out, c);
                    } else {
                        out.append(c);
                    }
                }
            }
        }
        out.append('"');
    }

    private static void unicodeEscape(StringBuilder out, char c) {
        out.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
    }

    private static String quote(String s) {
        if (s == null) return "null";
        StringBuilder out = new StringBuilder();
        jsonString(out, s);
        return out.toString();
    }
}
