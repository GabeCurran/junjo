package io.junjo.sdk.queue;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.JunjoLogger;
import io.junjo.sdk.internal.DurableFiles;
import io.junjo.sdk.model.CreateBanInput;
import io.junjo.sdk.model.SetMemberNotesInput;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;

@Timeout(30)
class WriteQueueTest {
    static final String MEMBER = """
            {"id":"m","groupId":"g","userId":"u","status":"active","roles":[],"metadata":{},"notesPublic":null,
             "notesPrivate":null,"joinedAt":"2026-11-01T00:00:00Z","bannedUntil":null,"version":2}""";
    static final String NOT_ACTIVE = """
            {"code":"not_found","status":404,"message":"no active ban","details":{"reason":"not_active"}}""";

    @TempDir
    Path dir;

    FakeServer server;
    JunjoClient client;
    final List<String> errorLogs = new CopyOnWriteArrayList<>();
    final List<WriteQueue.Outcome> successes = new CopyOnWriteArrayList<>();
    final List<WriteQueue.Outcome> conflicts = new CopyOnWriteArrayList<>();
    final List<WriteQueue.Outcome> rejections = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        client = JunjoClient.builder().baseUrl(server.baseUrl()).apiKey("k").requestTimeout(Duration.ofSeconds(5))
                .logger((level, message, error) -> {
                    if (level == JunjoLogger.Level.ERROR) errorLogs.add(message);
                })
                .build();
    }

    @AfterEach
    void tearDown() {
        client.close();
        server.close();
    }

    WriteQueue.Builder queue(Path journal) {
        return WriteQueue.builder(client, journal)
                .retryBackoff(Duration.ofMillis(10), Duration.ofMillis(40))
                .closeTimeout(Duration.ofSeconds(2))
                .onSuccess(successes::add)
                .onConflict(conflicts::add)
                .onRejected(rejections::add);
    }

    static List<JsonObject> deadLetters(WriteQueue q) throws IOException {
        return deadLetters(q.deadLetterFile());
    }

    static List<JsonObject> deadLetters(Path file) throws IOException {
        List<JsonObject> out = new ArrayList<>();
        if (!Files.exists(file)) return out;
        for (String line : Files.readAllLines(file)) out.add(JsonParser.parseString(line).getAsJsonObject());
        return out;
    }

    @Test
    void drainsInOrderWithIdempotencyKeysAndIfMatch() throws Exception {
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        server.onPrefix("PATCH", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        try (WriteQueue q = queue(dir.resolve("q.jsonl")).open()) {
            List<WriteQueue.Entry> entries = new ArrayList<>();
            for (int i = 0; i < 5; i++) entries.add(q.enqueue(QueuedWrite.assignRole("g", "u", "r" + i, null)));
            entries.add(q.enqueue(QueuedWrite.setNotes("g", "u",
                    SetMemberNotesInput.builder().notesPrivate("n").build())
                    .ifMatch(2)));
            assertTrue(q.flush(Duration.ofSeconds(10)));
            assertEquals(6, successes.size());
            List<FakeServer.Req> sent = server.requests;
            for (int i = 0; i < 5; i++) {
                assertEquals("/v1/groups/g/members/u/roles/r" + i, sent.get(i).path(), "sent in enqueue order");
                assertEquals(entries.get(i).idempotencyKey(), sent.get(i).header("Idempotency-Key"));
                assertNull(sent.get(i).header("If-Match"));
            }
            assertEquals("\"2\"", sent.get(5).header("If-Match"));
            assertEquals("PATCH", sent.get(5).method());
            assertEquals(0, q.size());
            assertFalse(Files.exists(q.deadLetterFile()), "nothing was refused");
        }
    }

    @Test
    void refusedEntriesReachTheDeadLetterFileBeforeAnyCallback() throws Exception {
        server.on("POST", "/v1/groups/g/members/u/roles/a", (req, ex) ->
                FakeServer.json(ex, 412, FakeServer.error("precondition_failed", 412, "stale")));
        server.on("POST", "/v1/groups/g/members/u/kick", (req, ex) ->
                FakeServer.json(ex, 400, FakeServer.error("bad_request", 400, "bad")));
        server.on("POST", "/v1/groups/g/members/u/roles/b", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        Path journal = dir.resolve("q.jsonl");
        List<Integer> deadAtCallback = new CopyOnWriteArrayList<>();
        try (WriteQueue q = WriteQueue.builder(client, journal)
                .onConflict(o -> {
                    try {
                        deadAtCallback.add(deadLetters(dir.resolve("q.jsonl.dead")).size());
                    } catch (IOException e) {
                        throw new IllegalStateException(e);
                    }
                    throw new IllegalStateException("a throwing callback loses nothing");
                })
                .open()) {
            q.enqueue(QueuedWrite.assignRole("g", "u", "a", null).ifMatch(1));
            q.enqueue(QueuedWrite.kick("g", "u", "x"));
            q.enqueue(QueuedWrite.assignRole("g", "u", "b", null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
            List<JsonObject> dead = deadLetters(q);
            assertEquals(2, dead.size());
            assertEquals("conflict", dead.get(0).get("reason").getAsString());
            assertEquals(412, dead.get(0).get("status").getAsInt());
            assertTrue(dead.get(0).get("response").getAsString().contains("precondition_failed"));
            assertEquals("/v1/groups/g/members/u/roles/a",
                    dead.get(0).getAsJsonObject("entry").get("path").getAsString());
            assertEquals("rejected", dead.get(1).get("reason").getAsString());
            assertEquals(400, dead.get(1).get("status").getAsInt());
        }
        assertEquals(List.of(1), deadAtCallback, "the dead letter was on disk when the callback ran");
        assertEquals(1, server.requests("POST", "/v1/groups/g/members/u/roles/a").size(), "a conflict is not retried");
        assertEquals(1, server.requests("POST", "/v1/groups/g/members/u/kick").size(), "a rejection is not retried");
    }

    @Test
    void liftOfAnInactiveBanCountsAsSuccess() throws Exception {
        server.on("DELETE", "/v1/bans/ns%3Au", (req, ex) -> FakeServer.json(ex, 404, NOT_ACTIVE));
        server.on("DELETE", "/v1/groups/g/members/ns%3Au/ban", (req, ex) -> FakeServer.json(ex, 404, NOT_ACTIVE));
        try (WriteQueue q = queue(dir.resolve("q.jsonl")).open()) {
            q.enqueue(QueuedWrite.removeBan("ns:u", "ns:mod"));
            q.enqueue(QueuedWrite.groupUnban("g", "ns:u", null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
        }
        assertEquals(2, successes.size());
        assertTrue(rejections.isEmpty());
    }

    @Test
    void plainNotFoundOnALiftIsStillARejection() throws Exception {
        server.on("DELETE", "/v1/groups/missing/members/ns%3Au/ban", (req, ex) ->
                FakeServer.json(ex, 404, FakeServer.error("not_found", 404, "no group")));
        server.on("POST", "/v1/groups/g/members/ns%3Au/kick", (req, ex) -> FakeServer.json(ex, 404, NOT_ACTIVE));
        try (WriteQueue q = queue(dir.resolve("q.jsonl")).open()) {
            q.enqueue(QueuedWrite.groupUnban("missing", "ns:u", null));
            q.enqueue(QueuedWrite.kick("g", "ns:u", null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
        }
        assertEquals(2, rejections.size(), "the not_active rule applies to lifts only");
        assertTrue(successes.isEmpty());
    }

    @Test
    void transientFailuresRetryTheHeadWithTheSameKeyAndHoldBackLaterEntries() throws Exception {
        AtomicInteger calls = new AtomicInteger();
        server.on("POST", "/v1/bans", (req, ex) -> {
            int n = calls.incrementAndGet();
            if (n == 1) FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down"));
            else if (n == 2) FakeServer.json(ex, 429, FakeServer.error("rate_limit_exceeded", 429, "slow"),
                    Map.of("Retry-After", "0"));
            else if (n == 3) FakeServer.json(ex, 409, FakeServer.error("idempotency_key_in_progress", 409, "busy"));
            else FakeServer.json(ex, 201, "{}");
        });
        server.on("DELETE", "/v1/bans/b", (req, ex) -> FakeServer.json(ex, 204, ""));
        try (WriteQueue q = queue(dir.resolve("q.jsonl")).open()) {
            WriteQueue.Entry first = q.enqueue(QueuedWrite.addBan(CreateBanInput.builder("a").build()));
            q.enqueue(QueuedWrite.removeBan("b", null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
            List<FakeServer.Req> bans = server.requests("POST", "/v1/bans");
            assertEquals(4, bans.size());
            for (FakeServer.Req r : bans) assertEquals(first.idempotencyKey(), r.header("Idempotency-Key"));
            int lastBan = server.requests.indexOf(bans.get(3));
            int unban = server.requests.indexOf(server.requests("DELETE", "/v1/bans/b").get(0));
            assertTrue(unban > lastBan, "a later entry waits for the head");
        }
        assertEquals(2, successes.size());
    }

    @Test
    void survivesACrashAndResendsWithTheSameKeys() throws Exception {
        Path journal = dir.resolve("nested").resolve("q.jsonl");
        AtomicInteger step = new AtomicInteger(1);
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> {
            if (step.get() == 1) FakeServer.json(ex, 503, FakeServer.error("internal", 503, "down"));
            else FakeServer.json(ex, 200, MEMBER);
        });
        List<WriteQueue.Entry> entries = new ArrayList<>();
        WriteQueue q1 = queue(journal).retryBackoff(Duration.ofMillis(50), Duration.ofMillis(100)).open();
        for (int i = 0; i < 3; i++) entries.add(q1.enqueue(QueuedWrite.assignRole("g", "u", "r" + i, null)));
        assertFalse(q1.close(Duration.ofMillis(300)), "nothing could be delivered");
        assertThrows(IllegalStateException.class, () -> q1.enqueue(QueuedWrite.kick("g", "u", null)));

        // A crash mid-append leaves a torn final line.
        Files.writeString(journal, "0badc0de {\"op\":\"put\",\"id\":\"torn", StandardCharsets.UTF_8,
                StandardOpenOption.APPEND);

        step.set(2);
        server.requests.clear();
        try (WriteQueue q2 = queue(journal).open()) {
            assertTrue(q2.flush(Duration.ofSeconds(10)));
            List<JsonObject> dead = deadLetters(q2);
            assertEquals(1, dead.size());
            assertEquals("torn_line", dead.get(0).get("reason").getAsString());
        }
        assertEquals(3, successes.size());
        List<FakeServer.Req> sent = server.requests;
        assertEquals(3, sent.size());
        for (int i = 0; i < 3; i++) {
            assertEquals("/v1/groups/g/members/u/roles/r" + i, sent.get(i).path());
            assertEquals(entries.get(i).idempotencyKey(), sent.get(i).header("Idempotency-Key"));
        }

        server.requests.clear();
        try (WriteQueue q3 = queue(journal).open()) {
            assertEquals(0, q3.size());
        }
        assertTrue(server.requests.isEmpty(), "everything finished, so a third open has nothing to send");
    }

    @Test
    void aLineThatFailsItsChecksumIsQuarantinedNotMisread() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 503,
                FakeServer.error("internal", 503, "x")));
        WriteQueue q1 = queue(journal).open();
        q1.enqueue(QueuedWrite.assignRole("g", "u", "kept", null));
        q1.enqueue(QueuedWrite.assignRole("g", "u", "damaged", null));
        q1.close(Duration.ofMillis(100));

        // Bit rot in the second entry: the path changes but the line stays valid JSON.
        List<String> lines = Files.readAllLines(journal);
        assertTrue(lines.get(1).matches("^[0-9a-f]{8} \\{.*"), "lines carry a checksum");
        lines.set(1, lines.get(1).replace("damaged", "damagex"));
        Files.write(journal, lines);

        server.requests.clear();
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        try (WriteQueue q2 = queue(journal).open()) {
            assertEquals(1, q2.size());
            assertTrue(q2.flush(Duration.ofSeconds(10)));
            List<JsonObject> dead = deadLetters(q2);
            assertEquals(1, dead.size());
            assertEquals("checksum_mismatch", dead.get(0).get("reason").getAsString());
            assertTrue(dead.get(0).get("line").getAsString().contains("damagex"));
        }
        assertEquals(1, server.requests.size());
        assertEquals("/v1/groups/g/members/u/roles/kept", server.requests.get(0).path());
        assertFalse(errorLogs.isEmpty(), "the quarantine is logged at ERROR");
    }

    @Test
    void journalsWrittenBeforeChecksumsAreStillReplayed() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        Files.writeString(journal, """
                {"op":"put","id":"e1","key":"k1","method":"POST","path":"/v1/groups/g/members/u/roles/r","body":null,\
                "ifMatch":null,"lift":false,"label":"assign role","at":"2026-11-01T00:00:00Z"}
                """);
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        try (WriteQueue q = queue(journal).open()) {
            assertTrue(q.flush(Duration.ofSeconds(10)));
        }
        assertEquals("k1", server.requests.get(0).header("Idempotency-Key"));
        assertTrue(Files.readAllLines(journal).stream().allMatch(l -> l.matches("^[0-9a-f]{8} \\{.*")),
                "compaction rewrote the journal with checksums");
    }

    @Test
    void aFailedForceFailsTheEnqueueAndLeavesNothingToReplay() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        AtomicBoolean failNext = new AtomicBoolean();
        DurableFiles.Disk flaky = channel -> {
            if (failNext.getAndSet(false)) throw new IOException("disk full");
            channel.force(true);
        };
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 503,
                FakeServer.error("internal", 503, "x")));
        WriteQueue q1 = queue(journal).disk(flaky).open();
        failNext.set(true);
        assertThrows(IOException.class, () -> q1.enqueue(QueuedWrite.assignRole("g", "u", "lost", null)));
        assertEquals(0, q1.size(), "the entry is not reported as queued");
        q1.enqueue(QueuedWrite.assignRole("g", "u", "kept", null));
        q1.close(Duration.ofMillis(100));

        try (WriteQueue q2 = queue(journal).open()) {
            assertEquals(List.of("assign role"), q2.pending().stream().map(e -> e.write().label()).toList());
            assertTrue(q2.pending().get(0).write().path().endsWith("/kept"));
        }
    }

    @Test
    void concurrentEnqueuesShareForcesAndKeepJournalOrder() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        AtomicInteger forces = new AtomicInteger();
        DurableFiles.Disk slow = channel -> {
            forces.incrementAndGet();
            try {
                Thread.sleep(20);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            channel.force(true);
        };
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 503,
                FakeServer.error("internal", 503, "x")));
        WriteQueue q1 = queue(journal).disk(slow).retryBackoff(Duration.ofSeconds(30), Duration.ofSeconds(30)).open();
        int before = forces.get();
        int threads = 8;
        int each = 10;
        List<Thread> workers = new ArrayList<>();
        List<Throwable> failures = new CopyOnWriteArrayList<>();
        for (int t = 0; t < threads; t++) {
            int id = t;
            Thread w = new Thread(() -> {
                try {
                    for (int i = 0; i < each; i++) q1.enqueue(QueuedWrite.assignRole("g", "u" + id, "r" + i, null));
                } catch (Throwable e) {
                    failures.add(e);
                }
            });
            workers.add(w);
            w.start();
        }
        for (Thread w : workers) w.join();
        assertTrue(failures.isEmpty(), failures.toString());
        int used = forces.get() - before;
        assertTrue(used < threads * each / 2, "forces were shared: " + used + " for " + threads * each);
        List<String> inMemory = q1.pending().stream().map(e -> e.id()).toList();
        assertEquals(threads * each, inMemory.size());
        q1.close(Duration.ofMillis(100));

        try (WriteQueue q2 = queue(journal).retryBackoff(Duration.ofSeconds(30), Duration.ofSeconds(30)).open()) {
            assertEquals(inMemory, q2.pending().stream().map(e -> e.id()).toList(),
                    "the journal replays in the order entries joined the queue");
            for (int t = 0; t < threads; t++) {
                String user = "/u" + t + "/";
                List<String> roles = q2.pending().stream().map(e -> e.write().path())
                        .filter(p -> p.contains(user)).toList();
                for (int i = 0; i < each; i++) assertTrue(roles.get(i).endsWith("/r" + i), "per-thread order");
            }
        }
    }

    @Test
    void successDoneRecordsAreNotForcedButReachDiskAtClose() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        AtomicInteger forces = new AtomicInteger();
        DurableFiles.Disk counting = channel -> {
            forces.incrementAndGet();
            channel.force(true);
        };
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        WriteQueue q = queue(journal).disk(counting).open();
        int before = forces.get();
        q.enqueue(QueuedWrite.assignRole("g", "u", "r0", null));
        assertTrue(q.flush(Duration.ofSeconds(10)));
        assertEquals(1, forces.get() - before, "the put is forced, its success done record is not");
        q.close();
        try (WriteQueue again = queue(journal).open()) {
            assertEquals(0, again.size(), "closing forced the done record");
        }

        // A refusal's done record is forced, so the refused entry is not dead-lettered twice.
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 404,
                FakeServer.error("not_found", 404, "gone")));
        try (WriteQueue r = queue(journal).disk(counting).open()) {
            int start = forces.get();
            r.enqueue(QueuedWrite.assignRole("g", "u", "r1", null));
            assertTrue(r.flush(Duration.ofSeconds(10)));
            assertEquals(1, rejections.size());
            assertTrue(forces.get() - start >= 3, "the put, the dead letter and the done record are forced");
        }
    }

    @Test
    void compactionThatCannotReplaceTheJournalKeepsTheOldOne() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        try (WriteQueue q = queue(journal).open()) {
            q.enqueue(QueuedWrite.assignRole("g", "u", "r0", null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
        }
        List<String> before = Files.readAllLines(journal);
        // A directory where the temporary file goes makes every rewrite fail.
        Files.createDirectories(dir.resolve("q.jsonl.tmp").resolve("blocker"));
        errorLogs.clear();
        try (WriteQueue q = queue(journal).compactThreshold(1).open()) {
            q.enqueue(QueuedWrite.assignRole("g", "u", "r1", null));
            assertTrue(q.flush(Duration.ofSeconds(10)), "the queue keeps working on the old journal");
        }
        assertFalse(errorLogs.isEmpty(), "the failed compaction is logged at ERROR");
        List<String> after = Files.readAllLines(journal);
        assertEquals(before, after.subList(0, before.size()), "the old journal was kept and appended to");
        try (WriteQueue q = queue(journal).open()) {
            assertEquals(0, q.size());
        }
    }

    @Test
    void compactionKeepsOnlyPendingEntries() throws Exception {
        Path journal = dir.resolve("q.jsonl");
        server.onPrefix("POST", "/v1/groups/", (req, ex) -> FakeServer.json(ex, 200, MEMBER));
        try (WriteQueue q = queue(journal).compactThreshold(3).open()) {
            for (int i = 0; i < 7; i++) q.enqueue(QueuedWrite.assignRole("g", "u", "r" + i, null));
            assertTrue(q.flush(Duration.ofSeconds(10)));
        }
        List<String> lines = Files.readAllLines(journal);
        assertTrue(lines.size() <= 2, "compaction rewrote the journal: " + lines.size() + " lines");
        try (WriteQueue q = queue(journal).open()) {
            assertEquals(0, q.size());
        }
    }
}
