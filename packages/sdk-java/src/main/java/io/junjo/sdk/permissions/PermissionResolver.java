package io.junjo.sdk.permissions;

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

/**
 * Local permission resolution, the same algorithm the server runs and held to the same shared
 * conformance vectors. Pure: no I/O, no shared mutable state, safe from any thread.
 *
 * <p>Precedence, applied in order:
 * <ol>
 *   <li>Layer. The member's own overrides, then the roles held directly, then their parents, then
 *       grandparents. A role reachable through several paths sits at its shortest distance. The
 *       first layer with any matching entry decides.
 *   <li>Specificity within that layer: the exact key beats the longest matching wildcard, down to
 *       the bare wildcard.
 *   <li>Deny wins between entries of equal layer and specificity. Among equal entries the role
 *       reported is the one with the highest priority, then the greatest id.
 * </ol>
 *
 * <p>The mode only changes key matching. Case folding in {@code nodes} mode is ASCII-only (A-Z to
 * a-z) and independent of the default locale. It deliberately does not use
 * {@link String#toLowerCase(java.util.Locale)}: even under {@code Locale.ROOT} that folds some
 * non-ASCII characters (KELVIN SIGN U+212A) to ASCII letters, which would let a check match a
 * stored key that the server, folding ASCII only, does not match.
 */
public final class PermissionResolver {
    /** Bounds the role-parent walk; writes are cycle-checked, so this only guards corrupt data. */
    public static final int MAX_ROLE_DEPTH = 100;

    private static final String WILDCARD = "*";

    private PermissionResolver() {}

    /**
     * A role as the resolver sees it.
     *
     * @param entries normalized key to grant (true) or deny (false)
     */
    public record ResolverRole(long priority, Map<String, Boolean> entries, List<String> parents) {
        /** Copies the collections. */
        public ResolverRole {
            entries = Map.copyOf(entries);
            parents = List.copyOf(parents);
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
        String key = normalizeKey(mode, permission);
        if (mode == PermissionMode.EXACT) return List.of(key);
        LinkedHashSet<String> out = new LinkedHashSet<>();
        out.add(key);
        if (!key.equals(WILDCARD)) {
            String[] segments = key.split("\\.", -1);
            for (int i = segments.length - 1; i >= 1; i--) {
                out.add(String.join(".", java.util.Arrays.copyOfRange(segments, 0, i)) + "." + WILDCARD);
            }
            out.add(WILDCARD);
        }
        return List.copyOf(out);
    }

    /**
     * Resolves one active member's check from overrides and roles. Membership and status gating
     * are the caller's job. Answers {@link PermissionSource#DEFAULT} when nothing matches.
     *
     * @param overrides the member's overrides, normalized key to value
     * @param roles every role of the group by id, entries normalized
     */
    public static PermissionCheckResult resolve(
            PermissionMode mode,
            Map<String, Boolean> overrides,
            List<String> directRoleIds,
            Map<String, ResolverRole> roles,
            String permission) {
        Objects.requireNonNull(permission, "permission");
        List<String> candidates = candidateKeys(mode, permission);

        int overrideRank = bestCandidate(overrides, candidates);
        if (overrideRank != -1) {
            return PermissionCheckResult.of(overrides.get(candidates.get(overrideRank)), PermissionSource.OVERRIDE);
        }

        Set<String> visited = new HashSet<>();
        List<String> layer = new ArrayList<>();
        for (String id : new LinkedHashSet<>(directRoleIds)) {
            if (roles.containsKey(id)) layer.add(id);
        }
        for (int depth = 0; !layer.isEmpty() && depth <= MAX_ROLE_DEPTH; depth++) {
            visited.addAll(layer);

            int rank = -1;
            for (String id : layer) {
                int r = bestCandidate(roles.get(id).entries(), candidates);
                if (r != -1 && (rank == -1 || r < rank)) rank = r;
            }

            if (rank != -1) {
                String key = candidates.get(rank);
                String denier = null;
                long denierPriority = 0;
                String granter = null;
                long granterPriority = 0;
                for (String id : layer) {
                    ResolverRole role = roles.get(id);
                    Boolean value = role.entries().get(key);
                    if (value == null) continue;
                    if (!value) {
                        if (denier == null || outranks(id, role.priority(), denier, denierPriority)) {
                            denier = id;
                            denierPriority = role.priority();
                        }
                    } else if (granter == null || outranks(id, role.priority(), granter, granterPriority)) {
                        granter = id;
                        granterPriority = role.priority();
                    }
                }
                String decider = denier != null ? denier : granter;
                return new PermissionCheckResult(denier == null, PermissionSource.ROLE, decider, null);
            }

            LinkedHashSet<String> next = new LinkedHashSet<>();
            for (String id : layer) {
                for (String parent : roles.get(id).parents()) {
                    if (!visited.contains(parent) && roles.containsKey(parent)) next.add(parent);
                }
            }
            layer = new ArrayList<>(next);
        }
        return PermissionCheckResult.of(false, PermissionSource.DEFAULT);
    }

    private static int bestCandidate(Map<String, Boolean> entries, List<String> candidates) {
        for (int i = 0; i < candidates.size(); i++) {
            if (entries.containsKey(candidates.get(i))) return i;
        }
        return -1;
    }

    // Higher priority first, then the greater role id (UTF-16 code unit order, as the server).
    private static boolean outranks(String aId, long aPriority, String bId, long bPriority) {
        if (aPriority != bPriority) return aPriority > bPriority;
        return aId.compareTo(bId) > 0;
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
     * Prepares a role graph for repeated checks: entries normalized once, roles indexed by id. The
     * result is immutable and thread-safe.
     */
    public static GroupResolver compile(RoleGraph graph) {
        Map<String, ResolverRole> roles = new LinkedHashMap<>();
        for (Role r : graph.roles()) {
            Map<String, Boolean> entries = new HashMap<>();
            for (PermissionEntry e : r.entries()) {
                entries.put(normalizeKey(graph.mode(), e.permission()), e.value());
            }
            roles.put(r.id(), new ResolverRole(r.priority(), entries, r.parents()));
        }
        return new GroupResolver(graph.groupId(), graph.mode(), Collections.unmodifiableMap(roles));
    }

    /** A compiled, immutable resolver for one group's role graph. */
    public record GroupResolver(String groupId, PermissionMode mode, Map<String, ResolverRole> roles) {
        /**
         * Checks a member with the server's status gate: a member who is not active answers
         * {@code allowed=false, source=none}.
         */
        public PermissionCheckResult check(MemberAccess access, String permission) {
            if (access.status() != MemberStatus.ACTIVE) return PermissionCheckResult.of(false, PermissionSource.NONE);
            Map<String, Boolean> overrides = new HashMap<>();
            for (MemberPermissionOverride o : access.overrides()) {
                overrides.put(normalizeKey(mode, o.permission()), o.grant());
            }
            return resolve(mode, overrides, access.roleIds(), roles, permission);
        }

        /** Checks an active member from raw inputs; override keys are normalized here. */
        public PermissionCheckResult check(List<String> roleIds, Map<String, Boolean> overrides, String permission) {
            Map<String, Boolean> normalized = new HashMap<>();
            overrides.forEach((k, v) -> normalized.put(normalizeKey(mode, k), v));
            return resolve(mode, normalized, roleIds, roles, permission);
        }
    }
}
