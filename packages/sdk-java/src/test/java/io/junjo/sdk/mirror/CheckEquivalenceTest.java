package io.junjo.sdk.mirror;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.mirror.GameMirror.GroupState;
import io.junjo.sdk.mirror.GameMirror.MemberEntry;
import io.junjo.sdk.mirror.GameMirror.MemberKey;
import io.junjo.sdk.mirror.GameMirror.State;
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
import io.junjo.sdk.permissions.ContextInheritance;
import io.junjo.sdk.permissions.PermissionResolver;
import io.junjo.sdk.permissions.PermissionResolver.CompiledOverrides;
import io.junjo.sdk.permissions.PermissionResolver.GroupResolver;
import java.lang.reflect.Field;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

/**
 * The prepared, memoized checks of the mirror and of member checkers against the uncached
 * resolver, over randomized graphs, contexts, overrides, exclusions and state replacements.
 */
@Timeout(120)
class CheckEquivalenceTest {
    static final String[] SEGMENTS = {"a", "b", "c", "B", "fly"};
    static final String[] CONTEXT_KEYS = {"world", "server"};
    static final String[] CONTEXT_VALUES = {"nether", "overworld", "end", "Hub", "lobby"};

    final List<JunjoClient> clients = new ArrayList<>();

    @AfterEach
    void tearDown() {
        for (JunjoClient c : clients) c.close();
    }

    @Test
    void preparedAnswersEqualTheResolverForRandomInputs() {
        Random rnd = new Random(20261106L);
        for (int round = 0; round < 400; round++) {
            RoleGraph graph = graph(rnd);
            ContextInheritance inheritance = inheritance(rnd);
            GroupResolver resolver = PermissionResolver.compile(graph, inheritance);
            CompiledOverrides overrides = CompiledOverrides.of(graph.mode(), overrides(rnd));
            List<String> held = heldRoles(rnd, graph);
            Context context = context(rnd);
            PermissionResolver.Prepared viaResolver = resolver.prepare(overrides, held, context);
            PermissionResolver.Prepared viaStatic = PermissionResolver.prepare(graph.mode(), overrides.global(),
                    overrides.contextual(), held, resolver.roles(), inheritance.chains(context));
            for (int i = 0; i < 40; i++) {
                String permission = permission(rnd);
                PermissionCheckResult expected = PermissionResolver.resolve(graph.mode(), overrides.global(),
                        overrides.contextual(), held, resolver.roles(), permission, context, inheritance);
                for (int twice = 0; twice < 2; twice++) {
                    assertEquals(expected, viaResolver.check(permission), "round " + round + " " + permission);
                    assertEquals(expected, viaStatic.check(permission), "round " + round + " " + permission);
                }
            }
        }
    }

    @Test
    void mirrorAndCheckerAnswersEqualTheUncachedPathAcrossStateChanges() throws Exception {
        Random rnd = new Random(7L);
        for (int round = 0; round < 150; round++) {
            boolean defaultRole = rnd.nextBoolean();
            GameMirror mirror = mirror(defaultRole);
            RoleGraph graph = graph(rnd);
            ContextInheritance inheritance = inheritance(rnd);
            MemberAccess access = rnd.nextInt(5) == 0 ? null : access(rnd, graph);
            install(mirror, graph, inheritance, access);

            Context context = context(rnd);
            Set<String> excluded = new HashSet<>();
            for (Role r : graph.roles()) if (rnd.nextInt(4) == 0) excluded.add(r.id());
            boolean noOverrides = rnd.nextInt(3) == 0;
            MemberChecker plain = mirror.checker("u", "g", context);
            MemberChecker reduced = plain.excludingRoles(excluded);
            if (noOverrides) reduced = reduced.excludingOverrides();

            // Each step replaces the graph, the access, both, or the inheritance, and the same
            // checkers must answer for the new state at once.
            for (int step = 0; step < 4; step++) {
                for (int i = 0; i < 30; i++) {
                    String permission = permission(rnd);
                    Optional<PermissionCheckResult> expected =
                            Optional.of(reference(graph, inheritance, access, defaultRole, permission, context));
                    for (int twice = 0; twice < 2; twice++) {
                        String where = "round " + round + " step " + step + " " + permission + " in " + context;
                        assertEquals(expected, mirror.check("u", "g", permission, context), where);
                        assertEquals(expected, plain.check(permission), where);
                        assertEquals(expected.get().allowed(),
                                mirror.can("u", "g", permission, context) == Answer.YES, where);
                        Optional<PermissionCheckResult> expectedReduced = Optional.of(reduced(
                                graph, inheritance, access, defaultRole, permission, context, excluded, noOverrides));
                        assertEquals(expectedReduced, reduced.check(permission), where + " reduced");
                        assertEquals(expectedReduced.get().allowed(), reduced.can(permission) == Answer.YES, where);
                    }
                }
                switch (rnd.nextInt(4)) {
                    case 0 -> graph = graph(rnd);
                    case 1 -> access = rnd.nextInt(5) == 0 ? null : access(rnd, graph);
                    case 2 -> {
                        graph = graph(rnd);
                        access = access(rnd, graph);
                    }
                    default -> inheritance = inheritance(rnd);
                }
                install(mirror, graph, inheritance, access);
            }
        }
    }

