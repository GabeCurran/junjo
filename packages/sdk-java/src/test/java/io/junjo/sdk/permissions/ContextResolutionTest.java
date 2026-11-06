package io.junjo.sdk.permissions;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
import io.junjo.sdk.permissions.PermissionResolver.ResolverRole;
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** The context value type, the inheritance table and the resolver's context precedence. */
class ContextResolutionTest {
    static final Context CREATIVE = Context.of("world", "creative");
    static final Context PVP = Context.of("world", "pvpworld");

    static Role role(String id, long priority, List<PermissionEntry> entries, List<String> parents) {
        return new Role(id, "g", id, priority, null, false, List.of(), entries, parents, Map.of(), Instant.EPOCH);
    }

    static MemberAccess member(List<String> roles, List<MemberPermissionOverride> overrides) {
        return new MemberAccess("g", "u", MemberStatus.ACTIVE, roles, overrides, 1, null, null);
    }

    static MemberPermissionOverride override(String permission, boolean grant, Context context) {
        return new MemberPermissionOverride("g", "u", permission, grant, Instant.EPOCH, null, context);
    }

    // ------------------------------------------------------------------ Context

    @Test
    void contextsFoldValuesSortKeysAndCompareByCanonicalKey() {
        Context c = Context.of("world", "World_Nether", "server", "EU");
        assertEquals(List.of("server", "world"), List.copyOf(c.values().keySet()));
        assertEquals("world_nether", c.get("world").orElseThrow());
        assertEquals("[[\"server\",\"eu\"],[\"world\",\"world_nether\"]]", c.canonicalKey());
        assertEquals(c, Context.of(Map.of("server", "eu", "world", "WORLD_NETHER")));
        assertEquals(c.hashCode(), Context.of("server", "eU", "world", "world_nether").hashCode());
        assertEquals("", Context.GLOBAL.canonicalKey());
        assertTrue(Context.of(Map.of()).isGlobal());
        assertEquals("{}", Context.GLOBAL.toString());
        assertEquals(c.canonicalKey(), c.toString());
    }

