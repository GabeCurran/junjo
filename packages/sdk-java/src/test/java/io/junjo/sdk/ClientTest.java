package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.model.Ban;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.Group;
import io.junjo.sdk.model.ImportMember;
import io.junjo.sdk.model.ListGroupsOptions;
import io.junjo.sdk.model.ListMembersOptions;
import io.junjo.sdk.model.Member;
import io.junjo.sdk.model.MemberAccess;
import io.junjo.sdk.model.MemberImport;
import io.junjo.sdk.model.MemberStatus;
import io.junjo.sdk.model.Moderation;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.PermissionCheckRequest;
import io.junjo.sdk.model.PermissionCheckResult;
import io.junjo.sdk.model.PermissionEntry;
import io.junjo.sdk.model.PermissionSource;
import io.junjo.sdk.model.RoleGraph;
import io.junjo.sdk.model.SetMemberNotesInput;
import java.net.ServerSocket;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(30)
class ClientTest {
    static final String MEMBER_JSON = """
            {"id":"m1","groupId":"g1","userId":"ns:u1","status":"active","roles":["r1"],
             "metadata":{"rank":3,"tag":"x"},"notesPublic":null,"notesPrivate":null,
             "joinedAt":"2026-11-01T00:00:00.000Z","bannedUntil":null,"version":7}""";

    static final String GROUP_JSON = """
            {"id":"g1","gameId":"gm","kind":"party","name":"A","visibility":"public","metadata":{},
             "defaultRoleId":null,"parentGroupId":null,"memberCount":1,"hasPasscode":false,
             "createdAt":"2026-11-01T00:00:00Z","updatedAt":"2026-11-01T00:00:00Z","softDeletedAt":null}""";

