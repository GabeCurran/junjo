package io.junjo.sdk.mirror;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.RetryPolicy;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.internal.DurableFiles;
import io.junjo.sdk.model.PermissionSource;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

/** Retention of untracked members: across restarts, window expiry, identity changes and old files. */
@Timeout(30)
class MirrorRetentionTest {
    static final String ACCESS_PATH = "/v1/groups/g1/members/access";
    static final Duration HOUR = Duration.ofHours(1);

    /** A clock tests move by hand. */
    static final class TestClock extends Clock {
        final AtomicReference<Instant> now = new AtomicReference<>(Instant.parse("2026-11-06T12:00:00Z"));

        void advance(Duration d) {
            now.updateAndGet(t -> t.plus(d));
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now.get();
        }
    }

    @TempDir
    Path dir;

    FakeServer server;
    JunjoClient client;
    GameMirror mirror;
    Path file;
    final TestClock clock = new TestClock();
    final AtomicBoolean down = new AtomicBoolean();
    final AtomicReference<CountDownLatch> accessGate = new AtomicReference<>(new CountDownLatch(0));
    final CountDownLatch hold = new CountDownLatch(1);
    final LinkedBlockingQueue<String> frames = new LinkedBlockingQueue<>();
    final Map<String, String> accessByUser = new ConcurrentHashMap<>();
    final List<Throwable> errors = new CopyOnWriteArrayList<>();
    final List<MirrorChange> changes = new CopyOnWriteArrayList<>();

    static String access(String userId, long version, String... roles) {
        StringBuilder r = new StringBuilder();
        for (String role : roles) r.append(r.isEmpty() ? "" : ",").append('"').append(role).append('"');
        return """
                {"groupId":"g1","userId":"%s","status":"active","roleIds":[%s],"overrides":[],"version":%d}"""
                .formatted(userId, r, version);
    }

    static String graph() {
        return """
                {"groupId":"g1","mode":"nodes","defaultRoleId":null,"roles":[{"id":"vip","groupId":"g1","name":"VIP",
                 "priority":10,"color":null,"isDefault":false,"permissions":[],
                 "entries":[{"permission":"area.*","value":true}],"parents":[],
                 "metadata":{},"createdAt":"2026-11-01T00:00:00Z"}]}""";
    }

    static String identities(String... ids) {
        StringBuilder sb = new StringBuilder("{\"items\":[");
        for (int i = 0; i < ids.length; i++) {
            if (i > 0) sb.append(',');
            sb.append("{\"userId\":\"").append(ids[i]).append("\",\"namespace\":\"ns\",")
                    .append("\"linkedAt\":\"2026-11-01T00:00:0").append(i).append("Z\",\"displayName\":null}");
        }
        return sb.append("]}").toString();
    }

    // Answers 503 for every route while the server is down.
    FakeServer.Handler up(FakeServer.Handler h) {
        return (req, ex) -> {
            if (down.get()) FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down"));
            else h.handle(req, ex);
        };
    }

