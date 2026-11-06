package io.junjo.sdk.permissions;

import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.model.RoleGraph;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Local permission resolution, the same algorithm the server runs and held to the same shared
 * conformance vectors. Pure: no I/O, no shared mutable state, safe from any thread.
 *
 * <p>An entry applies to a check when its key is a candidate for the permission and its context
 * applies: a global entry always applies, and an entry with context {@code E} applies when, for
 * every {@code (k, v)} in {@code E}, the check's context {@code C} has {@code k} and {@code v} is
 * in the inheritance chain of {@code C[k]} (see {@link ContextInheritance#chain}). Its context
 * score is the number of keys in {@code E} and the sum of their chain distances; a global entry
 * scores zero on both.
 *
 * <p>Precedence, applied in order:
 * <ol>
 *   <li>Layer. The member's own overrides, then the roles held directly, then their parents, then
 *       grandparents. A role reachable through several paths sits at its shortest distance. The
 *       first layer with any applicable entry decides.
 *   <li>Context within that layer: more matched keys win, then the smaller distance sum.
 *   <li>Specificity among the entries with the best context score: the exact key beats the
 *       longest matching wildcard, down to the bare wildcard.
 *   <li>Deny wins between the entries that remain. Among equal entries the role reported is the
 *       one with the highest priority, then the greatest id.
 * </ol>
 *
 * <p>The result's context is the deciding entry's; when several entries of the deciding value
 * tie, the one with the smallest {@link Context#canonicalKey()} is reported. A check with the
 * global context sees only global entries.
 *
 * <p>The mode only changes key matching. Case folding in {@code nodes} mode is ASCII-only (A-Z to
 * a-z) and independent of the default locale. It deliberately does not use
 * {@link String#toLowerCase(java.util.Locale)}: even under {@code Locale.ROOT} that folds some
 * non-ASCII characters (KELVIN SIGN U+212A) to ASCII letters, which would let a check match a
 * stored key that the server, folding ASCII only, does not match. Context values are folded the
 * same way in every mode.
 */
public final class PermissionResolver {
    /** Bounds the role-parent walk; writes are cycle-checked, so this only guards corrupt data. */
    public static final int MAX_ROLE_DEPTH = 100;

    private static final String WILDCARD = "*";

    private PermissionResolver() {}

    /**
     * A role as the resolver sees it.
     *
     * @param entries the global entries, normalized key to grant (true) or deny (false)
     * @param contextEntries the entries limited to a context, keys normalized; each context is
     *     non-global
     */
    public record ResolverRole(
            long priority, Map<String, Boolean> entries, List<PermissionEntry> contextEntries, List<String> parents) {
        /** Copies the collections. */
        public ResolverRole {
            entries = Map.copyOf(entries);
            contextEntries = List.copyOf(contextEntries);
            parents = List.copyOf(parents);
        }

        /** A role with global entries only. */
        public ResolverRole(long priority, Map<String, Boolean> entries, List<String> parents) {
            this(priority, entries, List.of(), parents);
        }
    }

    /**
     * Folds ASCII letters to lowercase in {@code nodes} mode; returns the key unchanged in
     * {@code exact} mode.
     */
    public static String normalizeKey(PermissionMode mode, String key) {
        return mode == PermissionMode.NODES ? asciiLower(key) : key;
    }

    static String asciiLower(String key) {
        char[] chars = null;
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c >= 'A' && c <= 'Z') {
                if (chars == null) chars = key.toCharArray();
                chars[i] = (char) (c + 32);
            }
        }
        return chars == null ? key : new String(chars);
    }

    /**
     * Checks a key against the mode's write rules. {@code exact} mode adds none. {@code nodes}
     * mode requires printable ASCII without whitespace, no leading {@code -}, no empty segment,
     * and {@code *} only as the whole key or the whole final segment. Returns the reason a key is
     * refused, or empty when it is acceptable.
     */
    public static Optional<String> validateKey(PermissionMode mode, String key) {
        if (mode == PermissionMode.EXACT) return Optional.empty();
        if (key.isEmpty()) return Optional.of("must not be empty");
        for (int i = 0; i < key.length(); i++) {
            char c = key.charAt(i);
            if (c < 0x21 || c > 0x7e) return Optional.of("must be printable ASCII with no whitespace");
        }
        if (key.startsWith("-")) return Optional.of("must not start with '-'; set the entry's value to deny instead");
        if (key.equals(WILDCARD)) return Optional.empty();
        String[] segments = key.split("\\.", -1);
        for (int i = 0; i < segments.length; i++) {
            String segment = segments[i];
            if (segment.isEmpty()) return Optional.of("must not contain an empty segment");
            if (!segment.contains(WILDCARD)) continue;
            if (!segment.equals(WILDCARD) || i != segments.length - 1) {
                return Optional.of("'*' is only allowed as the whole final segment or as the whole key");
            }
        }
        return Optional.empty();
    }

    /**
     * Keys whose entries could decide a check, most specific first. A key's index is its
     * specificity rank (lower wins).
     */
    public static List<String> candidateKeys(PermissionMode mode, String permission) {
        return List.of(candidates(mode, permission));
    }

    // The candidate keys in specificity order, without duplicates. In nodes mode: the key, then the
    // key cut at each dot from the right with the wildcard appended, then the bare wildcard. Only
    // the first cut can repeat the key, when the key itself ends in a wildcard segment.
    private static String[] candidates(PermissionMode mode, String permission) {
        String key = normalizeKey(mode, permission);
        if (mode == PermissionMode.EXACT || key.equals(WILDCARD)) return new String[] {key};
        int dots = 0;
        for (int i = 0; i < key.length(); i++) {
            if (key.charAt(i) == '.') dots++;
        }
        String[] out = new String[dots + 2];
        int n = 0;
        out[n++] = key;
        for (int dot = key.lastIndexOf('.'); dot >= 0; dot = dot == 0 ? -1 : key.lastIndexOf('.', dot - 1)) {
            String cut = key.substring(0, dot + 1) + WILDCARD;
            if (n == 1 && cut.equals(key)) continue;
            out[n++] = cut;
        }
        out[n++] = WILDCARD;
        return n == out.length ? out : Arrays.copyOf(out, n);
    }

    // The specificity rank of a key among the candidates, or -1 when it is not one.
    private static int rankOf(String[] candidates, String key) {
        for (int i = 0; i < candidates.length; i++) {
            if (candidates[i].equals(key)) return i;
        }
        return -1;
    }

    /**
     * Resolves one active member's check from global overrides and roles, with no context: only
     * global entries apply. Membership and status gating are the caller's job. Answers
     * {@link PermissionSource#DEFAULT} when nothing matches.
     *
     * @param overrides the member's global overrides, normalized key to value
     * @param roles every role of the group by id, entries normalized
     */
    public static PermissionCheckResult resolve(
            PermissionMode mode,
            Map<String, Boolean> overrides,
            List<String> directRoleIds,
            Map<String, ResolverRole> roles,
            String permission) {
        return resolve(mode, overrides, List.of(), directRoleIds, roles, permission, Map.of());
    }

    /**
     * Resolves one active member's check in a context. Membership and status gating are the
     * caller's job. Answers {@link PermissionSource#DEFAULT} when nothing matches.
     *
     * @param overrides the member's global overrides, normalized key to value
     * @param contextOverrides the member's contextual overrides, keys normalized
     * @param roles every role of the group by id, entries normalized
     * @param context the check's context
     * @param inheritance the game's context inheritance
     */
    public static PermissionCheckResult resolve(
            PermissionMode mode,
            Map<String, Boolean> overrides,
            List<PermissionEntry> contextOverrides,
            List<String> directRoleIds,
            Map<String, ResolverRole> roles,
            String permission,
            Context context,
            ContextInheritance inheritance) {
        Objects.requireNonNull(context, "context");
        Objects.requireNonNull(inheritance, "inheritance");
        return resolve(mode, overrides, contextOverrides, directRoleIds, roles, permission,
                inheritance.chains(context));
    }

    /**
     * As {@link #resolve(PermissionMode, Map, List, List, Map, String, Context, ContextInheritance)}
     * with the check context's chains already computed by {@link ContextInheritance#chains}, for a
     * caller that checks many permissions in one context.
     */
    public static PermissionCheckResult resolve(
            PermissionMode mode,
            Map<String, Boolean> overrides,
            List<PermissionEntry> contextOverrides,
            List<String> directRoleIds,
            Map<String, ResolverRole> roles,
            String permission,
            Map<String, Map<String, Integer>> chains) {
        Objects.requireNonNull(permission, "permission");
        String[] candidates = candidates(mode, permission);
        PermissionCheckResult own = ownAnswer(overrides, contextOverrides, candidates, chains);
        if (own != null) return own;

        Set<String> visited = new HashSet<>();
        List<String> layer = firstLayer(directRoleIds, roles);
        for (int depth = 0; !layer.isEmpty() && depth <= MAX_ROLE_DEPTH; depth++) {
            visited.addAll(layer);
            PermissionCheckResult decided = layerAnswer(layer, roles, candidates, chains);
            if (decided != null) return decided;
            layer = nextLayer(layer, roles, visited);
        }
        return DEFAULT_ANSWER;
    }

    private static final PermissionCheckResult DEFAULT_ANSWER = PermissionCheckResult.of(false, PermissionSource.DEFAULT);

    // The directly held roles that exist, each once, in the order given.
    private static List<String> firstLayer(List<String> directRoleIds, Map<String, ResolverRole> roles) {
        List<String> layer = new ArrayList<>(directRoleIds.size());
        for (String id : new LinkedHashSet<>(directRoleIds)) {
            if (roles.containsKey(id)) layer.add(id);
        }
        return layer;
    }

    // The parents of a layer that exist and sit in no earlier layer, each once, in order.
    private static List<String> nextLayer(List<String> layer, Map<String, ResolverRole> roles, Set<String> visited) {
        LinkedHashSet<String> next = new LinkedHashSet<>();
        for (String id : layer) {
            for (String parent : roles.get(id).parents()) {
                if (!visited.contains(parent) && roles.containsKey(parent)) next.add(parent);
            }
        }
        return new ArrayList<>(next);
    }

    // The overrides' answer, or null when no override applies.
    private static PermissionCheckResult ownAnswer(
            Map<String, Boolean> overrides,
            List<PermissionEntry> contextOverrides,
            String[] candidates,
            Map<String, Map<String, Integer>> chains) {
        SourceBest own = sourceBest(overrides, contextOverrides, candidates, chains);
        if (own == null) return null;
        boolean allowed = own.deny == null;
        return new PermissionCheckResult(allowed, PermissionSource.OVERRIDE, null, null, allowed ? own.grant : own.deny);
    }

    // The answer of one layer of roles, or null when no entry of the layer applies.
    private static PermissionCheckResult layerAnswer(
            List<String> layer,
            Map<String, ResolverRole> roles,
            String[] candidates,
            Map<String, Map<String, Integer>> chains) {
        int size = layer.size();
        SourceBest[] bests = null;
        Score top = null;
        for (int i = 0; i < size; i++) {
            ResolverRole role = roles.get(layer.get(i));
            SourceBest best = sourceBest(role.entries(), role.contextEntries(), candidates, chains);
            if (best == null) continue;
            if (bests == null) bests = new SourceBest[size];
            bests[i] = best;
            if (top == null || best.score.compareTo(top) < 0) top = best.score;
        }
        if (top == null) return null;
        int denier = -1;
        int granter = -1;
        for (int i = 0; i < size; i++) {
            SourceBest best = bests[i];
            if (best == null || best.score.compareTo(top) != 0) continue;
            if (best.deny != null && (denier < 0 || outranks(layer, roles, i, denier))) denier = i;
            if (best.grant != null && (granter < 0 || outranks(layer, roles, i, granter))) granter = i;
        }
        if (denier >= 0) {
            return new PermissionCheckResult(false, PermissionSource.ROLE, layer.get(denier), null, bests[denier].deny);
        }
        return new PermissionCheckResult(true, PermissionSource.ROLE, layer.get(granter), null, bests[granter].grant);
    }

    // An applicable entry's place in the precedence: context keys matched, chain distance sum,
    // specificity rank. The smaller compares as the better.
    private record Score(int keys, int distance, int rank) implements Comparable<Score> {
        @Override
        public int compareTo(Score o) {
            if (keys != o.keys) return Integer.compare(o.keys, keys);
            if (distance != o.distance) return Integer.compare(distance, o.distance);
            return Integer.compare(rank, o.rank);
        }
    }

    // The best-scoring applicable entries of one role, or of the overrides. deny and grant are null
    // when no entry of that value has the best score; otherwise they hold the context to report for
    // it, the smallest canonical key when several qualify.
    private static final class SourceBest {
        Score score;
        Context deny;
        Context grant;

        SourceBest(Score score) {
            this.score = score;
        }
    }

    private static SourceBest sourceBest(
            Map<String, Boolean> global,
            List<PermissionEntry> contextual,
            String[] candidates,
            Map<String, Map<String, Integer>> chains) {
        SourceBest best = null;
        // Global entries all score zero on context, so only the most specific one matters.
        if (!global.isEmpty()) {
            for (int i = 0; i < candidates.length; i++) {
                Boolean value = global.get(candidates[i]);
                if (value == null) continue;
                best = consider(best, globalScore(i), value, Context.GLOBAL);
                break;
            }
        }
        if (!contextual.isEmpty() && !chains.isEmpty()) {
            for (PermissionEntry entry : contextual) {
                int rank = rankOf(candidates, entry.permission());
                if (rank < 0) continue;
                Score score = contextScore(entry.context(), chains, rank);
                if (score == null) continue;
                best = consider(best, score, entry.value(), entry.context());
            }
        }
        return best;
    }

    private static SourceBest consider(SourceBest best, Score score, boolean value, Context context) {
        if (best == null) {
            best = new SourceBest(score);
        } else {
            int order = score.compareTo(best.score);
            if (order > 0) return best;
            if (order < 0) {
                best.score = score;
                best.deny = null;
                best.grant = null;
            }
        }
        Context held = value ? best.grant : best.deny;
        if (held == null || context.canonicalKey().compareTo(held.canonicalKey()) < 0) {
            if (value) best.grant = context;
            else best.deny = context;
        }
        return best;
    }

    // Null when the entry's context does not apply to the check.
    private static Score contextScore(Context context, Map<String, Map<String, Integer>> chains, int rank) {
        int keys = 0;
        int distance = 0;
        for (Map.Entry<String, String> e : context.values().entrySet()) {
            Map<String, Integer> chain = chains.get(e.getKey());
            Integer d = chain == null ? null : chain.get(e.getValue());
            if (d == null) return null;
            keys++;
            distance += d;
        }
        return new Score(keys, distance, rank);
    }

    // Scores are immutable, so the global ones of the usual ranks are shared.
    private static final Score[] GLOBAL_SCORES = new Score[16];

    static {
        for (int i = 0; i < GLOBAL_SCORES.length; i++) GLOBAL_SCORES[i] = new Score(0, 0, i);
    }

    private static Score globalScore(int rank) {
        return rank < GLOBAL_SCORES.length ? GLOBAL_SCORES[rank] : new Score(0, 0, rank);
    }

    // Whether the role at index a of the layer outranks the one at index b: higher priority first,
    // then the greater role id (UTF-16 code unit order, as the server).
    private static boolean outranks(List<String> layer, Map<String, ResolverRole> roles, int a, int b) {
        long pa = roles.get(layer.get(a)).priority();
        long pb = roles.get(layer.get(b)).priority();
        if (pa != pb) return pa > pb;
        return layer.get(a).compareTo(layer.get(b)) > 0;
    }

    /**
     * Prepares one active member's checks in one context, for a caller that checks many
     * permissions with the same inputs. Its answers equal
     * {@link #resolve(PermissionMode, Map, List, List, Map, String, Map)} with these inputs. The
     * collections are copied.
     *
     * @param overrides the member's global overrides, normalized key to value
     * @param contextOverrides the member's contextual overrides, keys normalized
     * @param roles every role of the group by id, entries normalized
     * @param chains the check context's chains, as {@link ContextInheritance#chains} computes them
     */
    public static Prepared prepare(
            PermissionMode mode,
            Map<String, Boolean> overrides,
            List<PermissionEntry> contextOverrides,
            List<String> directRoleIds,
            Map<String, ResolverRole> roles,
            Map<String, Map<String, Integer>> chains) {
        Objects.requireNonNull(mode, "mode");
        Map<String, Map<String, Integer>> frozen = new HashMap<>();
        chains.forEach((k, v) -> frozen.put(k, Map.copyOf(v)));
        return new Prepared(mode, Map.copyOf(overrides), List.copyOf(contextOverrides), List.copyOf(directRoleIds),
                Collections.unmodifiableMap(new LinkedHashMap<>(roles)), Collections.unmodifiableMap(frozen));
    }

    /**
     * One active member's checks in one context, prepared for repetition: the role layers are
     * walked once, and answers are kept in a memo of at most {@link #MEMO_LIMIT} permissions,
     * emptied when it is full. Answers equal
     * {@link PermissionResolver#resolve(PermissionMode, Map, List, List, Map, String, Map)} with
     * the inputs it was prepared from. Membership and status gating are the caller's job.
     * Thread-safe.
     */
    public static final class Prepared {
        /** The most answers one prepared check keeps. */
        public static final int MEMO_LIMIT = 256;

        private final PermissionMode mode;
        private final Map<String, Boolean> overrides;
        private final List<PermissionEntry> contextOverrides;
        private final Map<String, ResolverRole> roles;
        private final Map<String, Map<String, Integer>> chains;
        private final List<List<String>> layers;
        private final ConcurrentHashMap<String, PermissionCheckResult> memo = new ConcurrentHashMap<>();

        // The inputs are immutable and owned by the caller's compiled state; they are not copied.
        private Prepared(
                PermissionMode mode,
                Map<String, Boolean> overrides,
                List<PermissionEntry> contextOverrides,
                List<String> directRoleIds,
                Map<String, ResolverRole> roles,
                Map<String, Map<String, Integer>> chains) {
            this.mode = mode;
            this.overrides = overrides;
            this.contextOverrides = contextOverrides;
            this.roles = roles;
            this.chains = chains;
            List<List<String>> out = new ArrayList<>();
            Set<String> visited = new HashSet<>();
            List<String> layer = firstLayer(directRoleIds, roles);
            for (int depth = 0; !layer.isEmpty() && depth <= MAX_ROLE_DEPTH; depth++) {
                visited.addAll(layer);
                out.add(List.copyOf(layer));
                layer = nextLayer(layer, roles, visited);
            }
            this.layers = List.copyOf(out);
        }

        /** Resolves one permission, from the memo when it holds the answer. */
        public PermissionCheckResult check(String permission) {
            PermissionCheckResult r = memo.get(Objects.requireNonNull(permission, "permission"));
            if (r != null) return r;
            r = compute(permission);
            if (memo.size() >= MEMO_LIMIT) memo.clear();
            memo.put(permission, r);
            return r;
        }

        private PermissionCheckResult compute(String permission) {
            String[] candidates = candidates(mode, permission);
            PermissionCheckResult own = ownAnswer(overrides, contextOverrides, candidates, chains);
            if (own != null) return own;
            for (List<String> layer : layers) {
                PermissionCheckResult decided = layerAnswer(layer, roles, candidates, chains);
                if (decided != null) return decided;
            }
            return DEFAULT_ANSWER;
        }
    }

    /**
     * Finds one cycle in a role-parent graph and returns the ids on it, or empty when the graph is
     * acyclic. Parents that are not keys of the map are ignored.
     */
    public static Optional<List<String>> findRoleCycle(Map<String, List<String>> parentsById) {
        Map<String, Boolean> done = new HashMap<>();
        for (String start : parentsById.keySet()) {
            if (done.containsKey(start)) continue;
            // Iterative depth-first search so a deep chain cannot overflow the stack.
            Deque<String> path = new ArrayDeque<>();
            Deque<Integer> nextChild = new ArrayDeque<>();
            Set<String> onPath = new HashSet<>();
            path.push(start);
            nextChild.push(0);
            onPath.add(start);
            while (!path.isEmpty()) {
                String id = path.peek();
                int idx = nextChild.pop();
                List<String> parents = parentsById.getOrDefault(id, List.of());
                if (idx < parents.size()) {
                    nextChild.push(idx + 1);
                    String parent = parents.get(idx);
                    if (!parentsById.containsKey(parent) || Boolean.TRUE.equals(done.get(parent))) continue;
                    if (onPath.contains(parent)) {
                        List<String> cycle = new ArrayList<>();
                        List<String> stack = new ArrayList<>(path);
                        Collections.reverse(stack);
                        cycle.addAll(stack.subList(stack.indexOf(parent), stack.size()));
                        return Optional.of(List.copyOf(cycle));
                    }
                    path.push(parent);
                    nextChild.push(0);
                    onPath.add(parent);
                } else {
                    path.pop();
                    onPath.remove(id);
                    done.put(id, Boolean.TRUE);
                }
            }
        }
        return Optional.empty();
    }

    /**
     * Prepares a role graph for repeated checks without context inheritance; see
     * {@link #compile(RoleGraph, ContextInheritance)}.
     */
    public static GroupResolver compile(RoleGraph graph) {
        return compile(graph, ContextInheritance.NONE);
    }

    /**
     * Prepares a role graph for repeated checks: entries normalized once and split into global and
     * contextual, roles indexed by id, the game's context inheritance bound. The result is
     * immutable and thread-safe.
     */
    public static GroupResolver compile(RoleGraph graph, ContextInheritance inheritance) {
        Objects.requireNonNull(inheritance, "inheritance");
        Map<String, ResolverRole> roles = new LinkedHashMap<>();
        for (Role r : graph.roles()) {
            Map<String, Boolean> entries = new HashMap<>();
            List<PermissionEntry> contextual = new ArrayList<>();
            for (PermissionEntry e : r.entries()) {
                String key = normalizeKey(graph.mode(), e.permission());
                if (e.context().isGlobal()) entries.put(key, e.value());
                else contextual.add(new PermissionEntry(key, e.value(), e.context()));
            }
            roles.put(r.id(), new ResolverRole(r.priority(), entries, contextual, r.parents()));
        }
        return new GroupResolver(graph.groupId(), graph.mode(), Collections.unmodifiableMap(roles), inheritance);
    }

    /**
     * A member's overrides normalized for the resolver: global ones by key, contextual ones as a
     * list with their keys normalized.
     */
    public record CompiledOverrides(Map<String, Boolean> global, List<PermissionEntry> contextual) {
        /** No overrides. */
        public static final CompiledOverrides NONE = new CompiledOverrides(Map.of(), List.of());

        /** Copies the collections. */
        public CompiledOverrides {
            global = Map.copyOf(global);
            contextual = List.copyOf(contextual);
        }

        /** Normalizes a member's overrides in the mode. */
        public static CompiledOverrides of(PermissionMode mode, List<MemberPermissionOverride> overrides) {
            if (overrides.isEmpty()) return NONE;
            Map<String, Boolean> global = new HashMap<>();
            List<PermissionEntry> contextual = new ArrayList<>();
            for (MemberPermissionOverride o : overrides) {
                String key = normalizeKey(mode, o.permission());
                if (o.context().isGlobal()) global.put(key, o.grant());
                else contextual.add(new PermissionEntry(key, o.grant(), o.context()));
            }
            return new CompiledOverrides(global, contextual);
        }

        /** Normalizes raw override entries in the mode. */
        public static CompiledOverrides ofEntries(PermissionMode mode, List<PermissionEntry> overrides) {
            if (overrides.isEmpty()) return NONE;
            Map<String, Boolean> global = new HashMap<>();
            List<PermissionEntry> contextual = new ArrayList<>();
            for (PermissionEntry e : overrides) {
                String key = normalizeKey(mode, e.permission());
                if (e.context().isGlobal()) global.put(key, e.value());
                else contextual.add(new PermissionEntry(key, e.value(), e.context()));
            }
            return new CompiledOverrides(global, contextual);
        }
    }

    /**
     * A compiled, immutable resolver for one group's role graph.
     *
     * @param inheritance the game's context inheritance the checks resolve with
     */
    public record GroupResolver(
            String groupId, PermissionMode mode, Map<String, ResolverRole> roles, ContextInheritance inheritance) {
        /** A null inheritance reads as {@link ContextInheritance#NONE}. */
        public GroupResolver {
            if (inheritance == null) inheritance = ContextInheritance.NONE;
        }

        /** A resolver without context inheritance. */
        public GroupResolver(String groupId, PermissionMode mode, Map<String, ResolverRole> roles) {
            this(groupId, mode, roles, ContextInheritance.NONE);
        }

        /**
         * Checks a member with no context, with the server's status gate: a member who is not
         * active answers {@code allowed=false, source=none}.
         */
        public PermissionCheckResult check(MemberAccess access, String permission) {
            return check(access, permission, Context.GLOBAL);
        }

        /**
         * Checks a member in a context, with the server's status gate: a member who is not active
         * answers {@code allowed=false, source=none}.
         */
        public PermissionCheckResult check(MemberAccess access, String permission, Context context) {
            if (access.status() != MemberStatus.ACTIVE) return PermissionCheckResult.of(false, PermissionSource.NONE);
            CompiledOverrides o = CompiledOverrides.of(mode, access.overrides());
            return resolve(mode, o.global(), o.contextual(), access.roleIds(), roles, permission, context, inheritance);
        }

        /**
         * Prepares an active member's checks in a context against this graph; see
         * {@link Prepared}. The resolver's roles are used as they are, not copied.
         *
         * @param overrides the member's overrides, normalized
         */
        public Prepared prepare(CompiledOverrides overrides, List<String> directRoleIds, Context context) {
            Objects.requireNonNull(context, "context");
            return new Prepared(mode, overrides.global(), overrides.contextual(), List.copyOf(directRoleIds), roles,
                    inheritance.chains(context));
        }

        /** Checks an active member from raw inputs with no context; override keys are normalized here. */
        public PermissionCheckResult check(List<String> roleIds, Map<String, Boolean> overrides, String permission) {
            Map<String, Boolean> normalized = new HashMap<>();
            overrides.forEach((k, v) -> normalized.put(normalizeKey(mode, k), v));
            return resolve(mode, normalized, roleIds, roles, permission);
        }

        /**
         * Checks an active member from raw inputs in a context; override keys are normalized here.
         *
         * @param overrides the member's overrides, global and contextual
         */
        public PermissionCheckResult check(
                List<String> roleIds, List<PermissionEntry> overrides, String permission, Context context) {
            CompiledOverrides o = CompiledOverrides.ofEntries(mode, overrides);
            return resolve(mode, o.global(), o.contextual(), roleIds, roles, permission, context, inheritance);
        }
    }
}