    FakeServer server;
    JunjoClient client;

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        client = client(RetryPolicy.defaults().withMaxAttempts(3));
    }

    JunjoClient client(RetryPolicy retry) {
        return JunjoClient.builder()
                .baseUrl(server.baseUrl() + "/")
                .apiKey("jk_test.secret")
                .requestTimeout(Duration.ofSeconds(5))
                .retryPolicy(new RetryPolicy(retry.maxAttempts(), Duration.ofMillis(10), Duration.ofMillis(50),
                        Duration.ofSeconds(3)))
                .build();
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.close();
    }

    @Test
    void sendsAuthHeadersAndEncodesPathSegments() throws Exception {
        server.onPrefix("GET", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER_JSON));
        Optional<Member> m = join(client.members().get("g 1", "ns:a/b?c"));
        assertTrue(m.isPresent());
        FakeServer.Req req = server.requests.get(0);
        assertEquals("/v1/groups/g%201/members/ns%3Aa%2Fb%3Fc", req.path());
        assertEquals("Bearer jk_test.secret", req.header("Authorization"));
        assertEquals("application/json", req.header("Accept"));
        assertTrue(req.header("User-Agent").startsWith("junjo-java/"));
        Member member = m.get();
        assertEquals(MemberStatus.ACTIVE, member.status());
        assertEquals(7, member.version());
        assertEquals(3L, member.metadata().get("rank"));
        assertEquals(List.of("r1"), member.roles());
    }

    @Test
    void writesCarryIdempotencyKeyIfMatchAndJsonBody() throws Exception {
        server.on("PATCH", "/v1/groups/g1/members/u1", (req, ex) -> FakeServer.json(ex, 200, MEMBER_JSON));
        WriteOptions opts = WriteOptions.idempotent("key-1").withIfMatch(6);
        join(client.members().setNotes("g1", "u1", SetMemberNotesInput.builder().notesPublic(null).build(), opts));
        FakeServer.Req req = server.requests.get(0);
        assertEquals("key-1", req.header("Idempotency-Key"));
        assertEquals("\"6\"", req.header("If-Match"));
        assertEquals("application/json", req.header("Content-Type"));
        JsonObject body = JsonParser.parseString(req.body()).getAsJsonObject();
        assertTrue(body.get("notesPublic").isJsonNull(), "explicit null is sent to clear the note");
        assertFalse(body.has("notesPrivate"));

        join(client.members().setMetadata("g1", "u1", Map.of("a", 1)));
        JsonObject meta = JsonParser.parseString(server.requests.get(1).body()).getAsJsonObject();
        assertEquals(1, meta.getAsJsonObject("metadata").get("a").getAsInt());
    }

    @Test
    void createOnlyAddSendsIfNoneMatchAndSurfacesTheConflict() throws Exception {
        server.on("POST", "/v1/groups/g1/members", (req, ex) -> {
            if (req.body().contains("\"u2\"")) {
                FakeServer.json(ex, 412, """
                        {"code":"precondition_failed","status":412,
                         "message":"the user already has a membership row in this group with status kicked",
                         "details":{"memberStatus":"kicked"}}""");
            } else {
                FakeServer.json(ex, 201, MEMBER_JSON);
            }
        });
        WriteOptions opts = WriteOptions.idempotent("key-2").withIfNoneMatchAny();
        join(client.members().add("g1", "u1", "r1", null, opts));
        FakeServer.Req req = server.requests.get(0);
        assertEquals("*", req.header("If-None-Match"));
        assertEquals("key-2", req.header("Idempotency-Key"));
        assertNull(req.header("If-Match"));
        JsonObject body = JsonParser.parseString(req.body()).getAsJsonObject();
        assertEquals("r1", body.get("roleId").getAsString());

        join(client.members().add("g1", "u1"));
        assertNull(server.requests.get(1).header("If-None-Match"), "absent unless asked for");

        JunjoException je = failure(client.members().add("g1", "u2", null, null,
                WriteOptions.none().withIfNoneMatchAny()));
        assertEquals("precondition_failed", je.code());
        assertEquals(412, je.status());
        assertEquals("kicked", je.details().orElseThrow().get("memberStatus"));
    }

    @Test
    void writeOptionsKeepIfNoneMatchAcrossCopiesAndValidateIt() {
        WriteOptions opts = WriteOptions.none().withIfNoneMatchAny().withIdempotencyKey("k").withIfMatch(2)
                .withTimeout(Duration.ofSeconds(1));
        assertEquals("*", opts.ifNoneMatch());
        assertEquals(WriteOptions.ANY, opts.ifNoneMatch());
        assertNull(WriteOptions.none().ifNoneMatch());
        assertNull(new WriteOptions("k", null, null).ifNoneMatch());
        assertThrows(IllegalArgumentException.class, () -> new WriteOptions(null, null, null, "\"1\""));
    }

    @Test
    void parsesErrorEnvelopeWithDetailsAndImportRows() throws Exception {
        server.on("POST", "/v1/groups/g1/members/import", (req, ex) -> FakeServer.json(ex, 400, """
                {"code":"bad_request","status":400,"message":"rows failed","requestId":"req-9",
                 "details":{"rows":[{"index":3,"userId":"ns:x","code":"banned","message":"m"},
                                    {"index":5,"code":"invalid_user_id","message":"bad"}]}}""",
                Map.of("x-request-id", "hdr-id")));
        MemberImport imp = MemberImport.builder()
                .add(ImportMember.builder("ns:x").roleIds(List.of("r")).overrides(List.of(PermissionEntry.deny("a.b")))
                        .build())
                .allowBanned(false)
                .build();
        JunjoException e = failure(client.members().importMembers("g1", imp));
        assertEquals("bad_request", e.code());
        assertEquals(400, e.status());
        assertEquals("rows failed", e.getMessage());
        assertEquals("req-9", e.requestId().orElseThrow());
        assertTrue(e.details().isPresent());
        List<JunjoException.ImportRowError> rows = e.importRowErrors();
        assertEquals(2, rows.size());
        assertEquals(3, rows.get(0).index());
        assertEquals("banned", rows.get(0).code());
        assertNull(rows.get(1).userId());
        assertEquals(1, server.requests.size(), "a write without a key is never retried");
        JsonObject row = JsonParser.parseString(server.requests.get(0).body()).getAsJsonObject()
                .getAsJsonArray("members").get(0).getAsJsonObject();
        JsonObject override = row.getAsJsonArray("overrides").get(0).getAsJsonObject();
        assertEquals("a.b", override.get("permission").getAsString());
        assertFalse(override.get("value").getAsBoolean());
    }

    @Test
    void isNotActiveRecognisesOnlyTheLiftAnswer() throws Exception {
        server.on("DELETE", "/v1/bans/u", (req, ex) -> FakeServer.json(ex, 404, """
                {"code":"not_found","status":404,"message":"none","details":{"reason":"not_active"}}"""));
        server.on("DELETE", "/v1/groups/missing/members/u/ban", (req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no group")));
        assertTrue(failure(client.bans().remove("u")).isNotActive());
        assertFalse(failure(client.groups().unban("missing", "u")).isNotActive());
    }

    @Test
    void nonEnvelopeErrorIsUnknownWithTransportStatus() throws Exception {
        server.on("GET", "/v1/roles/r1", (req, ex) -> {
            ex.sendResponseHeaders(418, 5);
            ex.getResponseBody().write("teapo".getBytes());
        });
        JunjoException e = failure(client.roles().get("r1"));
        assertEquals("unknown", e.code());
        assertEquals(418, e.status());
    }

    @Test
    void notFoundReadsAsEmpty() throws Exception {
        server.on("GET", "/v1/bans/u1", (req, ex) -> FakeServer.json(ex, 404, FakeServer.error("not_found",
                404, "no")));
        assertTrue(join(client.bans().get("u1")).isEmpty());
    }

    @Test
    void getRetriesOn5xxThenSucceeds() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("GET", "/v1/events/position", (req, ex) -> {
            if (calls.incrementAndGet() < 3) FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down"));
            else FakeServer.json(ex, 200, "{\"position\":\"42\"}");
        });
        assertEquals("42", join(client.events().position()));
        assertEquals(3, calls.get());
    }

    @Test
    void getGivesUpAfterMaxAttempts() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("GET", "/v1/events/position", (req, ex) -> {
            calls.incrementAndGet();
            FakeServer.json(ex, 500, FakeServer.error("internal", 500, "boom"));
        });
        JunjoException e = failure(client.events().position());
        assertEquals("internal", e.code());
        assertEquals(3, calls.get());
    }

    @Test
    void retryAfterIsHonoured() throws Exception {
        List<Long> at = new ArrayList<>();
        server.on("GET", "/v1/events/position", (req, ex) -> {
            synchronized (at) {
                at.add(System.nanoTime());
            }
            if (at.size() == 1) {
                FakeServer.json(ex, 429, FakeServer.error("rate_limit_exceeded", 429, "slow"),
                        Map.of("Retry-After", "1"));
            } else {
                FakeServer.json(ex, 200, "{\"position\":\"1\"}");
            }
        });
        assertEquals("1", join(client.events().position()));
        long waitedMs = (at.get(1) - at.get(0)) / 1_000_000;
        assertTrue(waitedMs >= 900, "waited " + waitedMs + " ms");
    }

    @Test
    void retryAfterBeyondTheCapFailsAtOnce() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("GET", "/v1/events/position", (req, ex) -> {
            calls.incrementAndGet();
            FakeServer.json(ex, 429, FakeServer.error("rate_limit_exceeded", 429, "slow"),
                    Map.of("Retry-After", "120"));
        });
        JunjoException e = failure(client.events().position());
        assertEquals("rate_limit_exceeded", e.code());
        assertEquals(120, e.retryAfterSeconds().orElseThrow());
        assertEquals(1, calls.get());
    }

    @Test
    void writeWithoutKeyIsNotRetriedButKeyedWriteIs() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("POST", "/v1/bans", (req, ex) -> {
            if (calls.incrementAndGet() <= 2) FakeServer.json(ex, 502, FakeServer.error("internal", 502, "x"));
            else FakeServer.json(ex, 201, """
                    {"id":"b","gameId":"gm","userId":"u","bannedAt":"2026-11-01T00:00:00Z","expiresAt":null,
                     "reason":null,"bannedBy":null,"issuer":"staff","version":4}""");
        });
        CreateBanInput input = CreateBanInput.builder("u").bannedAt(Instant.parse("2026-01-01T00:00:00Z"))
                .issuer("staff").build();
        JunjoException e = failure(client.bans().add(input));
        assertEquals(502, e.status());
        assertEquals(1, calls.get());

        Ban ban = join(client.bans().add(input, WriteOptions.idempotent("k-2")));
        assertEquals(3, calls.get());
        assertEquals("staff", ban.issuer());
        assertEquals(4, ban.version());
        List<FakeServer.Req> sent = server.requests("POST", "/v1/bans");
        assertEquals("k-2", sent.get(1).header("Idempotency-Key"));
        assertEquals("k-2", sent.get(2).header("Idempotency-Key"));
        JsonObject body = JsonParser.parseString(sent.get(2).body()).getAsJsonObject();
        assertEquals("2026-01-01T00:00:00Z", body.get("bannedAt").getAsString());
    }

    @Test
    void idempotencyKeyInProgressIsRetried() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("DELETE", "/v1/bans/u", (req, ex) -> {
            if (calls.incrementAndGet() == 1) {
                FakeServer.json(ex, 409, FakeServer.error("idempotency_key_in_progress", 409, "busy"),
                        Map.of("Retry-After", "0"));
            } else {
                FakeServer.json(ex, 204, "");
            }
        });
        join(client.bans().remove("u", null, WriteOptions.idempotent("k")));
        assertEquals(2, calls.get());
    }

    @Test
    void requestTimeoutCoversAStalledBody() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        server.on("GET", "/v1/events/position", (req, ex) -> {
            ex.sendResponseHeaders(200, 100);
            ex.getResponseBody().write("{\"pos".getBytes());
            ex.getResponseBody().flush();
            release.await(10, TimeUnit.SECONDS);
        });
        try (JunjoClient c = JunjoClient.builder().baseUrl(server.baseUrl()).apiKey("k")
                .requestTimeout(Duration.ofMillis(300)).retryPolicy(RetryPolicy.none()).build()) {
            long start = System.nanoTime();
            JunjoException e = failure(c.events().position());
            assertEquals(JunjoException.TIMEOUT, e.code());
            assertTrue((System.nanoTime() - start) / 1_000_000 < 5_000);
        } finally {
            release.countDown();
        }
    }

    @Test
    void connectionRefusedIsNetworkError() throws Exception {
        int port;
        try (ServerSocket s = new ServerSocket(0)) {
            port = s.getLocalPort();
        }
        try (JunjoClient c = JunjoClient.builder().baseUrl("http://127.0.0.1:" + port).apiKey("k")
                .retryPolicy(RetryPolicy.none()).build()) {
            JunjoException e = failure(c.events().position());
            assertEquals(JunjoException.NETWORK_ERROR, e.code());
            assertEquals(0, e.status());
        }
    }

    @Test
    void closeCancelsPendingCalls() throws Exception {
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch arrived = new CountDownLatch(1);
        server.on("GET", "/v1/events/position", (req, ex) -> {
            arrived.countDown();
            release.await(10, TimeUnit.SECONDS);
            FakeServer.json(ex, 200, "{\"position\":\"1\"}");
        });
        JunjoClient c = client(RetryPolicy.none());
        CompletableFuture<String> f = c.events().position();
        assertTrue(arrived.await(5, TimeUnit.SECONDS));
        c.close();
        JunjoException e = failure(f);
        assertEquals(JunjoException.CANCELLED, e.code());
        release.countDown();
        assertTrue(c.isClosed());
        assertEquals(JunjoException.CANCELLED, failure(c.events().position()).code());
    }

    @Test
    void malformedJsonIsInvalidWireData() throws Exception {
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, "{\"groupId\":"));
        JunjoException e = failure(client.roles().getGraph("g1"));
        assertEquals(JunjoException.INVALID_WIRE_DATA, e.code());
    }

    @Test
    void readsExposePositionAndEtag() throws Exception {
        server.on("GET", "/v1/groups/g1/role-graph", (req, ex) -> FakeServer.json(ex, 200, """
                {"groupId":"g1","mode":"nodes","defaultRoleId":"r0","roles":[{"id":"r0","groupId":"g1",
                 "name":"Default","priority":0,"color":null,"isDefault":true,"permissions":["a"],
                 "entries":[{"permission":"a","value":true},{"permission":"b","value":false}],
                 "parents":[],"metadata":{},"createdAt":"2026-11-01T00:00:00.000Z"}]}""",
                Map.of("Junjo-Stream-Position", "77")));
        server.on("GET", "/v1/users/ns%3Au/moderation", (req, ex) -> FakeServer.json(ex, 200,
                "{\"userId\":\"ns:u\",\"version\":3,\"ban\":null}", Map.of("ETag", "\"3\"")));
        JunjoResponse<RoleGraph> g = join(client.roles().getGraph("g1"));
        assertEquals("77", g.streamPosition());
        assertNull(g.etag());
        assertEquals(1, g.value().roles().get(0).entries().stream().filter(PermissionEntry::value).count());
        JunjoResponse<Moderation> m = join(client.bans().moderation("ns:u"));
        assertEquals("\"3\"", m.etag());
        assertEquals(3, m.value().version());
        assertTrue(m.value().currentBan().isEmpty());
    }

    @Test
    void everyPagedListReturnsAResponseWithItsPosition() throws Exception {
        server.on("GET", "/v1/groups/g1/members", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + MEMBER_JSON + "],\"nextCursor\":\"c2\"}", Map.of("Junjo-Stream-Position", "5")));
        server.on("GET", "/v1/groups", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + GROUP_JSON + "],\"nextCursor\":null}", Map.of("Junjo-Stream-Position", "6")));
        JunjoResponse<Page<Member>> page = join(client.members().list("g1",
                new ListMembersOptions(50, "c1", List.of(MemberStatus.ACTIVE, MemberStatus.BANNED))));
        assertEquals("limit=50&cursor=c1&status=active%2Cbanned", server.requests.get(0).query());
        assertEquals("c2", page.value().nextCursor());
        assertEquals("5", page.streamPosition());
        JunjoResponse<Page<Group>> groups = join(client.groups().list(new ListGroupsOptions(10, null, "party", null)));
        assertEquals("limit=10&kind=party", server.requests.get(1).query());
        assertEquals("6", groups.streamPosition());
        assertFalse(groups.value().hasMore());
    }

    @Test
    void getAccessManyIsAlignedWithTheRequestAndCarriesMetadata() throws Exception {
        server.on("POST", "/v1/groups/g1/members/access", (req, ex) -> FakeServer.json(ex, 200, """
                {"items":[{"groupId":"g1","userId":"ns:main","status":"active","roleIds":["r"],"overrides":[],
                 "version":3,"metadata":{"prefix":"[A]"}},null]}""", Map.of("Junjo-Stream-Position", "9")));
        JunjoResponse<List<Optional<MemberAccess>>> r = join(client.members().getAccessMany("g1",
                List.of("ns:alt", "ns:x")));
        assertEquals("{\"userIds\":[\"ns:alt\",\"ns:x\"]}", server.requests.get(0).body());
        assertEquals("9", r.streamPosition());
        assertEquals("ns:main", r.value().get(0).orElseThrow().userId(), "the access names the rendered id");
        assertEquals("[A]", r.value().get(0).orElseThrow().metadata().get("prefix"));
        assertTrue(r.value().get(1).isEmpty());
        assertThrows(IllegalArgumentException.class, () -> client.members().getAccessMany("g1", List.of()));
        assertEquals(1, server.requests.size());
    }

    @Test
    void checkBatchSplitsAtTheServerCap() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("POST", "/v1/permissions/check-batch", (req, ex) -> {
            calls.incrementAndGet();
            int n = JsonParser.parseString(req.body()).getAsJsonObject().getAsJsonArray("checks").size();
            StringBuilder sb = new StringBuilder("{\"results\":[");
            for (int i = 0; i < n; i++) {
                if (i > 0) sb.append(',');
                sb.append("{\"allowed\":true,\"source\":\"role\",\"viaRoleId\":\"r\"}");
            }
            FakeServer.json(ex, 200, sb.append("]}").toString());
        });
        List<PermissionCheckRequest> checks = new ArrayList<>();
        for (int i = 0; i < 150; i++) checks.add(new PermissionCheckRequest("u" + i, "g", "p"));
        List<PermissionCheckResult> results = join(client.permissions().checkBatch(checks));
        assertEquals(150, results.size());
        assertEquals(2, calls.get());
        assertEquals(PermissionSource.ROLE, results.get(149).source());
    }

    @Test
    void checkSendsQuery() throws Exception {
        server.on("GET", "/v1/permissions/check", (req, ex) -> FakeServer.json(ex, 200,
                "{\"allowed\":false,\"source\":\"none\"}"));
        PermissionCheckResult r = join(client.permissions().check("ns:u", "g1", "a.b", true));
        assertEquals("userId=ns%3Au&groupId=g1&permission=a.b&inherit=true", server.requests.get(0).query());
        assertEquals(PermissionSource.NONE, r.source());
        assertNull(r.viaRoleId());
    }

    @Test
    void joinWrapsTheSdkError() {
        server.on("GET", "/v1/events/position", (req, ex) -> FakeServer.json(ex, 401,
                FakeServer.error("invalid_api_key", 401, "bad key")));
        CompletionException e = assertThrows(CompletionException.class, () -> client.events().position().join());
        JunjoException je = assertInstanceOf(JunjoException.class, e.getCause());
        assertEquals("invalid_api_key", je.code());
        assertNotNull(je.getMessage());
    }

    @Test
    void builderValidates() {
        assertThrows(IllegalStateException.class, () -> JunjoClient.builder().apiKey("k").build());
        assertThrows(IllegalArgumentException.class,
                () -> JunjoClient.builder().baseUrl("ftp://x").apiKey("k").build());
        assertThrows(IllegalArgumentException.class, () -> WriteOptions.idempotent("has space"));
    }
}
