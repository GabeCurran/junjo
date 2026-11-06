package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.ListSanctionsOptions;
import io.junjo.sdk.model.Moderation;
import io.junjo.sdk.model.Page;
import io.junjo.sdk.model.Sanction;
import io.junjo.sdk.model.SanctionHistoryEntry;
import io.junjo.sdk.queue.QueuedWrite;
import io.junjo.sdk.queue.WriteQueue;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

@Timeout(30)
class SanctionsTest {
    static final String SANCTION = """
            {"id":"s1","userId":"ns:u","type":"mute","reason":"spam","issuer":"Console","issuedBy":"ns:mod",
             "startedAt":"2026-11-09T12:00:00.000Z","expiresAt":"2026-11-09T13:00:00.000Z","version":4}""";

    @TempDir
    Path dir;

    FakeServer server;
    JunjoClient client;

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        client = TestSupport.client(server.baseUrl());
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.close();
    }

    @Test
    void addSendsTheBodyAndSafeWriteHeaders() throws Exception {
        server.on("POST", "/v1/sanctions", (req, ex) -> FakeServer.json(ex, 201, SANCTION, Map.of("ETag", "\"4\"")));
        AddSanctionInput input = AddSanctionInput.builder("ns:u", "mute")
                .reason("spam")
                .expiresAt(Instant.parse("2026-11-09T13:00:00Z"))
                .startedAt(Instant.parse("2026-11-09T12:00:00Z"))
                .issuer("Console")
                .actorUserId("ns:mod")
                .build();
        Sanction s = join(client.sanctions().add(input, WriteOptions.idempotent("k1").withIfMatch(3)));
        assertEquals("mute", s.type());
        assertEquals("ns:mod", s.issuedBy());
        assertEquals(4, s.version());
        assertTrue(s.isActiveAt(Instant.parse("2026-11-09T12:30:00Z")));
        assertFalse(s.isActiveAt(Instant.parse("2026-11-09T13:00:00Z")));
        FakeServer.Req req = server.requests.get(0);
        assertEquals("k1", req.header("Idempotency-Key"));
        assertEquals("\"3\"", req.header("If-Match"));
        JsonObject body = JsonParser.parseString(req.body()).getAsJsonObject();
        assertEquals("mute", body.get("type").getAsString());
        assertEquals("2026-11-09T12:00:00Z", body.get("startedAt").getAsString());
        assertEquals("Console", body.get("issuer").getAsString());
    }

    @Test
    void typesAreValidatedLocally() {
        assertThrows(IllegalArgumentException.class, () -> AddSanctionInput.builder("u", "ban"));
        assertThrows(IllegalArgumentException.class, () -> AddSanctionInput.builder("u", "Mute"));
        assertThrows(IllegalArgumentException.class, () -> AddSanctionInput.builder("u", "_x"));
        assertTrue(AddSanctionInput.isValidType("trade.lock"));
        assertTrue(AddSanctionInput.isValidType("voice-ban"));
    }

    @Test
    void removeEncodesThePathAndSendsTheActor() throws Exception {
        server.on("DELETE", "/v1/sanctions/ns%3Au/trade.lock", (req, ex) -> FakeServer.json(ex, 204, ""));
        join(client.sanctions().remove("ns:u", "trade.lock", "ns:mod", WriteOptions.none().withIfMatch(4)));
        FakeServer.Req req = server.requests.get(0);
        assertEquals("{\"actorUserId\":\"ns:mod\"}", req.body());
        assertEquals("\"4\"", req.header("If-Match"));
    }

    @Test
    void readsExposePositionEtagAndHistory() throws Exception {
        server.on("GET", "/v1/sanctions", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + SANCTION + "],\"nextCursor\":\"c\"}", Map.of("Junjo-Stream-Position", "12")));
        server.on("GET", "/v1/users/ns%3Au/sanctions", (req, ex) -> FakeServer.json(ex, 200,
                "{\"items\":[" + SANCTION + "]}", Map.of("ETag", "\"4\"")));
        server.on("GET", "/v1/users/ns%3Au/sanctions/history", (req, ex) -> FakeServer.json(ex, 200, """
                {"items":[{"id":"h","gameId":"gm","userId":"ns:u","type":"mute","kind":"lifted","reason":null,
                 "expiresAt":null,"eventAt":"2026-11-09T12:30:00.000Z","actorUserId":"ns:mod","issuer":null}],
                 "nextCursor":null}""", Map.of("Junjo-Stream-Position", "13")));
        JunjoResponse<Page<Sanction>> page = join(client.sanctions().list(new ListSanctionsOptions("mute", 10, null)));
        assertEquals("type=mute&limit=10", server.requests.get(0).query());
        assertEquals("12", page.streamPosition());
        assertEquals("c", page.value().nextCursor());
        JunjoResponse<List<Sanction>> mine = join(client.sanctions().forUser("ns:u"));
        assertEquals("\"4\"", mine.etag());
        assertEquals(1, mine.value().size());
        JunjoResponse<Page<SanctionHistoryEntry>> history = join(client.sanctions().history("ns:u", null));
        assertEquals("13", history.streamPosition());
        assertEquals("lifted", history.value().items().get(0).kind());
        assertEquals("ns:mod", history.value().items().get(0).actorUserId());
    }

    @Test
    void moderationIncludesSanctions() throws Exception {
        server.on("GET", "/v1/users/ns%3Au/moderation", (req, ex) -> FakeServer.json(ex, 200,
                "{\"userId\":\"ns:u\",\"version\":4,\"ban\":null,\"sanctions\":[" + SANCTION + "]}"));
        Moderation m = join(client.bans().moderation("ns:u")).value();
        assertEquals(1, m.sanctions().size());
        assertEquals("mute", m.sanctions().get(0).type());
    }

    @Test
    void queuedLiftTreatsNotActiveAsSuccessAndPlainNotFoundAsRejection() throws Exception {
        server.on("POST", "/v1/sanctions", (req, ex) -> FakeServer.json(ex, 201, SANCTION));
        server.on("DELETE", "/v1/sanctions/ns%3Au/mute", (req, ex) -> FakeServer.json(ex, 404, """
                {"code":"not_found","status":404,"message":"none","details":{"reason":"not_active"}}"""));
        server.on("DELETE", "/v1/sanctions/ns%3Au/voice", (req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "other")));
        List<WriteQueue.Outcome> ok = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> rejected = new CopyOnWriteArrayList<>();
        try (WriteQueue q = WriteQueue.builder(client, dir.resolve("q.jsonl")).onSuccess(ok::add)
                .onRejected(rejected::add).open()) {
            q.enqueue(QueuedWrite.addSanction(AddSanctionInput.builder("ns:u", "mute").build()).ifMatch(3));
            q.enqueue(QueuedWrite.removeSanction("ns:u", "mute", "ns:mod"));
            q.enqueue(QueuedWrite.removeSanction("ns:u", "voice", null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
        }
        assertEquals(List.of("add sanction", "remove sanction"),
                ok.stream().map(o -> o.entry().write().label()).toList());
        assertEquals(1, rejected.size());
        assertEquals("\"3\"", server.requests.get(0).header("If-Match"));
    }
}
