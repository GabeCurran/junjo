package io.junjo.sdk.mirror;

import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberPermissionOverride;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.permissions.PermissionResolver;
import io.junjo.sdk.permissions.PermissionResolver.CompiledOverrides;
import io.junjo.sdk.permissions.PermissionResolver.ResolverRole;
import java.util.ArrayDeque;
import java.util.Collections;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/**
 * Repeated permission checks for one member of one group, in one context. Gives the same answers
 * as {@link GameMirror#check(String, String, String, Context)} with that context, but normalizes
 * the member's overrides and the context's inheritance chains once and reuses them until the
 * member's access or the group's graph changes; it always reads the mirror's current state, so it
 * never goes stale. A checker taken without a context checks in {@link Context#GLOBAL}.
 *
 * <p>Thread-safe and lock-free like the mirror's other reads.
 */
public final class MemberChecker {
    private final GameMirror mirror;
    private final String userId;
    private final String groupId;
    private final Context context;
    private volatile Compiled compiled;

    // The inputs one compiled form was built from; compared by identity, since state objects are
    // replaced, never mutated.
    private record Compiled(
            GameMirror.GroupState group,
            MemberAccess access,
            CompiledOverrides overrides,
            Map<String, Map<String, Integer>> chains) {}

    MemberChecker(GameMirror mirror, String userId, String groupId, Context context) {
        this.mirror = mirror;
        this.userId = userId;
        this.groupId = groupId;
        this.context = context;
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

    /** Empty when the group's graph or the member's access is not loaded. */
    public Optional<PermissionCheckResult> check(String permission) {
        GameMirror.Lookup in = mirror.lookup(userId, groupId);
        if (in == null) return Optional.empty();
        if (in.access() != null && in.access().status() != MemberStatus.ACTIVE) {
            return Optional.of(PermissionCheckResult.of(false, PermissionSource.NONE));
        }
        if (in.access() == null && !mirror.defaultRoleApplies(in.group())) {
            return Optional.of(PermissionCheckResult.of(false, PermissionSource.NONE));
        }
        Compiled c = compile(in);
        PermissionResolver.GroupResolver resolver = in.group().resolver();
        return Optional.of(PermissionResolver.resolve(
                resolver.mode(), c.overrides().global(), c.overrides().contextual(),
                in.access() != null ? in.access().roleIds() : List.of(in.group().graph().defaultRoleId()),
                resolver.roles(), permission, c.chains()));
    }

    /** YES or NO, or UNKNOWN when not loaded. */
    public Answer can(String permission) {
        return check(permission).map(r -> Answer.of(r.allowed())).orElse(Answer.UNKNOWN);
    }

    /**
     * Every key named by the member's overrides or by an entry of a role they hold (directly or
     * through parents), global or for any context, that resolves to allowed in this checker's
     * context. Wildcard keys appear as written. Empty when not loaded.
     */
    public Optional<Set<String>> grantedKeys() {
        GameMirror.Lookup in = mirror.lookup(userId, groupId);
        if (in == null) return Optional.empty();
        Set<String> candidates = new HashSet<>();
        Map<String, ResolverRole> roles = in.group().resolver().roles();
        Deque<String> pending = new ArrayDeque<>();
        if (in.access() != null) {
            for (MemberPermissionOverride o : in.access().overrides()) candidates.add(o.permission());
            pending.addAll(in.access().roleIds());
        } else if (mirror.defaultRoleApplies(in.group())) {
            pending.add(in.group().graph().defaultRoleId());
        }
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
        CompiledOverrides overrides = in.access() == null
                ? CompiledOverrides.NONE
                : CompiledOverrides.of(resolver.mode(), in.access().overrides());
        c = new Compiled(in.group(), in.access(), overrides, resolver.inheritance().chains(context));
        compiled = c;
        return c;
    }
}