    @BeforeEach
    void setUp() throws Exception {
        file = dir.resolve("mirror.snapshot");
        accessByUser.put("ns:u1", access("ns:u1", 5, "vip"));
        accessByUser.put("ns:main", access("ns:main", 2));
        server = new FakeServer();
        server.on("GET", "/v1/events/position", up((req, ex) -> FakeServer.json(ex, 200, "{\"position\":\"10\"}")));
        server.on("GET", "/v1/groups/g1/role-graph", up((req, ex) -> FakeServer.json(ex, 200, graph())));
        server.on("GET", "/v1/bans", up((req, ex) -> FakeServer.json(ex, 200, "{\"items\":[],\"nextCursor\":null}")));
        server.on("GET", "/v1/sanctions", up((req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[],\"nextCursor\":null}")));
        server.onPrefix("GET", "/v1/bans/", up((req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no ban"))));
        server.onPrefix("GET", "/v1/users/", up((req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[]}", Map.of("ETag", "\"0\""))));
        server.on("GET", "/v1/users/ns%3Au1alt/identities", up((req, ex) ->
                FakeServer.json(ex, 200, identities("ns:u1", "ns:u1alt"))));
        server.onPrefix("GET", "/v1/groups/g1/members/", up((req, ex) -> {
            String id = URLDecoder.decode(req.path().split("/")[5], StandardCharsets.UTF_8);
            String a = accessByUser.get(id);
            if (a == null) FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no member"));
            else FakeServer.json(ex, 200, a);
        }));
        server.on("POST", ACCESS_PATH, up((req, ex) -> {
            accessGate.get().await(10, TimeUnit.SECONDS);
            StringBuilder sb = new StringBuilder("{\"items\":[");
            boolean first = true;
            for (JsonElement id : JsonParser.parseString(req.body()).getAsJsonObject().getAsJsonArray("userIds")) {
                if (!first) sb.append(',');
                first = false;
                sb.append(accessByUser.getOrDefault(id.getAsString(), "null"));
            }
            FakeServer.json(ex, 200, sb.append("]}").toString());
        }));
        server.on("GET", "/v1/events", up((req, ex) -> {
            String last = req.header("Last-Event-ID");
            OutputStream out = FakeServer.openSse(ex, last == null ? "50" : last);
            while (hold.getCount() > 0) {
                String f = frames.poll(50, TimeUnit.MILLISECONDS);
                if (f != null) FakeServer.write(out, f);
            }
        }));
        // No client retries, so a load against the server while it is down fails at once.
        client = JunjoClient.builder().baseUrl(server.baseUrl()).apiKey("k").requestTimeout(Duration.ofSeconds(5))
                .retryPolicy(RetryPolicy.none()).build();
        mirror = builder().build();
    }

    GameMirror.Builder builder() {
        return GameMirror.builder(client)
                .group("g1")
                .clock(clock)
                .snapshotFile(file)
                .retainUntracked(HOUR)
                .retryBackoff(Duration.ofMillis(20), Duration.ofMillis(100))
                .streamOptions(SubscribeOptions.builder().backoff(Duration.ofMillis(10), Duration.ofMillis(30)))
                .onError(errors::add)
                .onChange(changes::add);
    }

    @AfterEach
    void tearDown() {
        hold.countDown();
        accessGate.get().countDown();
        mirror.close();
        client.close();
        server.close();
    }

    void push(String type, String position, String fields) {
        frames.add("event: " + type + "\ndata: {\"id\":\"e" + position + "\",\"type\":\"" + type + "\","
                + "\"gameId\":\"gm\",\"occurredAt\":\"2026-11-06T12:00:00.000Z\"," + fields + "}\nid: " + position
                + "\n\n");
    }

    void awaitPosition(String p) throws InterruptedException {
        await(() -> p.equals(mirror.position()), "position " + p);
    }

    int accessLoads() {
        return server.requests("POST", ACCESS_PATH).size()
                + (int) server.requests.stream()
                        .filter(r -> r.method().equals("GET") && r.path().startsWith("/v1/groups/g1/members/"))
                        .count();
    }

    // Starts, tracks u1, then untracks them, so they are retained.
    void retainU1() throws Exception {
        join(mirror.start());
        join(mirror.track("ns:u1", "g1"));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"));
        mirror.untrack("ns:u1", "g1");
        join(mirror.sync());
    }

    // Closes the mirror (saving the file) and starts a new one from it with the server down.
    void restartWithTheServerDown() throws Exception {
        mirror.close();
        down.set(true);
        errors.clear();
        changes.clear();
        mirror = builder().build();
        join(mirror.start());
    }

    @Test
    void anUntrackedMemberIsRetainedButNotTracked() throws Exception {
        retainU1();
        assertEquals(Set.of(), mirror.trackedMembers("g1"), "a retained member is not tracked");
        assertEquals(Answer.UNKNOWN, mirror.can("ns:u1", "g1", "area.door"), "reads do not answer for it");
        assertEquals(Answer.UNKNOWN, mirror.isLoaded("ns:u1", "g1"));
        GameMirror.RetainedMember kept = mirror.retainedMembers("g1").get("ns:u1");
        assertEquals(clock.instant(), kept.lastConnectedAt());
        assertEquals(List.of("vip"), kept.access().roleIds());

        // Stream events for a retained member cost no requests.
        int loads = accessLoads();
        push("member.updated", "11", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"changed\":[\"notes\"],"
                + "\"memberVersion\":5");
        awaitPosition("11");
        assertEquals(loads, accessLoads());
        assertTrue(mirror.retainedMembers("g1").containsKey("ns:u1"), "a version already held keeps the entry");
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void aRetainedMemberAnswersAtOnceAfterARestartWithTheServerDown() throws Exception {
        retainU1();
        mirror.close();
        JsonObject saved = DurableFiles.parseLine(Files.readString(file).strip());
        JsonArray retained = saved.getAsJsonArray("retained");
        assertEquals(1, retained.size());
        assertEquals(clock.instant().toString(),
                retained.get(0).getAsJsonObject().get("lastConnectedAt").getAsString());
        assertEquals(0, saved.getAsJsonArray("members").size(), "the retained member is not saved as tracked");

        clock.advance(Duration.ofMinutes(30));
        restartWithTheServerDown();
        assertEquals(Set.of(), mirror.trackedMembers("g1"));
        assertEquals(Answer.UNKNOWN, mirror.can("ns:u1", "g1", "area.door"), "not answered until tracked");

        join(mirror.track("ns:u1", "g1"));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"), "the retained access answers");
        assertEquals(Set.of("ns:u1"), mirror.trackedMembers("g1"));
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ACCESS, "ns:u1", "g1")));
        assertFalse(errors.isEmpty(), "the failed reload is reported");

