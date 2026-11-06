package io.junjo.sdk.permissions;

import io.junjo.sdk.model.Context;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeMap;

/**
 * A game's inheritance between the values of its context keys, the game config's
 * {@code permissions.contexts}: for each context key, each value maps to the values whose entries
 * it inherits. A check in a value also sees the entries of every value reachable from it, ranked
 * by distance.
 *
 * <p>Immutable and thread-safe. Values are folded like context values (see {@link Context#fold})
 * and repeated parents collapse to one. {@link #of(Map)} applies the server's config rules and
 * refuses what the server refuses: an invalid key or value, more than {@link #MAX_KEYS} keys, more
 * than {@link #MAX_VALUES} values listing parents under one key, more than {@link #MAX_PARENTS}
 * parents on one value, two values equal after folding, a cycle, or a chain longer than
 * {@link #MAX_DEPTH} steps.
 */
public final class ContextInheritance {
    /** The most context keys that may declare inheritance. */
    public static final int MAX_KEYS = 32;
    /** The longest chain, in steps. */
    public static final int MAX_DEPTH = 16;
    /** The most values that may list parents under one key. */
    public static final int MAX_VALUES = 256;
    /** The most parents one value may list. */
    public static final int MAX_PARENTS = 8;

    /** No inheritance: only entries for a check's exact values apply. */
    public static final ContextInheritance NONE = new ContextInheritance(Map.of());

    private final Map<String, Map<String, List<String>>> inherit;

    private ContextInheritance(Map<String, Map<String, List<String>>> folded) {
        this.inherit = folded;
    }

    /**
     * The inheritance from context key to {@code value -> parents}, as in the game config.
     *
     * @throws IllegalArgumentException when the config breaks a rule listed on the class
     */
    public static ContextInheritance of(Map<String, ? extends Map<String, ? extends List<String>>> inherit) {
        Objects.requireNonNull(inherit, "inherit");
        Normalized n = normalize(inherit);
        if (n.problem != null) throw new IllegalArgumentException(n.problem);
        return n.value.isEmpty() ? NONE : new ContextInheritance(n.value);
    }

    /** The reason the server refuses this config, or empty when it is accepted. */
    public static Optional<String> problem(Map<String, ? extends Map<String, ? extends List<String>>> inherit) {
        return Optional.ofNullable(normalize(Objects.requireNonNull(inherit, "inherit")).problem);
    }

    public static Builder builder() {
        return new Builder();
    }

    /** The folded inheritance, context key to {@code value -> parents}. */
    public Map<String, Map<String, List<String>>> inherit() {
        return inherit;
    }

    /** Whether no key declares inheritance. */
    public boolean isEmpty() {
        return inherit.isEmpty();
    }

    /**
     * Every value reachable from {@code value} through the key's inheritance, mapped to its
     * shortest distance: {@code value} itself is 0, its parents 1, and so on. The value is folded
     * first. Breadth-first, bounded by {@link #MAX_DEPTH}.
     */
    public Map<String, Integer> chain(String key, String value) {
        String start = Context.fold(Objects.requireNonNull(value, "value"));
        Map<String, Integer> chain = new LinkedHashMap<>();
        chain.put(start, 0);
        Map<String, List<String>> values = inherit.get(key);
        if (values != null) {
            List<String> frontier = List.of(start);
            for (int distance = 1; !frontier.isEmpty() && distance <= MAX_DEPTH; distance++) {
                List<String> next = new ArrayList<>();
                for (String v : frontier) {
                    for (String parent : values.getOrDefault(v, List.of())) {
                        if (chain.containsKey(parent)) continue;
                        chain.put(parent, distance);
                        next.add(parent);
                    }
                }
                frontier = next;
            }
        }
        return Collections.unmodifiableMap(chain);
    }

    /** The chain of every key of a check's context, by key. */
    public Map<String, Map<String, Integer>> chains(Context context) {
        if (context.isGlobal()) return Map.of();
        Map<String, Map<String, Integer>> out = new HashMap<>();
        context.values().forEach((k, v) -> out.put(k, chain(k, v)));
        return Collections.unmodifiableMap(out);
    }

    @Override
    public boolean equals(Object o) {
        return o instanceof ContextInheritance c && c.inherit.equals(inherit);
    }

    @Override
    public int hashCode() {
        return inherit.hashCode();
    }

    @Override
    public String toString() {
        return "ContextInheritance" + inherit;
    }

    private record Normalized(Map<String, Map<String, List<String>>> value, String problem) {}

    private static Normalized fail(String problem) {
        return new Normalized(null, problem);
    }

