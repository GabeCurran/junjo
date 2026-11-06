package io.junjo.sdk.mirror;

import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.permissions.PermissionResolver;
import io.junjo.sdk.permissions.PermissionResolver.CompiledOverrides;
import io.junjo.sdk.permissions.PermissionResolver.ResolverRole;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * Repeated permission checks for one member of one group, in one context. Gives the same answers
 * as {@link GameMirror#check(String, String, String, Context)} with that context, but prepares the
 * member's overrides, held role layers and the context's inheritance chains once, and memoizes
 * answers (see {@link PermissionResolver.Prepared}), until the member's access or the group's
 * graph changes; it always reads the mirror's current state, so it never goes stale. A checker
 * taken without a context checks in {@link Context#GLOBAL}.
 *
 * <p>{@link #excludingRoles(Collection)} derives a checker that answers as if the member did not
 * hold some roles, and {@link #excludingOverrides()} one that answers as if the member had no
 * personal overrides. The two compose in either order.
 *
 * <p>Thread-safe and lock-free like the mirror's other reads.
 */
public final class MemberChecker {
    private final GameMirror mirror;
    private final String userId;
    private final String groupId;
    private final Context context;
    private final Set<String> excluded;
    private final boolean noOverrides;
    private volatile Compiled compiled;

    // The inputs one compiled form was built from; compared by identity, since state objects are
    // replaced, never mutated, so a prepared answer cannot outlive the graph or access it came
    // from. held is the role list checks start from, exclusions applied.
    private record Compiled(
            GameMirror.GroupState group, MemberAccess access, List<String> held, PermissionResolver.Prepared prepared) {}

    MemberChecker(GameMirror mirror, String userId, String groupId, Context context) {
        this(mirror, userId, groupId, context, Set.of(), false);
    }

    private MemberChecker(
            GameMirror mirror, String userId, String groupId, Context context, Set<String> excluded,
            boolean noOverrides) {
        this.mirror = mirror;
        this.userId = userId;
        this.groupId = groupId;
        this.context = context;
        this.excluded = excluded;
        this.noOverrides = noOverrides;
    }

    public String userId() {
        return userId;
    }

    public String groupId() {
        return groupId;
    }

    /** The context every check of this checker is made in. */
    public Context context() {
        return context;
    }

    /** The role ids this checker treats as not held; empty for a checker taken from the mirror. */
    public Set<String> excludedRoles() {
        return excluded;
    }

    /**
     * Whether this checker answers as if the member had no personal overrides; false for a
     * checker taken from the mirror.
     */
    public boolean excludesOverrides() {
        return noOverrides;
    }

    /**
     * A checker for the same member, group and context that answers as if the member did not hold
     * these roles, in addition to any this checker already excludes. This checker is unchanged.
     *
     * <p>Exclusion removes a role from the roles the member holds directly, and nothing else: the
     * check then runs as it would for a member whose access lists only the remaining roles. A
     * role reached as a parent of a remaining role still applies, even when it is excluded, so to
     * stop a role and everything that inherits from it, exclude those roles too. The member's
     * overrides apply as before, and so does the context. For a user with no membership checked
     * against the group's default role ({@link GameMirror.Builder#defaultRoleForNonMembers}),
     * excluding the default role leaves them holding none. Ids that name no role are ignored.
     *
     * @param roleIds the role ids to treat as not held, compared exactly
     */
    public MemberChecker excludingRoles(Collection<String> roleIds) {
        Objects.requireNonNull(roleIds, "roleIds");
        Set<String> next = new HashSet<>(excluded);
        for (String id : roleIds) next.add(Objects.requireNonNull(id, "role id"));
        if (next.size() == excluded.size()) return this;
        return new MemberChecker(mirror, userId, groupId, context, Set.copyOf(next), noOverrides);
    }

    /**
     * A checker for the same member, group and context that answers as if the member had no
     * personal overrides, global or contextual, keeping any roles this checker already excludes.
     * This checker is unchanged.
     *
     * <p>Only the overrides layer is left out: the check then runs as it would for a member whose
     * access lists no overrides. Role entries, role parents, the context and its inheritance apply
     * as before, and so does the status gate: a member who is not active still answers
     * {@code allowed=false, source=none}. {@link #grantedKeys()} leaves out the keys only the
     * overrides named.
     */
    public MemberChecker excludingOverrides() {
        if (noOverrides) return this;
        return new MemberChecker(mirror, userId, groupId, context, excluded, true);
    }

    /** Empty when the group's graph or the member's access is not loaded. */
    public Optional<PermissionCheckResult> check(String permission) {
        return Optional.ofNullable(result(permission));
    }

    /** YES or NO, or UNKNOWN when not loaded. */
    public Answer can(String permission) {
        PermissionCheckResult r = result(permission);
        return r == null ? Answer.UNKNOWN : Answer.of(r.allowed());
    }

    // Null when not loaded.
    private PermissionCheckResult result(String permission) {
        GameMirror.Lookup in = mirror.lookup(userId, groupId);
        if (in == null) return null;
        if (in.access() != null && in.access().status() != MemberStatus.ACTIVE) return GameMirror.NOT_HELD;
        if (in.access() == null && !mirror.defaultRoleApplies(in.group())) return GameMirror.NOT_HELD;
        return compile(in).prepared().check(permission);
    }

    /**
     * Every key named by the member's overrides or by an entry of a role they hold (directly or
     * through parents), global or for any context, that resolves to allowed in this checker's
     * context. Wildcard keys appear as written. Excluded roles are left out as held roles, and
     * excluded overrides are left out entirely, as in {@link #check(String)}. Empty when not
     * loaded.
     */
    public Optional<Set<String>> grantedKeys() {
        GameMirror.Lookup in = mirror.lookup(userId, groupId);
        if (in == null) return Optional.empty();
        Set<String> candidates = new HashSet<>();
        Map<String, ResolverRole> roles = in.group().resolver().roles();
        Deque<String> pending = new ArrayDeque<>();
        if (in.access() != null && !noOverrides) {
            for (MemberPermissionOverride o : in.access().overrides()) candidates.add(o.permission());
        }
        if (in.access() != null || mirror.defaultRoleApplies(in.group())) pending.addAll(compile(in).held());
        Set<String> seen = new HashSet<>();
        while (!pending.isEmpty()) {
            String id = pending.pop();
            ResolverRole r = roles.get(id);
            if (r == null || !seen.add(id)) continue;
            candidates.addAll(r.entries().keySet());
            for (PermissionEntry e : r.contextEntries()) candidates.add(e.permission());
            pending.addAll(r.parents());
        }
        Set<String> out = new TreeSet<>();
        for (String key : candidates) {
            if (check(key).map(PermissionCheckResult::allowed).orElse(false)) out.add(key);
        }
        return Optional.of(Collections.unmodifiableSet(out));
    }

    private Compiled compile(GameMirror.Lookup in) {
        Compiled c = compiled;
        if (c != null && c.group() == in.group() && c.access() == in.access()) return c;
        PermissionResolver.GroupResolver resolver = in.group().resolver();
        CompiledOverrides overrides = in.access() == null || noOverrides
                ? CompiledOverrides.NONE
                : CompiledOverrides.of(resolver.mode(), in.access().overrides());
        List<String> direct = in.access() != null
                ? in.access().roleIds()
                : mirror.defaultRoleApplies(in.group()) ? List.of(in.group().graph().defaultRoleId()) : List.of();
        List<String> held = direct;
        if (!excluded.isEmpty()) {
            held = new ArrayList<>(direct.size());
            for (String id : direct) if (!excluded.contains(id)) held.add(id);
            held = List.copyOf(held);
        }
        c = new Compiled(in.group(), in.access(), held, resolver.prepare(overrides, held, context));
        compiled = c;
        return c;
    }
}