        // The server comes back with the member demoted; the retried reload replaces the access.
        accessByUser.put("ns:u1", access("ns:u1", 6));
        changes.clear();
        down.set(false);
        await(() -> mirror.can("ns:u1", "g1", "area.door") == Answer.NO, "the fresh access");
        assertEquals(6, mirror.access("ns:u1", "g1").orElseThrow().version());
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ACCESS, "ns:u1", "g1")));
    }

    @Test
    void aRetainedMemberAnswersWhileTheReloadIsInFlight() throws Exception {
        retainU1();
        CountDownLatch gate = new CountDownLatch(1);
        accessGate.set(gate);
        accessByUser.put("ns:u1", access("ns:u1", 6));
        var tracked = mirror.track("ns:u1", "g1");
        await(() -> mirror.can("ns:u1", "g1", "area.door") == Answer.YES, "the retained answer");
        assertFalse(tracked.isDone(), "track waits for the reload while the server answers");
        assertEquals(Answer.YES, mirror.isLoaded("ns:u1", "g1"));
        gate.countDown();
        join(tracked);
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "area.door"), "track completes with the fresh access");
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void anEntryPastTheWindowIsNotServed() throws Exception {
        retainU1();
        clock.advance(HOUR.plusSeconds(1));
        down.set(true);
        failure(mirror.track("ns:u1", "g1"));   // not served, so the failed load fails the track
        assertEquals(Answer.UNKNOWN, mirror.can("ns:u1", "g1", "area.door"));
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
    }

    @Test
    void expiredEntriesArePrunedOnLoad() throws Exception {
        retainU1();
        clock.advance(HOUR.plusSeconds(1));
        restartWithTheServerDown();
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
        mirror.close();
        assertEquals(0, DurableFiles.parseLine(Files.readString(file).strip()).getAsJsonArray("retained").size(),
                "the pruned entry is gone from the file too");
    }

    @Test
    void expiredEntriesArePrunedPeriodically() throws Exception {
        mirror.close();
        mirror = builder().clock(Clock.systemUTC()).retainUntracked(Duration.ofSeconds(2)).build();
        retainU1();
        assertTrue(mirror.retainedMembers("g1").containsKey("ns:u1"));
        await(() -> mirror.retainedMembers("g1").isEmpty(), "the periodic prune");
    }

    @Test
    void aFileWithRetainedMembersLoadsWithNoneWhenRetentionIsOff() throws Exception {
        retainU1();
        mirror.close();
        mirror = builder().retainUntracked(Duration.ZERO).build();
        join(mirror.start());
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
    }

    @Test
    void aLinkedIdOfTheSamePersonRestoresTheEntry() throws Exception {
        retainU1();
        join(mirror.track("ns:u1alt", "g1"));
        assertEquals(Set.of("ns:u1"), mirror.trackedMembers("g1"));
        assertEquals(Answer.YES, mirror.can("ns:u1alt", "g1", "area.door"));
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
    }

    @Test
    void anIdentityLinkDropsTheEntry() throws Exception {
        retainU1();
        // u1 becomes a secondary id of another person, rendered as ns:main.
        push("identity.linked", "11", "\"userId\":\"ns:main\",\"linkedUserId\":\"ns:u1\","
                + "\"identities\":[\"ns:main\",\"ns:u1\"]");
        awaitPosition("11");
        assertEquals(Map.of(), mirror.retainedMembers("g1"), "the person behind the entry changed");

        down.set(true);
        failure(mirror.track("ns:u1", "g1"));
        assertEquals(Answer.UNKNOWN, mirror.can("ns:u1", "g1", "area.door"), "the old access never answers");
        assertEquals(Answer.UNKNOWN, mirror.can("ns:main", "g1", "area.door"));
    }

    @Test
    void anIdentityUnlinkDropsTheEntry() throws Exception {
        join(mirror.start());
        join(mirror.track("ns:u1alt", "g1"));
        mirror.untrack("ns:u1alt", "g1");
        join(mirror.sync());
        assertTrue(mirror.retainedMembers("g1").containsKey("ns:u1"));
        push("identity.unlinked", "11", "\"userId\":\"ns:u1\",\"unlinkedUserId\":\"ns:u1alt\","
                + "\"identities\":[\"ns:u1\"]");
        awaitPosition("11");
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
    }

    @Test
    void aNewerMemberEventDropsTheEntry() throws Exception {
        retainU1();
        int loads = accessLoads();
        push("member.updated", "11", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"changed\":[\"roles\"],"
                + "\"memberVersion\":6");
        awaitPosition("11");
        assertEquals(Map.of(), mirror.retainedMembers("g1"), "the retained access is known to be outdated");
        assertEquals(loads, accessLoads(), "and it is not reloaded");

        retainU1();
        push("role.changed", "12", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"added\":[],\"removed\":[\"vip\"],"
                + "\"actorUserId\":null");
        awaitPosition("12");
        assertEquals(Map.of(), mirror.retainedMembers("g1"), "an event without a version may be newer");
    }

    @Test
    void aGroupDeletionDropsTheEntry() throws Exception {
        retainU1();
        push("group.deleted", "11", "\"groupId\":\"g1\"");
        awaitPosition("11");
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
    }

    @Test
    void aNonMemberIsRetainedAsANonMember() throws Exception {
        join(mirror.start());
        join(mirror.track("ns:ghost", "g1"));
        mirror.untrack("ns:ghost", "g1");
        join(mirror.sync());
        restartWithTheServerDown();
        assertNull(mirror.retainedMembers("g1").get("ns:ghost").access());
        join(mirror.track("ns:ghost", "g1"));
        assertEquals(PermissionSource.NONE, mirror.check("ns:ghost", "g1", "area.door").orElseThrow().source());
    }

    @Test
    void retentionIsOffByDefault() throws Exception {
        mirror.close();
        mirror = GameMirror.builder(client).group("g1").build();
        join(mirror.start());
        join(mirror.track("ns:u1", "g1"));
        mirror.untrack("ns:u1", "g1");
        join(mirror.sync());
        assertEquals(Map.of(), mirror.retainedMembers("g1"));
        assertThrows(IllegalArgumentException.class, () -> builder().retainUntracked(Duration.ofSeconds(-1)));
    }

    @Test
    void aSnapshotWrittenBeforeRetentionStillLoads() throws Exception {
        mirror.close();
        // The shape version 1 files had before retained members were saved: no "retained" field.
        String old = """
                {"format":"junjo-mirror","version":1,"savedAt":"2026-11-06T11:00:00Z","position":"10",
                 "groups":[%s],"bans":[],"banVersions":{},"sanctions":[],"sanctionVersions":{},
                 "members":[{"groupId":"g1","userId":"ns:u1","access":%s}],
                 "people":[{"ids":["ns:u1"],"rendered":"ns:u1"}],"renderedIds":["ns:u1"]}"""
                .formatted(graph(), access("ns:u1", 5, "vip")).replace("\n", "");
        Files.writeString(file, DurableFiles.line(old));
        down.set(true);
        mirror = builder().build();
        join(mirror.start());
        assertEquals("10", mirror.position());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"));
        assertEquals(Map.of(), mirror.retainedMembers("g1"));

        // The member retained from it is written with the new field.
        mirror.untrack("ns:u1", "g1");
        join(mirror.sync());
        mirror.close();
        JsonObject saved = DurableFiles.parseLine(Files.readString(file).strip());
        assertEquals(1, saved.get("version").getAsInt(), "the format version is unchanged");
        assertEquals("ns:u1", saved.getAsJsonArray("retained").get(0).getAsJsonObject().get("userId").getAsString());
    }
}