    @Test
    void memosStayBounded() throws Exception {
        RoleGraph graph = new RoleGraph("g", PermissionMode.NODES, "r", List.of(role("r", 1, List.of(), List.of(
                new PermissionEntry("a.*", true, Context.GLOBAL)))));
        GroupResolver resolver = PermissionResolver.compile(graph);
        PermissionResolver.Prepared prepared = resolver.prepare(CompiledOverrides.NONE, List.of("r"), Context.GLOBAL);
        for (int i = 0; i < 5 * PermissionResolver.Prepared.MEMO_LIMIT; i++) {
            assertEquals(true, prepared.check("a.p" + i).allowed());
            assertTrue(memoSize(prepared) <= PermissionResolver.Prepared.MEMO_LIMIT);
        }

        GameMirror mirror = mirror(false);
        install(mirror, graph, ContextInheritance.NONE,
                new MemberAccess("g", "u", MemberStatus.ACTIVE, List.of("r"), List.of(), 1, null, Map.of()));
        MemberEntry entry = mirror.lookup("u", "g").entry();
        for (int i = 0; i < 20; i++) {
            assertEquals(Answer.YES, mirror.can("u", "g", "a.b", Context.of("world", "w" + i)));
            assertTrue(planCount(entry.plans()) <= MemberPlans.CONTEXT_LIMIT);
        }
    }

    // ---- references: the uncached paths the prepared ones must equal

    static PermissionCheckResult reference(RoleGraph graph, ContextInheritance inheritance, MemberAccess access,
            boolean defaultRole, String permission, Context context) {
        GroupResolver resolver = PermissionResolver.compile(graph, inheritance);
        if (access != null) return resolver.check(access, permission, context);
        if (!defaultRole || graph.defaultRoleId() == null) return PermissionCheckResult.of(false, PermissionSource.NONE);
        return resolver.check(List.of(graph.defaultRoleId()), List.of(), permission, context);
    }

    static PermissionCheckResult reduced(RoleGraph graph, ContextInheritance inheritance, MemberAccess access,
            boolean defaultRole, String permission, Context context, Set<String> excluded, boolean noOverrides) {
        if (access != null && access.status() != MemberStatus.ACTIVE) {
            return PermissionCheckResult.of(false, PermissionSource.NONE);
        }
        if (access == null && (!defaultRole || graph.defaultRoleId() == null)) {
            return PermissionCheckResult.of(false, PermissionSource.NONE);
        }
        GroupResolver resolver = PermissionResolver.compile(graph, inheritance);
        CompiledOverrides o = access == null || noOverrides
                ? CompiledOverrides.NONE
                : CompiledOverrides.of(graph.mode(), access.overrides());
        List<String> direct = access != null ? access.roleIds() : List.of(graph.defaultRoleId());
        List<String> held = new ArrayList<>();
        for (String id : direct) if (!excluded.contains(id)) held.add(id);
        return PermissionResolver.resolve(graph.mode(), o.global(), o.contextual(), held, resolver.roles(),
                permission, context, inheritance);
    }

    // ---- mirror plumbing

    GameMirror mirror(boolean defaultRole) {
        JunjoClient client = JunjoClient.builder().baseUrl("http://127.0.0.1:1").apiKey("k").build();
        clients.add(client);
        return GameMirror.builder(client).defaultRoleForNonMembers(defaultRole).build();
    }

    // Publishes a state holding the graph and the member, as the applier would after loading them.
    static void install(GameMirror mirror, RoleGraph graph, ContextInheritance inheritance, MemberAccess access)
            throws Exception {
        GroupState group = mirror.compileGroup(graph, inheritance);
        State s = State.EMPTY.withContexts(inheritance).withGroup("g", group)
                .withMember(new MemberKey("g", "u"), new MemberEntry(true, access, access == null ? 0 : access.version()))
                .markReady();
        Field f = GameMirror.class.getDeclaredField("state");
        f.setAccessible(true);
        f.set(mirror, s);
    }

    static int memoSize(PermissionResolver.Prepared prepared) throws Exception {
        Field f = PermissionResolver.Prepared.class.getDeclaredField("memo");
        f.setAccessible(true);
        return ((ConcurrentHashMap<?, ?>) f.get(prepared)).size();
    }

    static int planCount(MemberPlans plans) throws Exception {
        Field f = MemberPlans.class.getDeclaredField("byContext");
        f.setAccessible(true);
        return ((ConcurrentHashMap<?, ?>) f.get(plans)).size();
    }

    // ---- random inputs

