package io.junjo.sdk.mirror;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.model.Context;
import io.junjo.sdk.model.PermissionMode;
import io.junjo.sdk.permissions.ContextInheritance;
import java.io.OutputStream;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/** The context inheritance the mirror takes from the server: graphs, the live event, overrides, snapshots. */
@Timeout(30)
class MirrorServerContextsTest {
    static final Context PVP = Context.of("world", "pvpworld");
    static final ContextInheritance WORLDS = ContextInheritance.builder().inherit("world", "pvpworld", "world").build();
    static final ContextInheritance CREATIVE_PARENT =
            ContextInheritance.builder().inherit("world", "pvpworld", "creative").build();
    static final String WORLDS_JSON = "{\"world\":{\"inherit\":{\"pvpworld\":[\"world\"]}}}";
    static final String CREATIVE_JSON = "{\"world\":{\"inherit\":{\"pvpworld\":[\"creative\"]}}}";
    static final MirrorChange EVERY_GRAPH = new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, null);

    @TempDir
    Path dir;

    FakeServer server;
    JunjoClient client;
    GameMirror mirror;
    final CountDownLatch hold = new CountDownLatch(1);
    final LinkedBlockingQueue<String> frames = new LinkedBlockingQueue<>();
    final List<Throwable> errors = new CopyOnWriteArrayList<>();
    final List<MirrorChange> changes = new CopyOnWriteArrayList<>();
    final AtomicInteger graphLoads = new AtomicInteger();
    // The graph's contexts field as JSON, or null to leave it out as an older server does.
    final AtomicReference<String> contexts = new AtomicReference<>(WORLDS_JSON);
    final AtomicReference<String> mode = new AtomicReference<>("nodes");

    String graph() {
        String c = contexts.get();
        return """
                {"groupId":"g1","mode":"%s","defaultRoleId":"member","roles":[
                 {"id":"member","groupId":"g1","name":"Member","priority":10,"color":null,"isDefault":true,
                  "permissions":[],"entries":[
                   {"permission":"warp.spawn","value":true,"context":{"world":"world"}},
                   {"permission":"essentials.fly","value":true,"context":{"world":"creative"}}],
                  "parents":[],"metadata":{},"createdAt":"2026-11-01T00:00:00Z"}]%s}"""
                .formatted(mode.get(), c == null ? "" : ",\"contexts\":" + c);
    }

    static String access() {
        return """
                {"groupId":"g1","userId":"ns:u1","status":"active","roleIds":["member"],"overrides":[],"version":5}""";
    }

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        server.on("GET", "/v1/events/position", (req, ex) -> FakeServer.json(ex, 200, "{\"position\":\"10\"}"));
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> {
            graphLoads.incrementAndGet();
            FakeServer.json(ex, 200, graph());
        });
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

    void pushConfig(String position, String modeWire, String contextsJson) throws InterruptedException {
        push("permissions.config.updated", position, "\"mode\":\"" + modeWire + "\",\"contexts\":" + contextsJson);
        await(() -> position.equals(mirror.position()), "event " + position);
    }

    void start() throws Exception {
        join(mirror.start());
        join(mirror.track("ns:u1", "g1"));
    }

    @Test
    void theStreamIsFilteredToTheConfigEvent() {
        assertTrue(GameMirror.EVENT_TYPES.contains(EventType.PERMISSIONS_CONFIG_UPDATED));
    }

    @Test
    void theGraphsInheritanceAppliesWithoutATableFromTheCaller() throws Exception {
        start();
        assertEquals(WORLDS, mirror.contextInheritance());
        assertEquals(WORLDS, mirror.serverContextInheritance());
        assertEquals(WORLDS, mirror.roleGraph("g1").orElseThrow().contexts());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", PVP), "pvpworld inherits world's entry");
        assertEquals(Answer.YES, mirror.checker("ns:u1", "g1", PVP).can("warp.spawn"));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "essentials.fly", PVP));
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void theLiveEventReplacesTheInheritanceWithoutAReload() throws Exception {
        start();
        MemberChecker inPvp = mirror.checker("ns:u1", "g1", PVP);
        assertEquals(Answer.YES, inPvp.can("warp.spawn"));
        int loads = graphLoads.get();
        changes.clear();

        pushConfig("11", "nodes", CREATIVE_JSON);
        assertEquals(CREATIVE_PARENT, mirror.contextInheritance());
        assertEquals(CREATIVE_PARENT, mirror.serverContextInheritance());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "essentials.fly", PVP));
        assertEquals(Answer.NO, inPvp.can("warp.spawn"), "a checker taken before follows the change");
        assertEquals(Answer.YES, inPvp.can("essentials.fly"));
        assertEquals(List.of(EVERY_GRAPH), changes, "one change for every graph, with null ids");
        assertEquals(loads, graphLoads.get(), "the same mode needs no reload");

        changes.clear();
        pushConfig("12", "nodes", CREATIVE_JSON);
        assertEquals(List.of(), changes, "an unchanged inheritance reports nothing");

        pushConfig("13", "nodes", "{}");
        assertEquals(ContextInheritance.NONE, mirror.contextInheritance());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "essentials.fly", PVP));
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void aModeChangeReloadsTheHeldGraphs() throws Exception {
        start();
        int loads = graphLoads.get();
        mode.set("exact");
        pushConfig("11", "exact", WORLDS_JSON);
        assertEquals(loads + 1, graphLoads.get());
        assertEquals(PermissionMode.EXACT, mirror.roleGraph("g1").orElseThrow().mode());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, "g1")));
    }

    @Test
    void theNewestGraphLoadWinsOverAnEarlierEvent() throws Exception {
        start();
        pushConfig("11", "nodes", "{}");
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));

        changes.clear();
        push("role.updated", "12", "\"groupId\":\"g1\",\"roleId\":\"member\",\"changed\":[\"entries\"]");
        await(() -> "12".equals(mirror.position()), "the reload");
        assertEquals(WORLDS, mirror.contextInheritance(), "the reloaded graph carries the server's current value");
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertTrue(changes.contains(EVERY_GRAPH));
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, "g1")));
    }

    @Test
    void anExplicitOverrideWinsOverTheServer() throws Exception {
        mirror.close();
        mirror = builder().contextInheritance(ContextInheritance.NONE).build();
        start();
        assertEquals(ContextInheritance.NONE, mirror.contextInheritance());
        assertEquals(WORLDS, mirror.serverContextInheritance());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));

        changes.clear();
        pushConfig("11", "nodes", CREATIVE_JSON);
        assertEquals(CREATIVE_PARENT, mirror.serverContextInheritance(), "the server value is still recorded");
        assertEquals(ContextInheritance.NONE, mirror.contextInheritance());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "essentials.fly", PVP));
        assertFalse(changes.contains(EVERY_GRAPH), "what checks resolve with did not change");

        join(mirror.setContextInheritance(WORLDS));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "essentials.fly", PVP));

        changes.clear();
        join(mirror.setContextInheritance(null));
        assertEquals(CREATIVE_PARENT, mirror.contextInheritance(), "without the override the server's applies");
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "essentials.fly", PVP));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertEquals(List.of(EVERY_GRAPH), changes);
    }

    @Test
    void anOlderServerWithoutContextsHasNoneUnlessOverridden() throws Exception {
        contexts.set(null);
        start();
        assertEquals(ContextInheritance.NONE, mirror.contextInheritance());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));

        mirror.close();
        mirror = builder().contextInheritance(WORLDS).build();
        start();
        assertEquals(WORLDS, mirror.contextInheritance());
        assertEquals(ContextInheritance.NONE, mirror.serverContextInheritance());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void theSnapshotFileKeepsTheServerValue() throws Exception {
        Path file = dir.resolve("mirror.snapshot");
        mirror.close();
        mirror = builder().snapshotFile(file).build();
        start();
        pushConfig("11", "nodes", CREATIVE_JSON);
        mirror.close();

        server.on("GET", "/v1/events/position", (req, ex) ->
                FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down")));
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) ->
                FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down")));
        mirror = builder().snapshotFile(file).build();
        join(mirror.start());
        assertEquals(CREATIVE_PARENT, mirror.contextInheritance());
        assertEquals(CREATIVE_PARENT, mirror.serverContextInheritance());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "essentials.fly", PVP));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "warp.spawn", PVP));

        mirror.close();
        mirror = builder().snapshotFile(file).contextInheritance(WORLDS).build();
        join(mirror.start());
        assertEquals(WORLDS, mirror.contextInheritance(), "an override also wins over the saved value");
        assertEquals(CREATIVE_PARENT, mirror.serverContextInheritance());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "warp.spawn", PVP));
    }
}