    private static Normalized normalize(Map<String, ? extends Map<String, ? extends List<String>>> raw) {
        if (raw.size() > MAX_KEYS) {
            return fail("at most " + MAX_KEYS + " context keys may declare inheritance");
        }
        Map<String, Map<String, List<String>>> out = new TreeMap<>();
        for (String key : new TreeMap<>(raw).keySet()) {
            Optional<String> keyProblem = Context.keyProblem(key);
            if (keyProblem.isPresent()) return fail(keyProblem.get());
            Map<String, ? extends List<String>> source = raw.get(key);
            if (source == null) return fail("context key \"" + key + "\" has no inherit map");
            if (source.size() > MAX_VALUES) {
                return fail("context key \"" + key + "\" may list at most " + MAX_VALUES + " values");
            }
            Map<String, List<String>> values = new LinkedHashMap<>();
            for (Map.Entry<String, ? extends List<String>> e : source.entrySet()) {
                Optional<String> valueProblem = Context.valueProblem(e.getKey());
                if (valueProblem.isPresent()) return fail(valueProblem.get());
                String folded = Context.fold(e.getKey());
                if (values.containsKey(folded)) {
                    return fail("context key \"" + key + "\" lists value \"" + folded + "\" twice ignoring case");
                }
                List<String> parents = e.getValue() == null ? List.of() : e.getValue();
                if (parents.size() > MAX_PARENTS) {
                    return fail("context value \"" + folded + "\" may have at most " + MAX_PARENTS + " parents");
                }
                List<String> folds = new ArrayList<>();
                for (String parent : parents) {
                    Optional<String> parentProblem = Context.valueProblem(parent);
                    if (parentProblem.isPresent()) return fail(parentProblem.get());
                    String f = Context.fold(parent);
                    if (!folds.contains(f)) folds.add(f);
                }
                values.put(folded, List.copyOf(folds));
            }
            String shape = shapeProblem(values);
            if (shape != null) return fail("context key \"" + key + "\": " + shape);
            out.put(key, Collections.unmodifiableMap(values));
        }
        return new Normalized(Collections.unmodifiableMap(out), null);
    }

    // Null when the value graph is acyclic and no chain is longer than the depth limit, else a
    // reason. Values without an entry have no parents. Iterative depth-first search, so a long
    // chain cannot overflow the stack.
    private static String shapeProblem(Map<String, List<String>> inherit) {
        Map<String, Boolean> done = new HashMap<>();
        Map<String, Integer> longest = new HashMap<>();
        for (String start : inherit.keySet()) {
            if (done.containsKey(start)) continue;
            List<String> path = new ArrayList<>();
            List<Integer> nextChild = new ArrayList<>();
            path.add(start);
            nextChild.add(0);
            while (!path.isEmpty()) {
                int top = path.size() - 1;
                String value = path.get(top);
                List<String> parents = inherit.getOrDefault(value, List.of());
                int idx = nextChild.get(top);
                if (idx < parents.size()) {
                    nextChild.set(top, idx + 1);
                    String parent = parents.get(idx);
                    if (done.containsKey(parent)) continue;
                    int at = path.indexOf(parent);
                    if (at != -1) {
                        StringBuilder cycle = new StringBuilder("inheritance has a cycle: ");
                        for (int i = at; i < path.size(); i++) cycle.append('"').append(path.get(i)).append("\" -> ");
                        return cycle.append('"').append(parent).append('"').toString();
                    }
                    path.add(parent);
                    nextChild.add(0);
                } else {
                    int best = 0;
                    for (String parent : parents) best = Math.max(best, longest.getOrDefault(parent, 0) + 1);
                    longest.put(value, best);
                    done.put(value, Boolean.TRUE);
                    if (best > MAX_DEPTH) return "inheritance is deeper than " + MAX_DEPTH + " steps";
                    path.remove(top);
                    nextChild.remove(top);
                }
            }
        }
        return null;
    }

    /** Builds a {@link ContextInheritance}. */
    public static final class Builder {
        private final Map<String, Map<String, List<String>>> inherit = new LinkedHashMap<>();

        private Builder() {}

        /** Declares that {@code value} of {@code key} inherits the entries of {@code parents}. */
        public Builder inherit(String key, String value, String... parents) {
            return inherit(key, value, List.of(parents));
        }

        /** Declares that {@code value} of {@code key} inherits the entries of {@code parents}. */
        public Builder inherit(String key, String value, List<String> parents) {
            inherit.computeIfAbsent(Objects.requireNonNull(key, "key"), k -> new LinkedHashMap<>())
                    .put(Objects.requireNonNull(value, "value"), List.copyOf(parents));
            return this;
        }

        /**
         * @throws IllegalArgumentException when the config breaks a rule listed on the class
         */
        public ContextInheritance build() {
            return of(inherit);
        }
    }
}