    static RoleGraph graph(Random rnd) {
        PermissionMode mode = rnd.nextInt(4) == 0 ? PermissionMode.EXACT : PermissionMode.NODES;
        int count = 1 + rnd.nextInt(7);
        List<Role> roles = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            List<String> parents = new ArrayList<>();
            // Mostly earlier roles as parents; now and then a later one, which may close a cycle.
            for (int j = 0; j < count; j++) {
                if (j != i && rnd.nextInt(j < i ? 3 : 12) == 0) parents.add("r" + j);
            }
            if (rnd.nextInt(10) == 0) parents.add("missing");
            List<PermissionEntry> entries = new ArrayList<>();
            int n = rnd.nextInt(8);
            for (int k = 0; k < n; k++) entries.add(new PermissionEntry(key(rnd), rnd.nextBoolean(), entryContext(rnd)));
            roles.add(role("r" + i, rnd.nextInt(4), parents, entries));
        }
        String defaultRoleId = rnd.nextInt(4) == 0 ? null : "r" + rnd.nextInt(count);
        return new RoleGraph("g", mode, defaultRoleId, roles);
    }

    static Role role(String id, long priority, List<String> parents, List<PermissionEntry> entries) {
        return new Role(id, "g", id, priority, null, false, List.of(), entries, parents, Map.of(), Instant.EPOCH);
    }

    static ContextInheritance inheritance(Random rnd) {
        if (rnd.nextInt(3) == 0) return ContextInheritance.NONE;
        ContextInheritance.Builder b = ContextInheritance.builder();
        // Edges only from a later value to earlier ones, so the graph is acyclic.
        for (String key : CONTEXT_KEYS) {
            for (int v = 1; v < CONTEXT_VALUES.length; v++) {
                List<String> parents = new ArrayList<>();
                for (int p = 0; p < v; p++) if (rnd.nextInt(3) == 0) parents.add(CONTEXT_VALUES[p].toLowerCase());
                if (!parents.isEmpty()) b.inherit(key, CONTEXT_VALUES[v].toLowerCase(), parents);
            }
        }
        return b.build();
    }

    static Context entryContext(Random rnd) {
        int r = rnd.nextInt(4);
        if (r < 2) return Context.GLOBAL;
        if (r == 2) return Context.of(CONTEXT_KEYS[rnd.nextInt(2)], CONTEXT_VALUES[rnd.nextInt(CONTEXT_VALUES.length)]);
        return Context.of(CONTEXT_KEYS[0], CONTEXT_VALUES[rnd.nextInt(CONTEXT_VALUES.length)],
                CONTEXT_KEYS[1], CONTEXT_VALUES[rnd.nextInt(CONTEXT_VALUES.length)]);
    }

    static Context context(Random rnd) {
        return rnd.nextInt(3) == 0 ? Context.GLOBAL : entryContext(rnd).isGlobal()
                ? Context.of(CONTEXT_KEYS[rnd.nextInt(2)], CONTEXT_VALUES[rnd.nextInt(CONTEXT_VALUES.length)])
                : entryContext(rnd);
    }

    static String key(Random rnd) {
        if (rnd.nextInt(12) == 0) return "*";
        int depth = 1 + rnd.nextInt(3);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < depth; i++) {
            if (i > 0) sb.append('.');
            boolean last = i == depth - 1;
            sb.append(last && i > 0 && rnd.nextInt(3) == 0 ? "*" : SEGMENTS[rnd.nextInt(SEGMENTS.length)]);
        }
        return sb.toString();
    }

    static String permission(Random rnd) {
        int r = rnd.nextInt(10);
        if (r == 0) return "*";
        if (r == 1) return key(rnd) + ".deep.Er";
        if (r == 2) return "." + key(rnd);
        return key(rnd);
    }

    static List<MemberPermissionOverride> overrides(Random rnd) {
        List<MemberPermissionOverride> out = new ArrayList<>();
        int n = rnd.nextInt(4);
        for (int i = 0; i < n; i++) {
            out.add(new MemberPermissionOverride("g", "u", key(rnd), rnd.nextBoolean(), Instant.EPOCH, null,
                    entryContext(rnd)));
        }
        return out;
    }

    static List<String> heldRoles(Random rnd, RoleGraph graph) {
        List<String> held = new ArrayList<>();
        int n = rnd.nextInt(4);
        for (int i = 0; i < n; i++) held.add("r" + rnd.nextInt(graph.roles().size() + 1));
        return held;
    }

    static MemberAccess access(Random rnd, RoleGraph graph) {
        MemberStatus status = rnd.nextInt(6) == 0 ? MemberStatus.values()[rnd.nextInt(MemberStatus.values().length)]
                : MemberStatus.ACTIVE;
        return new MemberAccess("g", "u", status, heldRoles(rnd, graph), overrides(rnd), 1 + rnd.nextInt(9), null,
                Map.of());
    }
}
