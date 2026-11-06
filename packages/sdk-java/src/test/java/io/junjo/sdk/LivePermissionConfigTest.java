package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.mirror.Answer;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.mirror.MemberChecker;
import io.junjo.sdk.mirror.MirrorChange;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.CreateRoleInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.PermissionConfig;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.model.Role;
import io.junjo.sdk.permissions.ContextInheritance;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * The game's permission config against a real server: the config read, the role graph's
 * inheritance, the live {@code permissions.config.updated} event, and a mirror that follows the
 * server's inheritance with no table from the caller. The tests run in a game of their own,
 * created through the admin routes, because they change its config, mode included.
 */
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_ADMIN_TOKEN", matches = ".+")
@Timeout(120)
class LivePermissionConfigTest {
    static final String RUN = LiveSupport.unique().replace("-", "");
    static final String BASE = "world_" + RUN;
    static final String PVP = "pvpworld_" + RUN;
    static final String ARENA = "arena_" + RUN;
    static final ContextInheritance FROM_BASE = ContextInheritance.builder().inherit("world", PVP, BASE).build();
    static final ContextInheritance FROM_ARENA = ContextInheritance.builder().inherit("world", PVP, ARENA).build();
    static String gameId;
    static String key;
    static String originalMode;

    JunjoClient client;

    static String contextsJson(String parent) {
        return "{\"world\":{\"inherit\":{\"" + PVP + "\":[\"" + parent + "\"]}}}";
    }

    static void patch(String permissions) throws Exception {
        LiveSupport.admin("PATCH", "/v1/admin/games/" + gameId + "/config",
                "{\"config\":{\"permissions\":" + permissions + "}}");
    }

    @BeforeAll
    static void createGame() throws Exception {
        gameId = LiveSupport.admin("POST", "/v1/admin/games", "{\"name\":\"java-config-" + RUN + "\"}")
                .get("id").getAsString();
        key = LiveSupport.admin("POST", "/v1/admin/games/" + gameId + "/api-keys", "{}").get("key").getAsString();
        try (JunjoClient c = LiveSupport.client(key)) {
            originalMode = join(c.permissions().config()).mode().wire();
        }
        patch("{\"contexts\":" + contextsJson(BASE) + "}");
    }

    @BeforeEach
    void setUp() {
        client = LiveSupport.client(key);
    }

    @AfterEach
    void tearDown() {
        client.close();
    }

    Group groupWithMember(String u) throws Exception {
        Group g = LiveSupport.group(client, "guild");
        Role r = join(client.roles().create(g.id(), CreateRoleInput.builder("member-" + RUN, 10).build()));
        join(client.roles().setEntries(r.id(), List.of(
                PermissionEntry.grant("warp.spawn", Context.of("world", BASE)),
                PermissionEntry.grant("essentials.fly", Context.of("world", ARENA)))));
        join(client.members().add(g.id(), u, r.id(), null, WriteOptions.none()));
        return g;
    }

    @Test
    void theConfigAndTheRoleGraphCarryTheInheritance() throws Exception {
        PermissionConfig config = join(client.permissions().config());
        assertEquals(FROM_BASE, config.contexts());
        assertEquals(originalMode, config.mode().wire());
        Group g = LiveSupport.group(client, "guild");
        assertEquals(FROM_BASE, join(client.roles().getGraph(g.id())).value().contexts());
    }

    @Test
    void theStreamCarriesTheConfigEvent() throws Exception {
        List<JunjoEvent.PermissionsConfigUpdated> seen = new CopyOnWriteArrayList<>();
        String from = join(client.events().position());
        GameSubscription sub = join(client.events().subscribe((e, pos) -> {
            if (e instanceof JunjoEvent.PermissionsConfigUpdated c) seen.add(c);
        }, SubscribeOptions.builder().from(from).types(EventType.PERMISSIONS_CONFIG_UPDATED).build()));
        try {
            patch("{\"contexts\":" + contextsJson(ARENA) + "}");
            await(() -> !seen.isEmpty(), "permissions.config.updated");
            assertEquals(FROM_ARENA, seen.get(0).contexts());
            assertEquals(originalMode, seen.get(0).mode().wire());
            assertEquals(gameId, seen.get(0).meta().gameId());
        } finally {
            sub.close();
            patch("{\"contexts\":" + contextsJson(BASE) + "}");
        }
    }

    @Test
    void theMirrorFollowsTheServersInheritanceAndMode() throws Exception {
        String u = LiveSupport.user();
        Group g = groupWithMember(u);
        Context pvp = Context.of("world", PVP);
        List<MirrorChange> changes = new CopyOnWriteArrayList<>();
        List<Throwable> errors = new CopyOnWriteArrayList<>();
        try (GameMirror mirror = GameMirror.builder(client).group(g.id()).onChange(changes::add)
                .onError(errors::add).build()) {
            join(mirror.start());
            join(mirror.track(u, g.id()));
            MemberChecker inPvp = mirror.checker(u, g.id(), pvp);
            assertEquals(FROM_BASE, mirror.contextInheritance());
            assertEquals(Answer.YES, inPvp.can("warp.spawn"));
            assertEquals(Answer.NO, inPvp.can("essentials.fly"));
            assertEquals(join(client.permissions().check(u, g.id(), "warp.spawn", pvp)),
                    mirror.check(u, g.id(), "warp.spawn", pvp).orElseThrow());

            changes.clear();
            patch("{\"contexts\":" + contextsJson(ARENA) + "}");
            await(() -> FROM_ARENA.equals(mirror.contextInheritance()), "the live inheritance");
            assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, null)));
            assertEquals(Answer.NO, inPvp.can("warp.spawn"));
            assertEquals(Answer.YES, inPvp.can("essentials.fly"));
            for (String p : List.of("warp.spawn", "essentials.fly")) {
                assertEquals(join(client.permissions().check(u, g.id(), p, pvp)),
                        mirror.check(u, g.id(), p, pvp).orElseThrow(), p);
            }

            PermissionMode other = "exact".equals(originalMode) ? PermissionMode.NODES : PermissionMode.EXACT;
            patch("{\"mode\":\"" + other.wire() + "\"}");
            await(() -> mirror.roleGraph(g.id()).map(x -> x.mode() == other).orElse(false), "the graph reload");
            assertEquals(FROM_ARENA, mirror.contextInheritance());
            assertEquals(join(client.permissions().check(u, g.id(), "essentials.fly", pvp)),
                    mirror.check(u, g.id(), "essentials.fly", pvp).orElseThrow());
            assertTrue(errors.isEmpty(), errors.toString());
        } finally {
            patch("{\"mode\":\"" + originalMode + "\",\"contexts\":" + contextsJson(BASE) + "}");
        }
    }
}
