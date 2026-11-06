package io.junjo.sdk.mirror;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.Sanction;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
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

@Timeout(30)
class GameMirrorTest {
    static final String CLOSE = "<close>";

    @TempDir
    Path dir;

    FakeServer server;
    JunjoClient client;
    GameMirror mirror;
    final CountDownLatch hold = new CountDownLatch(1);
    final CountDownLatch slowRelease = new CountDownLatch(1);
    final LinkedBlockingQueue<String> frames = new LinkedBlockingQueue<>();
    final AtomicReference<String> graphEntries = new AtomicReference<>("{\"permission\":\"area.*\",\"value\":true}");
    final AtomicReference<String> defaultRole = new AtomicReference<>("null");
    final AtomicReference<String> access = new AtomicReference<>(access(5, "active"));
    final AtomicReference<String> banList = new AtomicReference<>(ban("ns:banned", 2));
    final AtomicReference<String> sanctionList = new AtomicReference<>(sanction("ns:muted", "mute", null, 3));
    final AtomicInteger streamConnections = new AtomicInteger();
    final AtomicInteger positionOutage = new AtomicInteger();
    final List<String> lastEventIds = new CopyOnWriteArrayList<>();
    final List<Throwable> errors = new CopyOnWriteArrayList<>();
    final List<MirrorChange> changes = new CopyOnWriteArrayList<>();
    volatile String streamQuery;
    volatile boolean expireNextResume;

    static String access(long version, String status) {
        return """
                {"groupId":"g1","userId":"ns:u1","status":"%s","roleIds":["vip"],"overrides":[],"version":%d}"""
                .formatted(status, version);
    }

    static String ban(String userId, long version) {
        return """
                {"id":"b-%s","gameId":"gm","userId":"%s","bannedAt":"2026-11-01T00:00:00Z","expiresAt":null,
                 "reason":"x","bannedBy":null,"version":%d}""".formatted(userId, userId, version);
    }

