package io.junjo.sdk.mirror;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.permissions.ContextInheritance;
import java.io.OutputStream;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/** The mirror's contextual checks: per-context answers, bound checkers, inheritance and reloads. */
@Timeout(30)
class MirrorContextsTest {
    static final Context CREATIVE = Context.of("world", "creative");
    static final Context PVP = Context.of("world", "PvPWorld");
    static final Context WORLD = Context.of("world", "world");
    static final ContextInheritance WORLDS = ContextInheritance.builder().inherit("world", "pvpworld", "world").build();

    @TempDir
    Path dir;

    FakeServer server;
    JunjoClient client;
    GameMirror mirror;
    final CountDownLatch hold = new CountDownLatch(1);
    final LinkedBlockingQueue<String> frames = new LinkedBlockingQueue<>();
    final List<Throwable> errors = new CopyOnWriteArrayList<>();
    final List<MirrorChange> changes = new CopyOnWriteArrayList<>();
    final AtomicReference<String> entries = new AtomicReference<>(String.join(",",
            "{\"permission\":\"essentials.fly\",\"value\":false}",
            "{\"permission\":\"essentials.*\",\"value\":true,\"context\":{\"world\":\"creative\"}}",
            "{\"permission\":\"warp.spawn\",\"value\":true,\"context\":{\"world\":\"world\"}}",
            "{\"permission\":\"warp.*\",\"value\":false,\"context\":{\"world\":\"pvpworld\"}}"));
    final AtomicReference<String> overrides = new AtomicReference<>(
            "{\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"permission\":\"chat.color\",\"grant\":false,"
                    + "\"context\":{\"world\":\"creative\"},\"setAt\":\"2026-11-01T00:00:00Z\",\"setBy\":null}");
    final AtomicReference<Long> version = new AtomicReference<>(5L);

    String graph() {
        return """
                {"groupId":"g1","mode":"nodes","defaultRoleId":"member","roles":[
                 {"id":"member","groupId":"g1","name":"Member","priority":10,"color":null,"isDefault":true,
                  "permissions":["chat.color"],"entries":[{"permission":"chat.color","value":true},%s],
                  "parents":[],"metadata":{},"createdAt":"2026-11-01T00:00:00Z"}]}"""
                .formatted(entries.get());
    }

