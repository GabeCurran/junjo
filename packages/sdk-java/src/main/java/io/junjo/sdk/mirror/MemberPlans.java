package io.junjo.sdk.mirror;

import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.permissions.PermissionResolver.CompiledOverrides;
import io.junjo.sdk.permissions.PermissionResolver.GroupResolver;
import io.junjo.sdk.permissions.PermissionResolver.Prepared;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The prepared checks of one member entry, one per context checked, each bound by identity to
 * the group state it was prepared against: a replaced graph or a recompiled inheritance makes a
 * new group state, so a prepared check is rebuilt rather than reused. The entry itself is
 * replaced whenever the member's access is, which drops its plans with it. At most
 * {@link #CONTEXT_LIMIT} contexts are kept; the set is emptied when a new one would pass that.
 * Thread-safe; two threads preparing the same context at once build equal plans.
 */
final class MemberPlans {
    static final int CONTEXT_LIMIT = 4;

    private record Plan(GameMirror.GroupState group, Prepared prepared) {}

    private final ConcurrentHashMap<Context, Plan> byContext = new ConcurrentHashMap<>();

    /**
     * The prepared checks for this access in the context. A null access is a user with no
     * membership checked against the group's default role, so the caller must have made sure
     * the graph has one.
     */
    Prepared prepared(GameMirror.GroupState group, MemberAccess access, Context context) {
        Plan p = byContext.get(context);
        if (p != null && p.group() == group) return p.prepared();
        GroupResolver resolver = group.resolver();
        CompiledOverrides overrides = access == null
                ? CompiledOverrides.NONE
                : CompiledOverrides.of(resolver.mode(), access.overrides());
        List<String> held = access != null ? access.roleIds() : List.of(group.graph().defaultRoleId());
        p = new Plan(group, resolver.prepare(overrides, held, context));
        if (byContext.size() >= CONTEXT_LIMIT && !byContext.containsKey(context)) byContext.clear();
        byContext.put(context, p);
        return p.prepared();
    }
}
