package io.junjo.sdk;

import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;

/**
 * Namespaced user ids. An id's namespace is the text before its first {@code :}. A game may
 * declare that every id in a namespace is a canonical UUID (lowercase, hyphenated 8-4-4-4-12 hex);
 * the server then rejects any other spelling, so ids must be built canonically on the client.
 */
public final class Ids {
    /** The namespace syntax the server accepts. */
    public static final Pattern NAMESPACE = Pattern.compile("^[a-z0-9_-]{1,32}$");

    private static final Pattern CANONICAL_UUID =
            Pattern.compile("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");

    private Ids() {}

    /**
     * Builds {@code namespace + ":" + uuid} in canonical form; {@link UUID#toString()} is specified
     * to produce lowercase hyphenated hex.
     *
     * @throws IllegalArgumentException when the namespace is not valid
     */
    public static String namespaced(String namespace, UUID uuid) {
        Objects.requireNonNull(uuid, "uuid");
        requireNamespace(namespace);
        return namespace + ":" + uuid;
    }

    /**
     * Canonicalizes a namespaced UUID id: the namespace is kept and the UUID part is reparsed and
     * written lowercase and hyphenated. The UUID part may be in any letter case, with or without
     * hyphens.
     *
     * @throws IllegalArgumentException when the id has no valid namespace or UUID part
     */
    public static String canonicalize(String id) {
        String ns = namespaceOf(id).orElseThrow(() -> new IllegalArgumentException("id has no namespace: " + id));
        return namespaced(ns, parseUuid(id.substring(ns.length() + 1)));
    }

    /** The text before the first {@code :}, when there is one. */
    public static Optional<String> namespaceOf(String id) {
        Objects.requireNonNull(id, "id");
        int colon = id.indexOf(':');
        return colon < 0 ? Optional.empty() : Optional.of(id.substring(0, colon));
    }

    /** The UUID when {@code id} is {@code namespace:<canonical uuid>}. */
    public static Optional<UUID> uuidOf(String id, String namespace) {
        Objects.requireNonNull(id, "id");
        String prefix = namespace + ":";
        if (!id.startsWith(prefix)) return Optional.empty();
        String rest = id.substring(prefix.length());
        if (!CANONICAL_UUID.matcher(rest).matches()) return Optional.empty();
        return Optional.of(UUID.fromString(rest));
    }

    /** Whether the id is {@code namespace:<canonical uuid>} with a valid namespace. */
    public static boolean isCanonicalUuidId(String id) {
        Optional<String> ns = namespaceOf(id);
        return ns.isPresent()
                && NAMESPACE.matcher(ns.get()).matches()
                && CANONICAL_UUID.matcher(id.substring(ns.get().length() + 1)).matches();
    }

    private static void requireNamespace(String namespace) {
        Objects.requireNonNull(namespace, "namespace");
        if (!NAMESPACE.matcher(namespace).matches()) {
            throw new IllegalArgumentException("namespace must match " + NAMESPACE.pattern() + ": " + namespace);
        }
    }

    private static UUID parseUuid(String raw) {
        String s = raw.trim();
        if (s.length() == 32 && s.matches("[0-9a-fA-F]{32}")) {
            s = s.substring(0, 8) + "-" + s.substring(8, 12) + "-" + s.substring(12, 16) + "-"
                    + s.substring(16, 20) + "-" + s.substring(20);
        }
        if (!s.matches("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) {
            throw new IllegalArgumentException("not a UUID: " + raw);
        }
        return UUID.fromString(s);
    }
}