    String access() {
        return """
                {"groupId":"g1","userId":"ns:u1","status":"active","roleIds":["member"],"overrides":[%s],
                 "version":%d}""".formatted(overrides.get(), version.get());
    }

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        server.on("GET", "/v1/events/position", (req, ex) -> FakeServer.json(ex, 200, "{\"position\":\"10\"}"));
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph()));
        server.on("GET", "/v1/bans", (req, ex) -> FakeServer.json(ex, 200, "{\"items\":[],\"nextCursor\":null}"));
        server.on("GET", "/v1/sanctions", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[],\"nextCursor\":null}"));
        server.onPrefix("GET", "/v1/users/", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[]}", Map.of("ETag", "\"0\"")));
        server.on("GET", "/v1/groups/g1/members/ns%3Au1/access", (req, ex) -> FakeServer.json(ex, 200, access()));
        server.on("POST", "/v1/groups/g1/members/access", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[" + access() + "]}"));
        server.on("GET", "/v1/events", (req, ex) -> {
            String last = req.header("Last-Event-ID");
            OutputStream out = FakeServer.openSse(ex, last == null ? "50" : last);
            while (hold.getCount() > 0) {
                String f = frames.poll(50, TimeUnit.MILLISECONDS);
                if (f != null) FakeServer.write(out, f);
            }
        });
        client = TestSupport.client(server.baseUrl());
        mirror = builder().build();
    }

    GameMirror.Builder builder() {
        return GameMirror.builder(client)
                .group("g1")
                .contextInheritance(WORLDS)
                .retryBackoff(Duration.ofMillis(20), Duration.ofMillis(100))
                .streamOptions(SubscribeOptions.builder().backoff(Duration.ofMillis(10), Duration.ofMillis(30)))
                .onError(errors::add)
                .onChange(changes::add);
    }

    @AfterEach
    void tearDown() {
        hold.countDown();
        mirror.close();
        client.close();
        server.close();
    }

    void push(String type, String position, String fields) {
        frames.add("event: " + type + "\ndata: {\"id\":\"e" + position + "\",\"type\":\"" + type + "\","
                + "\"gameId\":\"gm\",\"occurredAt\":\"2026-11-06T12:00:00.000Z\"," + fields + "}\nid: " + position
                + "\n\n");
    }

    void start() throws Exception {
        join(mirror.start());
        join(mirror.track("ns:u1", "g1"));
    }

    @Test
    void checksAnswerPerContextAndReportTheDecidingContext() throws Exception {
        start();
        PermissionCheckResult fly = mirror.check("ns:u1", "g1", "essentials.fly", CREATIVE).orElseThrow();
        assertTrue(fly.allowed());
        assertEquals(CREATIVE, fly.context());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "essentials.fly", Context.of("world", "survival")));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "essentials.fly"), "no context is global only");
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "essentials.home", Context.of("world", "Creative")),
                "values fold");

        PermissionCheckResult chat = mirror.check("ns:u1", "g1", "chat.color", CREATIVE).orElseThrow();
        assertEquals(PermissionSource.OVERRIDE, chat.source(), "a contextual override beats every role entry");
        assertFalse(chat.allowed());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "chat.color"));
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void inheritanceRanksAWorldsOwnEntriesFirstAndCanBeReplaced() throws Exception {
        start();
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP), "pvpworld's own deny beats world's");
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", WORLD));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.home", PVP));
        assertEquals(WORLDS, mirror.contextInheritance());

        entries.set("{\"permission\":\"warp.spawn\",\"value\":true,\"context\":{\"world\":\"world\"}}");
        push("role.updated", "11", "\"groupId\":\"g1\",\"roleId\":\"member\",\"changed\":[\"entries\"]");
        await(() -> "11".equals(mirror.position()), "the reload");
        PermissionCheckResult inherited = mirror.check("ns:u1", "g1", "warp.spawn", PVP).orElseThrow();
        assertTrue(inherited.allowed(), "pvpworld inherits world's entry");
        assertEquals(WORLD, inherited.context());

        changes.clear();
        join(mirror.setContextInheritance(ContextInheritance.NONE));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP), "without inheritance it no longer applies");
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, null)));
    }

    @Test
    void aBoundCheckerAgreesWithTheMirrorAndFollowsReloads() throws Exception {
        start();
        MemberChecker inCreative = mirror.checker("ns:u1", "g1", CREATIVE);
        assertEquals(CREATIVE, inCreative.context());
        assertEquals(Context.GLOBAL, mirror.checker("ns:u1", "g1").context());
        for (Context c : List.of(Context.GLOBAL, CREATIVE, PVP, WORLD)) {
            MemberChecker checker = mirror.checker("ns:u1", "g1", c);
            for (String p : List.of("essentials.fly", "essentials.home", "chat.color", "warp.spawn", "warp.home", "x")) {
                assertEquals(mirror.check("ns:u1", "g1", p, c), checker.check(p), p + " in " + c);
            }
        }
        assertEquals(Set.of("essentials.*", "essentials.fly"), inCreative.grantedKeys().orElseThrow(),
                "the per-world wildcard grants the globally denied key there");
        assertEquals(Set.of("chat.color", "warp.spawn"), mirror.checker("ns:u1", "g1", WORLD).grantedKeys()
                .orElseThrow());

        overrides.set("");
        version.set(6L);
        push("member.updated", "11", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"changed\":[\"overrides\"],"
                + "\"memberVersion\":6");
        await(() -> inCreative.can("chat.color") == Answer.YES, "the override reload");
        assertEquals(Set.of("chat.color", "essentials.*", "essentials.fly"), inCreative.grantedKeys().orElseThrow());
    }

    @Test
    void nonMembersOnTheDefaultRoleAreCheckedInTheContext() throws Exception {
        mirror.close();
        server.on("GET", "/v1/groups/g1/members/ns%3Aghost/access", (req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no member")));
        server.on("POST", "/v1/groups/g1/members/access", (req, ex) -> FakeServer.json(ex, 200, "{\"items\":[null]}"));
        mirror = builder().defaultRoleForNonMembers(true).build();
        join(mirror.start());
        join(mirror.track("ns:ghost", "g1"));
        assertEquals(Answer.YES, mirror.can("ns:ghost", "g1", "essentials.fly", CREATIVE));
        assertEquals(Answer.NO, mirror.can("ns:ghost", "g1", "essentials.fly"));
        assertEquals(Answer.YES, mirror.checker("ns:ghost", "g1", CREATIVE).can("essentials.fly"));
        assertEquals(Answer.NO, mirror.checker("ns:ghost", "g1").can("essentials.fly"));
    }

    @Test
    void theSnapshotFileKeepsContexts() throws Exception {
        Path file = dir.resolve("mirror.snapshot");
        mirror.close();
        mirror = builder().snapshotFile(file).build();
        start();
        mirror.close();

        server.on("GET", "/v1/events/position", (req, ex) ->
                FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down")));
        mirror = builder().snapshotFile(file).build();
        join(mirror.start());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "essentials.fly", CREATIVE));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "chat.color", CREATIVE));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertEquals(Context.of("world", "creative"),
                mirror.access("ns:u1", "g1").orElseThrow().overrides().get(0).context());
    }
}
