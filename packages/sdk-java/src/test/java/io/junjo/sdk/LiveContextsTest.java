package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.mirror.Answer;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.mirror.MemberChecker;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.PermissionCheckRequest;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.permissions.ContextInheritance;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Contextual permissions against a real server: the server's {@code /v1/permissions/check}
 * answers, and the mirror's local answers for the same checks, must agree. The game's context
 * inheritance is set through the admin config route and handed to the mirror as the same table.
 * Every key and world name is unique to the run, and every scenario holds in either permission
 * mode.
 */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_ADMIN_TOKEN", matches = ".+")
@Timeout(120)
class LiveContextsTest {
    static final String RUN = LiveSupport.unique().replace("-", "");
    static final String BASE = "world_" + RUN;
    static final String NETHER = "world_nether_" + RUN;
    static final String CAVE = "Cave_World_Nether_" + RUN;
    static final String PVP = "PvPWorld_" + RUN;
    static final ContextInheritance WORLDS = ContextInheritance.builder()
            .inherit("world", PVP, BASE)
            .inherit("world", NETHER, BASE)
            .inherit("world", CAVE, NETHER)
            .build();
    static String gameId;

    JunjoClient client;

    static Context world(String name) {
        return Context.of("world", name);
    }

    @BeforeAll
    static void setInheritance() throws Exception {
        try (JunjoClient c = LiveSupport.client()) {
            gameId = LiveSupport.gameId(c);
        }
        LiveSupport.admin("PATCH", "/v1/admin/games/" + gameId + "/config", """
                {"config":{"permissions":{"contexts":{"world":{"inherit":{
                  "%s":["%s"],"%s":["%s"],"%s":["%s"]}}}}}}"""
                .formatted(PVP, BASE, NETHER, BASE, CAVE, NETHER));
        String stored = LiveSupport.admin("GET", "/v1/admin/games/" + gameId + "/config", null)
                .getAsJsonObject("config").getAsJsonObject("permissions").getAsJsonObject("contexts").toString();
        assertTrue(stored.contains(CAVE.toLowerCase(Locale.ROOT)), "the server stores folded values: " + stored);
    }

    @AfterAll
    static void clearInheritance() throws Exception {
        if (gameId != null) {
            LiveSupport.admin("PATCH", "/v1/admin/games/" + gameId + "/config",
                    "{\"config\":{\"permissions\":{\"contexts\":{}}}}");
        }
    }

    @BeforeEach
    void setUp() {
        client = LiveSupport.client();
    }

    @AfterEach
    void tearDown() {
        client.close();
    }

    Role role(Group g, String name, long priority, PermissionEntry... entries) throws Exception {
        Role r = join(client.roles().create(g.id(), CreateRoleInput.builder(name + "-" + RUN, priority).build()));
        return join(client.roles().setEntries(r.id(), List.of(entries)));
    }

    GameMirror mirror(Group g, List<Throwable> errors) throws Exception {
        GameMirror m = GameMirror.builder(client).group(g.id()).contextInheritance(WORLDS).onError(errors::add).build();
        join(m.start());
        return m;
    }

    // Checks every permission in every context on the server, one at a time and in one batch, and
    // compares each answer with the mirror's and with the checker bound to that context.
    void assertMatchesServer(GameMirror mirror, Group g, String u, List<String> perms, List<Context> contexts)
            throws Exception {
        List<PermissionCheckRequest> batch = new ArrayList<>();
        List<PermissionCheckResult> singles = new ArrayList<>();
        for (Context c : contexts) {
            MemberChecker checker = mirror.checker(u, g.id(), c);
            for (String p : perms) {
                PermissionCheckResult server = join(client.permissions().check(u, g.id(), p, c));
                PermissionCheckResult local = mirror.check(u, g.id(), p, c).orElseThrow();
                String label = p + " in " + c;
                assertEquals(server, local, label);
                assertEquals(server, checker.check(p).orElseThrow(), label + " (checker)");
                batch.add(new PermissionCheckRequest(u, g.id(), p, c));
                singles.add(server);
            }
        }
        assertEquals(singles, join(client.permissions().checkBatch(batch)), "the batch answers like single checks");
    }

