package io.junjo.sdk.export;

import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.model.Context;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.SequenceInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(60)
class ExportTest {
    static final String HEADER = """
            {"kind":"header","format":"junjo-export","version":1,"gameId":"gm",\
            "exportedAt":"2026-11-09T12:00:00.000Z","position":"42"}""";

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

    static ExportReader reader(String body) {
        return new ExportReader(new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
    }

    static List<ExportRecord> drain(ExportReader r) {
        List<ExportRecord> out = new ArrayList<>();
        while (r.hasNext()) out.add(r.next());
        return out;
    }

    @Test
    void readerValidatesHeaderEndAndCounts() {
        String ok = HEADER + """

                {"kind":"game","id":"gm"}
                {"kind":"group","id":"g1","groupKind":"party"}
                {"kind":"group","id":"g2","groupKind":"party"}
                {"kind":"end","counts":{"game":1,"group":2,"person":0}}""";
        ExportReader r = reader(ok);
        List<ExportRecord> records = drain(r);
        assertEquals(5, records.size(), "a final line without a newline still counts");
        assertEquals("party", records.get(2).get("groupKind"));
        ExportSummary s = r.summary();
        assertEquals("42", s.position());
        assertEquals(2L, s.counts().get("group"));
        assertEquals("gm", r.header().get("gameId"));
    }

    @Test
    void contextualEntriesAndOverridesKeepTheirContext() {
        String body = HEADER + """

                {"kind":"role","id":"r1","entries":[{"permission":"fly","value":false},                {"permission":"fly","value":true,"context":{"world":"creative"}}]}
                {"kind":"member","id":"m1","overrides":[{"permission":"chat","value":false,"context":{"world":"hub"},                "setAt":"2026-11-01T00:00:00Z","setByPersonId":null}]}
                {"kind":"end","counts":{"role":1,"member":1}}
                """;
        List<ExportRecord> records = drain(reader(body));
        List<?> entries = (List<?>) records.get(1).get("entries");
        assertEquals(Context.GLOBAL, ExportRecord.context(entries.get(0)));
        assertEquals(Context.of("world", "creative"), ExportRecord.context(entries.get(1)));
        List<?> overrides = (List<?>) records.get(2).get("overrides");
        assertEquals(Context.of("world", "hub"), ExportRecord.context(overrides.get(0)));
        assertEquals(Context.GLOBAL, ExportRecord.context("not an object"));
    }

    @Test
    void readerRejectsCutShortAndInconsistentFiles() {
        JunjoException cut = assertThrows(JunjoException.class,
                () -> drain(reader(HEADER + "\n{\"kind\":\"game\",\"id\":\"gm\"}\n")));
        assertEquals(JunjoException.INVALID_WIRE_DATA, cut.code());
        assertThrows(JunjoException.class,
                () -> drain(reader(HEADER + "\n{\"kind\":\"game\"}\n{\"kind\":\"end\",\"counts\":{\"game\":2}}\n")));
        assertThrows(JunjoException.class,
                () -> drain(reader(HEADER + "\n{\"kind\":\"end\",\"counts\":{}}\n{\"kind\":\"game\"}\n")));
        assertThrows(JunjoException.class, () -> drain(reader("{\"kind\":\"game\"}\n")));
        assertThrows(JunjoException.class, () -> drain(reader(HEADER.replace("\"version\":1",
                "\"version\":2") + "\n")));
        assertThrows(JunjoException.class, () -> drain(reader(HEADER + "\nnot json\n")));
    }

    @Test
    void aLinePastTheCapFailsWithStreamOverflow() {
        // The reader must fail before buffering past the cap, so the body is never all in memory.
        InputStream endless = new InputStream() {
            @Override
            public int read() {
                return 'x';
            }

            @Override
            public int read(byte[] b, int off, int len) {
                java.util.Arrays.fill(b, off, off + len, (byte) 'x');
                return len;
            }
        };
        InputStream body = new SequenceInputStream(
                new ByteArrayInputStream((HEADER + "\n{\"kind\":\"game\",\"id\":\"").getBytes(StandardCharsets.UTF_8)),
                endless);
        ExportReader r = new ExportReader(body);
        r.next();
        JunjoException e = assertThrows(JunjoException.class, r::hasNext);
        assertEquals(JunjoException.STREAM_OVERFLOW, e.code());
    }

    @Test
    void streamsFromTheServerToAConsumer() throws Exception {
        server.on("GET", "/v1/export", (req, ex) -> {
            ex.getResponseHeaders().set("Content-Type", "application/x-ndjson");
            ex.sendResponseHeaders(200, 0);
            OutputStream out = ex.getResponseBody();
            FakeServer.write(out, HEADER + "\n");
            for (int i = 0; i < 500; i++) {
                FakeServer.write(out, "{\"kind\":\"person\",\"id\":\"p" + i + "\",\"identities\":[]}\n");
            }
            FakeServer.write(out, "{\"kind\":\"end\",\"counts\":{\"person\":500}}\n");
        });
        List<String> kinds = new CopyOnWriteArrayList<>();
        ExportSummary s = join(client.export().read(r -> kinds.add(r.kind())));
        assertEquals(502, kinds.size());
        assertEquals("header", kinds.get(0));
        assertEquals("end", kinds.get(501));
        assertEquals(500L, s.counts().get("person"));
        assertEquals("application/x-ndjson", server.requests.get(0).header("Accept"));
    }

    @Test
    void withoutPermissionTheReadFails() throws Exception {
        server.on("GET", "/v1/export", (req, ex) ->
                FakeServer.json(ex, 403, FakeServer.error("permission_denied", 403, "no canExport")));
        assertEquals("permission_denied", failure(client.export().read(r -> { })).code());
    }

    @Test
    void aCutShortExportFailsTheRead() throws Exception {
        server.on("GET", "/v1/export", (req, ex) -> {
            ex.sendResponseHeaders(200, 0);
            FakeServer.write(ex.getResponseBody(), HEADER + "\n{\"kind\":\"game\",\"id\":\"gm\"}\n");
        });
        assertEquals(JunjoException.INVALID_WIRE_DATA, failure(client.export().read(r -> { })).code());
    }
}