    static String sanction(String userId, String type, String expiresAt, long version) {
        return """
                {"id":"s-%s","userId":"%s","type":"%s","reason":"r","issuer":"Console","issuedBy":null,
                 "startedAt":"2026-11-01T00:00:00Z","expiresAt":%s,"version":%d}"""
                .formatted(userId, userId, type, expiresAt == null ? "null" : "\"" + expiresAt + "\"", version);
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

    String graph() {
        return """
                {"groupId":"g1","mode":"nodes","defaultRoleId":%s,"roles":[{"id":"vip","groupId":"g1","name":"VIP",
                 "priority":10,"color":null,"isDefault":false,"permissions":[],"entries":[%s],"parents":[],
                 "metadata":{},"createdAt":"2026-11-01T00:00:00Z"}]}"""
                .formatted(defaultRole.get(), graphEntries.get());
    }

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        server.on("GET", "/v1/events/position", (req, ex) -> {
            if (positionOutage.getAndDecrement() > 0) {
                FakeServer.json(ex, 503, FakeServer.error("internal", 503, "outage"));
            } else {
                FakeServer.json(ex, 200, "{\"position\":\"10\"}");
            }
        });
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, graph()));
        server.on("GET", "/v1/bans", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + banList.get() + "],\"nextCursor\":null}"));
        server.on("GET", "/v1/groups/g1/members/ns%3Au1/access", (req, ex) -> FakeServer.json(ex, 200, access.get()));
        server.on("GET", "/v1/sanctions", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + sanctionList.get() + "],\"nextCursor\":null}"));
        server.onPrefix("GET", "/v1/users/", (req, ex) ->
                FakeServer.json(ex, 200, "{\"items\":[]}", Map.of("ETag", "\"0\"")));
        server.on("GET", "/v1/users/ns%3Alinked/sanctions", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + sanction("ns:linked", "trade.lock", null, 4) + "]}", Map.of("ETag", "\"4\"")));
        server.on("GET", "/v1/users/ns%3Aalt/identities", (req, ex) ->
                FakeServer.json(ex, 200, identities("ns:banned", "ns:alt")));
        server.on("GET", "/v1/users/ns%3Au1alt/identities", (req, ex) ->
                FakeServer.json(ex, 200, identities("ns:u1", "ns:u1alt")));
        server.on("POST", "/v1/groups/g1/members/access", (req, ex) -> {
            StringBuilder sb = new StringBuilder("{\"items\":[");
            boolean firstItem = true;
            for (JsonElement id : JsonParser.parseString(req.body()).getAsJsonObject().getAsJsonArray("userIds")) {
                if (!firstItem) sb.append(',');
                firstItem = false;
                String u = id.getAsString();
                if (u.equals("ns:slow")) slowRelease.await(10, TimeUnit.SECONDS);
                sb.append(u.equals("ns:u1") || u.equals("ns:u1alt") ? access.get() : "null");
            }
            FakeServer.json(ex, 200, sb.append("]}").toString());
        });
        server.on("GET", "/v1/groups/g1/members/ns%3Aghost/access", (req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no member")));
        server.onPrefix("GET", "/v1/bans/", (req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no ban")));
        server.on("GET", "/v1/bans/ns%3Alinked", (req, ex) -> FakeServer.json(ex, 200, ban("ns:linked", 4)));
        server.on("GET", "/v1/events", (req, ex) -> {
            streamConnections.incrementAndGet();
            String last = req.header("Last-Event-ID");
            lastEventIds.add(String.valueOf(last));
            streamQuery = req.query();
            if (last != null && expireNextResume) {
                expireNextResume = false;
                FakeServer.json(ex, 410, FakeServer.error("stream_position_expired", 410, "gone"));
                return;
            }
            OutputStream out = FakeServer.openSse(ex, last == null ? "50" : last);
            while (hold.getCount() > 0) {
                String f = frames.poll(50, TimeUnit.MILLISECONDS);
                if (f == null) continue;
                if (f.equals(CLOSE)) return;
                FakeServer.write(out, f);
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
        slowRelease.countDown();
        mirror.close();
        client.close();
        server.close();
    }

    void push(String type, String position, String fields) {
        frames.add("event: " + type + "\ndata: {\"id\":\"e" + position + "\",\"type\":\"" + type + "\","
                + "\"gameId\":\"gm\",\"occurredAt\":\"2026-11-06T12:00:00.000Z\""
                + (fields.isEmpty() ? "" : "," + fields) + "}\nid: " + position + "\n\n");
    }

    void awaitPosition(String p) throws InterruptedException {
        await(() -> p.equals(mirror.position()), "position " + p);
    }

    void startAndTrack() throws Exception {
        assertEquals(Answer.UNKNOWN, mirror.isBanned("ns:banned"), "unknown before the first load");
        join(mirror.start());
        join(mirror.track("ns:u1", "g1"));
    }

    @Test
    void loadsSnapshotsThenFollowsTheStreamFromTheirPosition() throws Exception {
        startAndTrack();
        assertTrue(mirror.isReady());
        assertTrue(mirror.isLive());
        assertEquals(GameMirror.StreamState.CONNECTED, mirror.streamState());
        assertEquals(List.of("10"), lastEventIds);
        assertTrue(streamQuery.startsWith("types=game.user.banned%2C"));
        assertEquals(Answer.YES, mirror.isBanned("ns:banned"));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "AREA.door"));
        PermissionCheckResult r = mirror.check("ns:u1", "g1", "area.door").orElseThrow();
        assertEquals("vip", r.viaRoleId());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "other"));
        assertEquals(Optional.empty(), mirror.check("ns:untracked", "g1", "area.door"), "untracked reads as unknown");
        assertEquals(Optional.empty(), mirror.check("ns:u1", "g2", "area.door"), "unloaded group reads as unknown");
        assertEquals("VIP", mirror.role("g1", "vip").orElseThrow().name());
        assertEquals(1, mirror.memberRoles("ns:u1", "g1").orElseThrow().size());
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ACCESS, "ns:u1", "g1")));
    }

    int queuedApplierTasks() throws Exception {
        java.lang.reflect.Field f = GameMirror.class.getDeclaredField("applierQueue");
        f.setAccessible(true);
        return ((java.util.Collection<?>) f.get(mirror)).size();
    }

    @Test
    void aBurstOfEventsSharesOneGraphReloadAndOneBatchedMemberRead() throws Exception {
        startAndTrack();
        join(mirror.track("ns:u2", "g1"));
        join(mirror.track("ns:u3", "g1"));
        String graphPath = "/v1/groups/g1/role-graph";
        String batchPath = "/v1/groups/g1/members/access";
        int graphs = server.requests("GET", graphPath).size();
        String position = mirror.position();

        // A slow batched read holds the applier while the burst queues up behind it.
        CompletableFuture<Void> slow = mirror.track("ns:slow", "g1");
        await(() -> server.requests("POST", batchPath).stream().anyMatch(r -> r.body().contains("ns:slow")),
                "the slow read started");
        int batches = server.requests("POST", batchPath).size();
        for (int i = 0; i < 5; i++) {
            push("permission.granted", String.valueOf(11 + i),
                    "\"groupId\":\"g1\",\"roleId\":\"vip\",\"permission\":\"p" + i + "\"");
        }
        String[] users = {"ns:u1", "ns:u2", "ns:u3"};
        for (int i = 0; i < users.length; i++) {
            push("role.changed", String.valueOf(16 + i), "\"groupId\":\"g1\",\"userId\":\"" + users[i]
                    + "\",\"added\":[\"vip\"],\"removed\":[],\"actorUserId\":null");
        }
        await(() -> {
            try {
                return queuedApplierTasks() >= 8;
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        }, "the burst is queued");
        CompletableFuture<Void> barrier = mirror.sync();
        changes.clear();
        assertEquals(position, mirror.position(), "nothing of the burst is applied yet");
        slowRelease.countDown();
        join(slow);
        join(barrier);

        // The barrier runs after the deferred reloads, and the position covers the whole burst.
        assertEquals("18", mirror.position());
        assertEquals(graphs + 1, server.requests("GET", graphPath).size(), "one graph reload for five grants");
        List<FakeServer.Req> reads = server.requests("POST", batchPath);
        assertEquals(batches + 1, reads.size(), "one batched read for three members");
        for (String u : users) assertTrue(reads.get(reads.size() - 1).body().contains(u), u);
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, "g1")));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"));
    }

    @Test
    void readAccessorsExposeTheLoadedState() throws Exception {
        startAndTrack();
        assertEquals(Set.of("ns:banned"), mirror.bans().keySet());
        assertEquals(List.of("ns:muted"), mirror.sanctionsAll().stream().map(Sanction::userId).toList());
        assertEquals(Set.of("ns:u1"), mirror.trackedMembers("g1"));
        assertTrue(mirror.lastEventAt().isEmpty());
        push("role.updated", "11", "\"groupId\":\"other\",\"roleId\":\"x\",\"changed\":[\"name\"]");
        awaitPosition("11");
        assertTrue(mirror.lastEventAt().isPresent());
    }

    @Test
    void anUnresolvedIdAnswersUnknownUntilResolvedInTheBackground() throws Exception {
        join(mirror.start());
        assertEquals(Answer.UNKNOWN, mirror.isBanned("ns:other"));
        assertEquals(Answer.UNKNOWN, mirror.isSanctioned("ns:other", "mute"));
        join(mirror.sync());
        assertEquals(Answer.NO, mirror.isBanned("ns:other"), "the read queued a resolution");
        assertEquals(Answer.NO, mirror.isSanctioned("ns:other", "mute"));
        assertEquals("ns:other", join(mirror.resolve("ns:other")), "an id the game never saw is its own key");
    }

    @Test
    void anyLinkedIdAnswersForThePerson() throws Exception {
        join(mirror.start());
        assertEquals("ns:banned", join(mirror.resolve("ns:alt")), "the id seen in the ban list is the rendered one");
        assertEquals(Answer.YES, mirror.isBanned("ns:alt"));
        assertEquals("x", mirror.ban("ns:alt").orElseThrow().reason());

        join(mirror.track("ns:u1alt", "g1"));
        assertEquals(Set.of("ns:u1"), mirror.trackedMembers("g1"), "the member is keyed by the person");
        assertEquals(Answer.YES, mirror.can("ns:u1alt", "g1", "area.door"));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"));
        assertEquals(Answer.YES, mirror.isLoaded("ns:u1alt", "g1"));
        mirror.untrack("ns:u1alt", "g1");
        join(mirror.sync());
        assertTrue(mirror.trackedMembers("g1").isEmpty());
    }

    @Test
    void nonMemberAnswersNoneUnlessTheDefaultRoleIsOptedIn() throws Exception {
        defaultRole.set("\"vip\"");
        join(mirror.start());
        join(mirror.track("ns:ghost", "g1"));
        assertEquals(PermissionSource.NONE, mirror.check("ns:ghost", "g1", "area.door").orElseThrow().source());
        assertEquals(Answer.YES, mirror.isLoaded("ns:ghost", "g1"));
        mirror.close();

        mirror = builder().defaultRoleForNonMembers(true).build();
        join(mirror.start());
        join(mirror.track("ns:ghost", "g1"));
        PermissionCheckResult r = mirror.check("ns:ghost", "g1", "area.door").orElseThrow();
        assertTrue(r.allowed());
        assertEquals("vip", r.viaRoleId());
        assertEquals(Answer.YES, mirror.checker("ns:ghost", "g1").can("area.door"));
    }

    @Test
    void aCheckerGivesTheSameAnswersAndFollowsChanges() throws Exception {
        startAndTrack();
        graphEntries.set("{\"permission\":\"area.*\",\"value\":true},{\"permission\":\"area.vault\",\"value\":false}");
        push("role.updated", "11", "\"groupId\":\"g1\",\"roleId\":\"vip\",\"changed\":[\"entries\"]");
        awaitPosition("11");
        MemberChecker checker = mirror.checker("ns:u1", "g1");
        for (String p : List.of("area.door", "area.vault", "other", "AREA.x")) {
            assertEquals(mirror.check("ns:u1", "g1", p), checker.check(p), p);
        }
        assertEquals(Set.of("area.*"), checker.grantedKeys().orElseThrow());

        access.set(access(6, "left"));
        push("member.left", "12", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"reason\":\"left\",\"memberVersion\":6");
        awaitPosition("12");
        assertEquals(Answer.NO, checker.can("area.door"), "the checker reads the current state");
        assertTrue(mirror.checker("ns:nobody", "g1").check("area.door").isEmpty());
    }

    @Test
    void roleEventsReloadTheGroupGraph() throws Exception {
        startAndTrack();
        int before = server.requests("GET", "/v1/groups/g1/role-graph").size();
        graphEntries.set("{\"permission\":\"area.*\",\"value\":true},{\"permission\":\"area.door\",\"value\":false}");
        push("role.updated", "11", "\"groupId\":\"g1\",\"roleId\":\"vip\",\"changed\":[\"entries\"]");
        awaitPosition("11");
        assertEquals(before + 1, server.requests("GET", "/v1/groups/g1/role-graph").size());
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "area.door"));
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.gate"));
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.ROLE_GRAPH, null, "g1")));

        push("role.updated", "12", "\"groupId\":\"other\",\"roleId\":\"x\",\"changed\":[\"entries\"]");
        awaitPosition("12");
        assertEquals(before + 1, server.requests("GET", "/v1/groups/g1/role-graph").size(), "other groups are ignored");
    }

    @Test
    void memberEventsSkipVersionsTheSnapshotAlreadyHas() throws Exception {
        startAndTrack();
        String path = "/v1/groups/g1/members/ns%3Au1/access";
        int loads = server.requests("GET", path).size();

        push("member.updated", "11", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"changed\":[\"metadata\"],"
                + "\"memberVersion\":5");
        awaitPosition("11");
        assertEquals(loads, server.requests("GET", path).size(), "version 5 is already loaded");
        assertEquals(1, mirror.skippedEvents());

        access.set(access(6, "left"));
        changes.clear();
        push("member.left", "12", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"reason\":\"left\",\"memberVersion\":6");
        awaitPosition("12");
        assertEquals(loads + 1, server.requests("GET", path).size());
        assertEquals(PermissionSource.NONE, mirror.check("ns:u1", "g1", "area.door").orElseThrow().source());
        assertEquals(6, mirror.access("ns:u1", "g1").orElseThrow().version());
        assertEquals(List.of(new MirrorChange(MirrorChange.Kind.ACCESS, "ns:u1", "g1")), changes);

        push("role.changed", "13", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"added\":[\"vip\"],\"removed\":[],"
                + "\"actorUserId\":null");
        awaitPosition("13");
        assertEquals(loads + 2, server.requests("GET", path).size(), "an event without a version always reloads");

        push("member.updated", "14", "\"groupId\":\"g1\",\"userId\":\"ns:other\",\"changed\":[\"notes\"],"
                + "\"memberVersion\":1");
        awaitPosition("14");
        assertEquals(loads + 2, server.requests("GET", path).size(), "untracked members are ignored");
    }

    @Test
    void banEventsUpdateTheMapSkipStaleVersionsAndReportChanges() throws Exception {
        startAndTrack();
        changes.clear();
        push("game.user.banned", "11", "\"junjoUserId\":\"j\",\"userId\":\"ns:new\",\"reason\":\"spam\","
                + "\"expiresAt\":null,"
                + "\"moderationVersion\":1");
        awaitPosition("11");
        assertEquals(Answer.YES, mirror.isBanned("ns:new"));
        assertEquals("spam", mirror.ban("ns:new").orElseThrow().reason());
        assertEquals(List.of(new MirrorChange(MirrorChange.Kind.BAN, "ns:new", null)), changes);

        push("game.user.unbanned", "12", "\"junjoUserId\":\"j\",\"userId\":\"ns:new\",\"moderationVersion\":2");
        awaitPosition("12");
        assertEquals(Answer.NO, mirror.isBanned("ns:new"));

        push("game.user.banned", "13", "\"junjoUserId\":\"j\",\"userId\":\"ns:new\",\"reason\":\"spam\","
                + "\"expiresAt\":null,"
                + "\"moderationVersion\":1");
        awaitPosition("13");
        assertEquals(Answer.NO, mirror.isBanned("ns:new"), "a replayed older ban does not resurrect");

        push("game.user.unbanned", "14", "\"junjoUserId\":\"j\",\"userId\":\"ns:banned\",\"moderationVersion\":2");
        awaitPosition("14");
        assertEquals(Answer.YES, mirror.isBanned("ns:banned"), "the snapshot already reflects version 2");
        assertEquals(2, mirror.skippedEvents());

        push("game.user.banned", "15", "\"junjoUserId\":\"j\",\"userId\":\"ns:old\",\"reason\":null,"
                + "\"expiresAt\":\"2020-01-01T00:00:00Z\"");
        awaitPosition("15");
        assertEquals(Answer.NO, mirror.isBanned("ns:old"), "an expired ban is not in force");
    }

    @Test
    void aThrowingChangeListenerIsGuarded() throws Exception {
        List<MirrorChange> seen = new CopyOnWriteArrayList<>();
        mirror.close();
        mirror = builder().onChange(c -> {
            seen.add(c);
            throw new IllegalStateException("listener bug");
        }).build();
        join(mirror.start());
        push("game.user.banned", "11", "\"junjoUserId\":\"j\",\"userId\":\"ns:a\",\"reason\":null,\"expiresAt\":null");
        push("game.user.banned", "12", "\"junjoUserId\":\"j\",\"userId\":\"ns:b\",\"reason\":null,\"expiresAt\":null");
        awaitPosition("12");
        assertTrue(seen.contains(new MirrorChange(MirrorChange.Kind.BAN, "ns:b", null)), "later changes still arrive");
        assertEquals(Answer.YES, mirror.isBanned("ns:b"));
    }

    @Test
    void identityEventsLinkIdsAndInvalidateMappings() throws Exception {
        startAndTrack();
        String accessPath = "/v1/groups/g1/members/ns%3Au1/access";
        int loads = server.requests("GET", accessPath).size();
        push("identity.linked", "11", "\"userId\":\"ns:u1\",\"linkedUserId\":\"ns:linked\","
                + "\"identities\":[\"ns:u1\",\"ns:linked\"]");
        awaitPosition("11");
        assertEquals(Answer.YES, mirror.isBanned("ns:linked"));
        assertEquals(Answer.YES, mirror.isBanned("ns:u1"), "the person is banned under their linked id");
        assertEquals(Answer.YES, mirror.isSanctioned("ns:u1", "trade.lock"));
        assertEquals(1, server.requests("GET", "/v1/bans/ns%3Alinked").size());
        assertEquals(1, server.requests("GET", "/v1/bans/ns%3Au1").size());
        assertEquals(loads + 1, server.requests("GET", accessPath).size());
        assertEquals("ns:u1", join(mirror.resolve("ns:linked")));
        assertEquals(Answer.YES, mirror.can("ns:linked", "g1", "area.door"));

        push("identity.unlinked", "12", "\"userId\":\"ns:u1\",\"unlinkedUserId\":\"ns:linked\","
                + "\"identities\":[\"ns:u1\"]");
        awaitPosition("12");
        assertEquals("ns:linked", join(mirror.resolve("ns:linked")), "the unlinked id is a person of its own");
    }

    @Test
    void expiredPositionTriggersAFullReload() throws Exception {
        LinkedBlockingQueue<String> resyncs = new LinkedBlockingQueue<>();
        mirror.close();
        mirror = builder().onResync(resyncs::add).build();
        startAndTrack();
        int graphs = server.requests("GET", "/v1/groups/g1/role-graph").size();
        int bans = server.requests("GET", "/v1/bans").size();
        banList.set(ban("ns:later", 1));
        sanctionList.set(sanction("ns:later", "mute", null, 2));
        graphEntries.set("{\"permission\":\"area.*\",\"value\":false}");
        expireNextResume = true;
        frames.add(CLOSE);
        assertEquals("50", resyncs.poll(10, TimeUnit.SECONDS));
        assertEquals("50", mirror.position());
        assertEquals(graphs + 1, server.requests("GET", "/v1/groups/g1/role-graph").size());
        assertEquals(bans + 1, server.requests("GET", "/v1/bans").size());
        assertEquals(Answer.YES, mirror.isBanned("ns:later"));
        assertEquals(Answer.YES, mirror.isSanctioned("ns:later", "mute"));
        assertEquals(Answer.NO, mirror.can("ns:u1", "g1", "area.door"), "tracked members are reloaded");
        assertEquals(List.of("10", "10", "null"), lastEventIds);
        assertTrue(mirror.isLive());
        assertEquals(Answer.UNKNOWN, mirror.isBanned("ns:banned"), "resolved ids are dropped by a full reload");
        join(mirror.sync());
        assertEquals(Answer.NO, mirror.isBanned("ns:banned"));
    }

    @Test
    void sanctionsLoadFollowEventsAndExpireLocally() throws Exception {
        startAndTrack();
        assertEquals(Answer.YES, mirror.isSanctioned("ns:muted", "mute"));
        assertEquals("Console", mirror.sanction("ns:muted", "mute").orElseThrow().issuer());
        assertEquals(Answer.NO, mirror.isSanctioned("ns:muted", "voice"));

        push("game.user.unsanctioned", "11", "\"userId\":\"ns:muted\",\"sanctionType\":\"mute\","
                + "\"moderationVersion\":3");
        awaitPosition("11");
        assertEquals(Answer.YES, mirror.isSanctioned("ns:muted", "mute"), "version 3 is already loaded");

        push("game.user.sanctioned", "12", "\"userId\":\"ns:muted\",\"sanctionType\":\"mute\",\"reason\":\"again\","
                + "\"expiresAt\":null,\"moderationVersion\":4");
        awaitPosition("12");
        Sanction replaced = mirror.sanction("ns:muted", "mute").orElseThrow();
        assertEquals("again", replaced.reason());
        assertEquals("s-ns:muted", replaced.id(), "a replacement keeps the loaded id");
        assertEquals("Console", replaced.issuer());
        assertTrue(changes.contains(new MirrorChange(MirrorChange.Kind.SANCTION, "ns:muted", null)));

        push("game.user.unsanctioned", "13", "\"userId\":\"ns:muted\",\"sanctionType\":\"mute\","
                + "\"moderationVersion\":5");
        awaitPosition("13");
        assertEquals(Answer.NO, mirror.isSanctioned("ns:muted", "mute"));

        push("game.user.sanctioned", "14", "\"userId\":\"ns:new\",\"sanctionType\":\"voice\",\"reason\":null,"
                + "\"expiresAt\":\"2999-01-01T00:00:00Z\",\"moderationVersion\":1");
        push("game.user.sanctioned", "15", "\"userId\":\"ns:new\",\"sanctionType\":\"trade\",\"reason\":null,"
                + "\"expiresAt\":\"2020-01-01T00:00:00Z\",\"moderationVersion\":2");
        awaitPosition("15");
        assertEquals(Answer.YES, mirror.isSanctioned("ns:new", "voice"));
        assertEquals(Answer.NO, mirror.isSanctioned("ns:new", "trade"), "expiry is judged locally");
        assertEquals(1, mirror.sanctions("ns:new").size());

        // Ban and sanction versions are tracked apart: a sanction version says nothing about bans.
        push("game.user.banned", "16", "\"junjoUserId\":\"j\",\"userId\":\"ns:muted\",\"reason\":null,"
                + "\"expiresAt\":null,\"moderationVersion\":5");
        awaitPosition("16");
        assertEquals(Answer.YES, mirror.isBanned("ns:muted"));
        assertEquals(1, mirror.skippedEvents());
    }

    @Test
    void identityUpdatesReloadDisplayNames() throws Exception {
        startAndTrack();
        String path = "/v1/groups/g1/members/ns%3Au1/access";
        int loads = server.requests("GET", path).size();
        access.set(access(5, "active").replace("\"version\":5", "\"version\":5,\"displayName\":\"Steve\""));
        changes.clear();
        push("identity.updated", "12", "\"userId\":\"ns:u1\",\"changedUserId\":\"web:u1\",\"displayName\":\"Steve\","
                + "\"changed\":[\"displayName\"]");
        awaitPosition("12");
        assertEquals(loads + 1, server.requests("GET", path).size());
        assertEquals("Steve", mirror.access("ns:u1", "g1").orElseThrow().displayName());
        assertEquals(List.of(new MirrorChange(MirrorChange.Kind.DISPLAY_NAME, "ns:u1", "g1")), changes);

        // A person with one id names it twice: as the person and as the changed id.
        access.set(access(5, "active").replace("\"version\":5", "\"version\":5,\"displayName\":\"Sam\""));
        push("identity.updated", "13", "\"userId\":\"ns:u1\",\"changedUserId\":\"ns:u1\",\"displayName\":\"Sam\","
                + "\"changed\":[\"displayName\"]");
        awaitPosition("13");
        assertEquals("Sam", mirror.access("ns:u1", "g1").orElseThrow().displayName());
        assertTrue(errors.isEmpty(), errors.toString());
    }

    @Test
    void aColdStartDuringAnOutageKeepsRetryingUntilTheServerAnswers() throws Exception {
        // The client retries each read 3 times, so this fails 3 mirror attempts.
        positionOutage.set(9);
        CompletableFuture<GameMirror> started = mirror.start();
        await(() -> errors.size() >= 3, "three failed attempts");
        assertFalse(started.isDone() && started.isCompletedExceptionally(), "a failed start does not close the mirror");
        assertEquals(JunjoException.class, errors.get(0).getClass());
        join(started);
        assertTrue(mirror.isReady());
        assertTrue(mirror.isLive());
    }

    @Test
    void memberLoadsHaveTheirOwnShortTimeout() throws Exception {
        mirror.close();
        mirror = builder().memberLoadTimeout(Duration.ofMillis(200)).build();
        join(mirror.start());
        long start = System.nanoTime();
        JunjoException e = failure(mirror.track("ns:slow", "g1"));
        assertEquals(JunjoException.TIMEOUT, e.code());
        assertTrue((System.nanoTime() - start) / 1_000_000 < 5_000);
    }

    @Test
    void concurrentTracksShareOneBatchedRead() throws Exception {
        join(mirror.start());
        CompletableFuture<Void> a = mirror.track("ns:u1", "g1");
        CompletableFuture<Void> b = mirror.track("ns:ghost", "g1");
        CompletableFuture<Void> c = mirror.track("ns:nobody", "g1");
        join(CompletableFuture.allOf(a, b, c));
        List<FakeServer.Req> batches = server.requests("POST", "/v1/groups/g1/members/access");
        assertEquals(1, batches.size());
        assertEquals(3,
                JsonParser.parseString(batches.get(0).body()).getAsJsonObject().getAsJsonArray("userIds").size());
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"));
        assertEquals(PermissionSource.NONE, mirror.check("ns:ghost", "g1", "area.door").orElseThrow().source());
        assertEquals(Answer.YES, mirror.isLoaded("ns:nobody", "g1"));
        assertEquals(0, server.requests("GET", "/v1/groups/g1/members/ns%3Au1/access").size());
    }

    @Test
    void trackedMembersKeepTheirMetadata() throws Exception {
        access.set(access(5, "active").replace("\"version\":5", "\"version\":5,\"metadata\":{\"prefix\":\"[VIP]\"}"));
        startAndTrack();
        assertEquals("[VIP]", mirror.access("ns:u1", "g1").orElseThrow().metadata().get("prefix"));
        access.set(access(6, "active").replace("\"version\":6", "\"version\":6,\"metadata\":{\"prefix\":\"[MVP]\"}"));
        push("member.updated", "11", "\"groupId\":\"g1\",\"userId\":\"ns:u1\",\"changed\":[\"metadata\"],"
                + "\"memberVersion\":6");
        awaitPosition("11");
        assertEquals("[MVP]", mirror.access("ns:u1", "g1").orElseThrow().metadata().get("prefix"));
    }

    @Test
    void aSnapshotFileServesReadsAtOnceAndResumesTheStream() throws Exception {
        Path file = dir.resolve("mirror.snapshot");
        mirror.close();
        mirror = builder().snapshotFile(file).snapshotInterval(Duration.ofSeconds(60)).build();
        startAndTrack();
        push("game.user.banned", "11", "\"junjoUserId\":\"j\",\"userId\":\"ns:new\",\"reason\":\"r\","
                + "\"expiresAt\":null,"
                + "\"moderationVersion\":1");
        awaitPosition("11");
        join(mirror.resolve("ns:alt"));
        mirror.close();
        assertTrue(Files.exists(file), "close saves the snapshot");
        assertTrue(Files.readString(file).matches("(?s)^[0-9a-f]{8} \\{.*"), "the file carries a checksum");

        // The server is down for loads; the mirror answers from the file anyway.
        positionOutage.set(1000);
        lastEventIds.clear();
        int positionCalls = server.requests("GET", "/v1/events/position").size();
        mirror = builder().snapshotFile(file).build();
        join(mirror.start());
        assertTrue(mirror.isReady());
        assertEquals("11", mirror.position());
        assertEquals(Answer.YES, mirror.isBanned("ns:new"));
        assertEquals(Answer.YES, mirror.isBanned("ns:alt"), "resolved ids are saved too");
        assertEquals(Answer.YES, mirror.can("ns:u1", "g1", "area.door"));
        assertEquals(Answer.YES, mirror.isSanctioned("ns:muted", "mute"));
        await(() -> lastEventIds.contains("11"), "the stream resumes from the saved position");
        assertEquals(positionCalls, server.requests("GET", "/v1/events/position").size(), "no reload was needed");
    }

    @Test
    void anExpiredSavedPositionReloadsEverything() throws Exception {
        Path file = dir.resolve("mirror.snapshot");
        mirror.close();
        mirror = builder().snapshotFile(file).build();
        startAndTrack();
        mirror.close();
        banList.set(ban("ns:later", 1));
        expireNextResume = true;
        mirror = builder().snapshotFile(file).build();
        join(mirror.start());
        await(() -> mirror.isBanned("ns:later") == Answer.YES, "the full reload");
        mirror.isBanned("ns:banned");
        join(mirror.sync());
        assertEquals(Answer.NO, mirror.isBanned("ns:banned"));
        assertTrue(mirror.isLive());
    }

    @Test
    void anUnreadableSnapshotIsIgnoredAndReported() throws Exception {
        Path file = dir.resolve("mirror.snapshot");
        Files.writeString(file, "deadbeef {\"format\":\"junjo-mirror\"}\n");
        mirror.close();
        mirror = builder().snapshotFile(file).build();
        join(mirror.start());
        assertTrue(mirror.isReady());
        assertEquals("10", mirror.position(), "loaded from the server instead");
        assertFalse(errors.isEmpty());
    }

    @Test
    void closeStopsTheStreamAndTheApplier() throws Exception {
        startAndTrack();
        int connections = streamConnections.get();
        mirror.close();
        assertFalse(mirror.isLive());
        assertEquals(GameMirror.StreamState.STOPPED, mirror.streamState());
        // close() cancels the subscription and its reconnect timer before it returns, and the
        // applier refuses work afterwards, so nothing can reconnect.
        assertEquals(JunjoException.CANCELLED, failure(mirror.sync()).code());
        assertEquals(connections, streamConnections.get());
        assertTrue(errors.isEmpty(), errors.toString());
        assertNull(mirror.lastEventAt().orElse(null));
    }
}