    @Test
    void aPerWorldGrantBeatsAGlobalDenyAndOverridesFollowTheirWorld() throws Exception {
        Context creative = world("Creative_" + RUN);
        Context hub = world("hub_" + RUN);
        Group g = LiveSupport.group(client, "it");
        Role admin = role(g, "Admin", 50,
                PermissionEntry.deny("ess.fly"),
                PermissionEntry.grant("ess.fly", creative),
                PermissionEntry.grant("ess.*", creative),
                PermissionEntry.grant("ess.home"),
                PermissionEntry.deny("ess.home", hub));
        assertEquals(List.of("ess.home"), admin.permissions(), "the granted-keys list names global grants only");
        String u = LiveSupport.user();
        join(client.members().add(g.id(), u, admin.id(), null, WriteOptions.none()));
        List<String> perms = List.of("ess.fly", "ess.home", "ess.other");
        List<Context> contexts = List.of(Context.GLOBAL, creative, hub, world("survival_" + RUN));
        List<Throwable> errors = new CopyOnWriteArrayList<>();

        try (GameMirror mirror = mirror(g, errors)) {
            join(mirror.track(u, g.id()));
            assertMatchesServer(mirror, g, u, perms, contexts);
            PermissionCheckResult fly = mirror.check(u, g.id(), "ess.fly", creative).orElseThrow();
            assertTrue(fly.allowed());
            assertEquals(creative, fly.context());
            assertEquals(Answer.NO, mirror.can(u, g.id(), "ess.fly"));
            assertEquals(Answer.NO, mirror.can(u, g.id(), "ess.home", hub));
            assertEquals(Answer.YES, mirror.can(u, g.id(), "ess.home", creative));

            join(client.members().overridePermission(g.id(), u, "ess.fly", false, creative));
            await(() -> mirror.can(u, g.id(), "ess.fly", creative) == Answer.NO, "the per-world override");
            assertEquals(PermissionSource.OVERRIDE, mirror.check(u, g.id(), "ess.fly", creative).orElseThrow().source());
            assertMatchesServer(mirror, g, u, perms, contexts);

            join(client.members().clearPermissionOverride(g.id(), u, "ess.fly", creative));
            await(() -> mirror.can(u, g.id(), "ess.fly", creative) == Answer.YES, "the cleared override");
            assertMatchesServer(mirror, g, u, perms, contexts);

            join(client.roles().revokePermission(admin.id(), "ess.fly", creative));
            await(() -> mirror.role(g.id(), admin.id()).orElseThrow().entries().size() == 4, "the revoke");
            assertMatchesServer(mirror, g, u, perms, contexts);
            assertEquals(Answer.NO, mirror.can(u, g.id(), "ess.home", hub), "other contexts are untouched");
        }
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void inheritanceRanksTheNearestWorldFirstAndLayerStillComesFirst() throws Exception {
        Group g = LiveSupport.group(client, "it");
        Role base = role(g, "Default", 10,
                PermissionEntry.grant("warp.spawn", world(BASE)),
                PermissionEntry.deny("warp.spawn", world(PVP)),
                PermissionEntry.grant("kit.daily", world(NETHER)),
                PermissionEntry.deny("kit.daily", world(BASE)),
                PermissionEntry.deny("ess.warp", world(PVP)));
        Role member = role(g, "Member", 20, PermissionEntry.grant("ess.warp"));
        join(client.roles().setParents(member.id(), List.of(base.id())));
        String u = LiveSupport.user();
        join(client.members().add(g.id(), u, member.id(), null, WriteOptions.none()));
        List<String> perms = List.of("warp.spawn", "kit.daily", "ess.warp", "warp.home");
        List<Context> contexts = List.of(Context.GLOBAL, world(BASE), world(PVP), world(NETHER), world(CAVE),
                world(CAVE.toUpperCase(Locale.ROOT)));
        List<Throwable> errors = new CopyOnWriteArrayList<>();

        try (GameMirror mirror = mirror(g, errors)) {
            join(mirror.track(u, g.id()));
            assertMatchesServer(mirror, g, u, perms, contexts);
            assertEquals(Answer.NO, mirror.can(u, g.id(), "warp.spawn", world(PVP)), "a world's own entry first");
            PermissionCheckResult spawn = mirror.check(u, g.id(), "warp.spawn", world(CAVE)).orElseThrow();
            assertTrue(spawn.allowed(), "two steps up the chain");
            assertEquals(world(BASE), spawn.context());
            PermissionCheckResult kit = mirror.check(u, g.id(), "kit.daily", world(CAVE)).orElseThrow();
            assertTrue(kit.allowed(), "the nearer inherited world wins");
            assertEquals(world(NETHER), kit.context());
            PermissionCheckResult warp = mirror.check(u, g.id(), "ess.warp", world(PVP)).orElseThrow();
            assertTrue(warp.allowed(), "the child role's global grant decides before the parent's world deny");
            assertEquals(member.id(), warp.viaRoleId());
        }
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void aCheckerBoundToAWorldFollowsContextualChanges() throws Exception {
        Group g = LiveSupport.group(client, "it");
        Role r = role(g, "Player", 10, PermissionEntry.grant("chat"), PermissionEntry.grant("build", world(BASE)));
        String u = LiveSupport.user();
        join(client.members().add(g.id(), u, r.id(), null, WriteOptions.none()));
        List<String> perms = List.of("chat", "build", "fly");
        List<Throwable> errors = new CopyOnWriteArrayList<>();

        try (GameMirror mirror = mirror(g, errors)) {
            join(mirror.track(u, g.id()));
            MemberChecker inPvp = mirror.checker(u, g.id(), world(PVP));
            assertEquals(Answer.YES, inPvp.can("build"), "pvpworld inherits the base world's grant");
            assertEquals(Answer.NO, inPvp.can("fly"));
            assertMatchesServer(mirror, g, u, perms, List.of(world(PVP), world(BASE), Context.GLOBAL));

            join(client.roles().grantPermission(r.id(), "fly", true, world(BASE)));
            await(() -> inPvp.can("fly") == Answer.YES, "the inherited contextual grant");
            join(client.roles().grantPermission(r.id(), "fly", false, world(PVP)));
            await(() -> inPvp.can("fly") == Answer.NO, "the world's own deny");
            assertEquals(Answer.YES, mirror.checker(u, g.id(), world(BASE)).can("fly"));
            assertMatchesServer(mirror, g, u, perms, List.of(world(PVP), world(BASE), Context.GLOBAL));

            join(client.members().overridePermission(g.id(), u, "chat", false, world(PVP)));
            await(() -> inPvp.can("chat") == Answer.NO, "the per-world override");
            assertEquals(Answer.YES, mirror.checker(u, g.id(), world(BASE)).can("chat"));
            assertFalse(inPvp.grantedKeys().orElseThrow().contains("chat"));
            assertTrue(inPvp.grantedKeys().orElseThrow().contains("build"));
            assertMatchesServer(mirror, g, u, perms, List.of(world(PVP), world(BASE), Context.GLOBAL));
        }
        assertTrue(errors.isEmpty(), errors.toString());
    }
}