    @Test
    void foldingIsAsciiOnlyAndLocaleIndependent() {
        Locale saved = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"));
            assertEquals("title", Context.of("world", "TITLE").get("world").orElseThrow());
        } finally {
            Locale.setDefault(saved);
        }
        // KELVIN SIGN and other non-ASCII letters are left as they are.
        assertEquals("\u212Aick", Context.fold("\u212AICK"));
        assertEquals("\u00c9t\u00e9", Context.fold("\u00c9T\u00e9"));
    }

    @Test
    void canonicalKeysEscapeLikeJsonStringify() {
        assertEquals("[[\"world\",\"a\\\"b\\\\c\"]]", Context.of("world", "a\"b\\c").canonicalKey());
        assertEquals("[[\"world\",\"\u00e9 x\"]]", Context.of("world", "\u00e9 X").canonicalKey());
        assertEquals("[[\"world\",\"\\udc00\"]]", Context.fromWire(Map.of("world", "\udc00")).canonicalKey());
        assertEquals("[[\"world\",\"\ud83d\ude00\"]]", Context.of("world", "\ud83d\ude00").canonicalKey());
    }

    @Test
    void writeRulesAreEnforcedAndWithReplacesAKey() {
        assertThrows(IllegalArgumentException.class, () -> Context.of("World", "x"));
        assertThrows(IllegalArgumentException.class, () -> Context.of("world", ""));
        assertThrows(IllegalArgumentException.class, () -> Context.of("world", "a\u0085"));
        assertThrows(IllegalArgumentException.class, () -> Context.of("world", "x".repeat(65)));
        assertThrows(IllegalArgumentException.class, () -> CREATIVE.with("server", "a").with("region", "b"));
        assertEquals(Context.of("world", "hub"), CREATIVE.with("world", "HUB"));
        assertEquals(Context.of("server", "eu", "world", "creative"), CREATIVE.with("server", "eu"));
        assertTrue(Context.problem(Map.of("world", "ok")).isEmpty());
        assertFalse(Context.problem(Map.of("a", "1", "b", "2", "c", "3")).isEmpty());
    }

    @Test
    void wireContextsAreFoldedButNotLimited() {
        Context wide = Context.fromWire(Map.of("a", "X", "b", "y", "c", "z"));
        assertEquals(3, wide.size());
        assertEquals("x", wide.get("a").orElseThrow());
        assertEquals(Context.GLOBAL, Context.fromWire(null));
    }

    // ------------------------------------------------------------------ inheritance

    @Test
    void chainsAreShortestDistancesThroughFoldedParents() {
        ContextInheritance inh = ContextInheritance.builder()
                .inherit("world", "Cave_World_Nether", "World_Nether")
                .inherit("world", "world_nether", "WORLD")
                .inherit("world", "a", "b", "c")
                .inherit("world", "b", "d")
                .inherit("world", "c", "d", "B")
                .build();
        assertEquals(Map.of("cave_world_nether", 0, "world_nether", 1, "world", 2),
                inh.chain("world", "CAVE_world_nether"));
        assertEquals(Map.of("a", 0, "b", 1, "c", 1, "d", 2), inh.chain("world", "a"));
        assertEquals(Map.of("x", 0), inh.chain("world", "X"), "a value without parents is its own chain");
        assertEquals(Map.of("a", 0), inh.chain("server", "a"), "a key without inheritance");
        assertEquals(List.of("d", "b"), inh.inherit().get("world").get("c"));
        assertEquals(inh, ContextInheritance.of(inh.inherit()));
    }

    @Test
    void inheritanceRefusesWhatTheServerRefuses() {
        assertThrows(IllegalArgumentException.class,
                () -> ContextInheritance.builder().inherit("world", "a", "b").inherit("world", "b", "A").build());
        assertThrows(IllegalArgumentException.class,
                () -> ContextInheritance.builder().inherit("world", "A", "x").inherit("world", "a", "y").build());
        assertThrows(IllegalArgumentException.class,
                () -> ContextInheritance.builder().inherit("World", "a", "b").build());
        assertTrue(ContextInheritance.problem(Map.of("world", Map.of("a", List.of("a")))).isPresent());
        assertTrue(ContextInheritance.of(Map.of()).isEmpty());
    }

    // ------------------------------------------------------------------ precedence

    @Test
    void contextRanksAboveKeySpecificityInsideALayer() {
        RoleGraph g = new RoleGraph("g", PermissionMode.NODES, null, List.of(role("admin", 10, List.of(
                PermissionEntry.deny("essentials.fly"),
                PermissionEntry.grant("essentials.*", CREATIVE)), List.of())));
        PermissionResolver.GroupResolver r = PermissionResolver.compile(g);
        MemberAccess m = member(List.of("admin"), List.of());
        PermissionCheckResult inCreative = r.check(m, "essentials.fly", CREATIVE);
        assertTrue(inCreative.allowed());
        assertEquals(CREATIVE, inCreative.context());
        assertEquals("admin", inCreative.viaRoleId());
        assertFalse(r.check(m, "essentials.fly", Context.of("world", "survival")).allowed());
        PermissionCheckResult global = r.check(m, "essentials.fly");
        assertFalse(global.allowed());
        assertEquals(Context.GLOBAL, global.context());
    }

    @Test
    void layerStillComesFirst() {
        RoleGraph g = new RoleGraph("g", PermissionMode.NODES, null, List.of(
                role("member", 5, List.of(PermissionEntry.grant("warp")), List.of("default")),
                role("default", 1, List.of(PermissionEntry.deny("warp", PVP)), List.of())));
        PermissionResolver.GroupResolver r = PermissionResolver.compile(g);
        PermissionCheckResult res = r.check(member(List.of("member"), List.of()), "warp", PVP);
        assertTrue(res.allowed(), "the nearer role's global grant decides before the parent's world deny");
        assertEquals("member", res.viaRoleId());

        PermissionCheckResult own = r.check(
                member(List.of("default"), List.of(override("warp", true, Context.GLOBAL))), "warp", PVP);
        assertEquals(PermissionSource.OVERRIDE, own.source());
        assertTrue(own.allowed());
    }

    @Test
    void moreKeysThenNearerValuesWinAndTiesReportTheSmallestCanonicalKey() {
        ContextInheritance inh = ContextInheritance.builder().inherit("world", "pvpworld", "world").build();
        Context both = Context.of("server", "eu", "world", "pvpworld");
        RoleGraph g = new RoleGraph("g", PermissionMode.EXACT, null, List.of(role("r", 1, List.of(
                PermissionEntry.deny("kit", Context.of("world", "pvpworld")),
                PermissionEntry.grant("kit", Context.of("server", "eu", "world", "world")),
                PermissionEntry.grant("tp", Context.of("world", "world")),
                PermissionEntry.deny("tp", Context.of("world", "pvpworld")),
                PermissionEntry.grant("home", Context.of("world", "pvpworld")),
                PermissionEntry.grant("home", Context.of("server", "eu"))), List.of())));
        PermissionResolver.GroupResolver r = PermissionResolver.compile(g, inh);
        MemberAccess m = member(List.of("r"), List.of());

        PermissionCheckResult kit = r.check(m, "kit", both);
        assertTrue(kit.allowed(), "two matched keys beat one, even at a larger distance");
        assertEquals(Context.of("server", "eu", "world", "world"), kit.context());

        PermissionCheckResult tp = r.check(m, "tp", PVP);
        assertFalse(tp.allowed(), "the world's own entry beats the inherited one");
        assertEquals(PVP, tp.context());
        assertTrue(r.check(m, "tp", Context.of("world", "world")).allowed());

        PermissionCheckResult home = r.check(m, "home", both);
        assertTrue(home.allowed());
        assertEquals(Context.of("server", "eu"), home.context(), "equal scores report the smallest canonical key");

        assertEquals(PermissionSource.DEFAULT, r.check(m, "kit").source(), "no context sees no contextual entry");
        PermissionResolver.GroupResolver flat = PermissionResolver.compile(g);
        PermissionCheckResult flatTp = flat.check(m, "tp", PVP);
        assertFalse(flatTp.allowed(), "without inheritance only pvpworld's own entry applies");
        assertEquals(PVP, flatTp.context());
        PermissionCheckResult flatKit = flat.check(m, "kit", Context.of("world", "pvpworld", "server", "x"));
        assertFalse(flatKit.allowed(), "an entry for a value the check did not send is ignored");
        assertEquals(PVP, flatKit.context());
    }

    @Test
    void contextualOverridesFoldAndDenyWinsTies() {
        RoleGraph g = new RoleGraph("g", PermissionMode.NODES, null, List.of(role("r", 1,
                List.of(PermissionEntry.grant("chat.*")), List.of())));
        PermissionResolver.GroupResolver r = PermissionResolver.compile(g);
        MemberAccess m = member(List.of("r"), List.of(
                override("Chat.Color", false, Context.of("world", "HUB")),
                override("chat.color", true, Context.of("server", "eu")),
                override("chat.color", true, Context.GLOBAL)));
        PermissionCheckResult hub = r.check(m, "CHAT.color", Context.of("world", "hub", "server", "eu"));
        assertEquals(PermissionSource.OVERRIDE, hub.source());
        assertFalse(hub.allowed(), "deny wins between equally contextual overrides");
        assertEquals(Context.of("world", "hub"), hub.context());
        PermissionCheckResult elsewhere = r.check(m, "chat.color", Context.of("world", "spawn"));
        assertTrue(elsewhere.allowed());
        assertEquals(Context.GLOBAL, elsewhere.context());
    }

    @Test
    void precomputedChainsGiveTheSameAnswers() {
        ContextInheritance inh = ContextInheritance.builder().inherit("world", "pvpworld", "world").build();
        Map<String, ResolverRole> roles = Map.of("r", new ResolverRole(1, Map.of("a", false),
                List.of(new PermissionEntry("a", true, Context.of("world", "world"))), List.of()));
        for (Context c : List.of(Context.GLOBAL, PVP, Context.of("world", "world"), CREATIVE)) {
            PermissionCheckResult direct = PermissionResolver.resolve(
                    PermissionMode.EXACT, Map.of(), List.of(), List.of("r"), roles, "a", c, inh);
            PermissionCheckResult chained = PermissionResolver.resolve(
                    PermissionMode.EXACT, Map.of(), List.of(), List.of("r"), roles, "a", inh.chains(c));
            assertEquals(direct, chained, c.toString());
        }
        assertTrue(PermissionResolver.resolve(PermissionMode.EXACT, Map.of(), List.of(), List.of("r"), roles, "a",
                PVP, inh).allowed());
        PermissionCheckResult flat = PermissionResolver.resolve(
                PermissionMode.EXACT, Map.of(), List.of(), List.of("r"), roles, "a", PVP, ContextInheritance.NONE);
        assertFalse(flat.allowed());
        assertEquals(PermissionSource.ROLE, flat.source());
    }
}
