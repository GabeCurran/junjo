package io.junjo.sdk;

import static io.junjo.sdk.TestSupport.await;
import static io.junjo.sdk.TestSupport.failure;
import static io.junjo.sdk.TestSupport.join;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.junjo.sdk.mirror.Answer;
import io.junjo.sdk.mirror.GameMirror;
import io.junjo.sdk.model.AddSanctionInput;
import io.junjo.sdk.model.Moderation;
import io.junjo.sdk.model.Sanction;
import io.junjo.sdk.model.SanctionHistoryEntry;
import io.junjo.sdk.queue.QueuedWrite;
import io.junjo.sdk.queue.WriteQueue;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

@EnabledIfEnvironmentVariable(named = "JUNJO_IT_BASE_URL", matches = ".+")
@EnabledIfEnvironmentVariable(named = "JUNJO_IT_API_KEY", matches = ".+")
@Timeout(90)
class LiveSanctionsTest {
    @TempDir
    Path dir;

    JunjoClient client;

    @BeforeEach
    void setUp() {
        client = LiveSupport.client();
    }

    @AfterEach
    void tearDown() {
        client.close();
    }

    @Test
    void lifecycleWithIfMatchAndAQueuedLiftOfAnInactiveSanction() throws Exception {
        String u = LiveSupport.user();
        List<Throwable> mirrorErrors = new CopyOnWriteArrayList<>();
        try (GameMirror mirror = GameMirror.builder(client).onError(mirrorErrors::add).build()) {
            join(mirror.start());
            join(mirror.resolve(u));
            assertEquals(Answer.NO, mirror.isSanctioned(u, "mute"));

            Sanction first = join(client.sanctions().add(
                    AddSanctionInput.builder(u, "mute").reason("spam").issuer("Console").build(),
                    WriteOptions.idempotent()));
            long v1 = first.version();
            assertTrue(v1 >= 1);
            await(() -> mirror.isSanctioned(u, "mute") == Answer.YES, "the mirror sees the sanction");

            JunjoResponse<List<Sanction>> mine = join(client.sanctions().forUser(u));
            assertEquals(WriteOptions.etag(v1), mine.etag());
            assertEquals(1, mine.value().size());

            JunjoException stale = failure(client.sanctions().add(
                    AddSanctionInput.builder(u, "mute").reason("changed").build(),
                    WriteOptions.none().withIfMatch(v1 - 1)));
            assertEquals("precondition_failed", stale.code());

            Sanction replaced = join(client.sanctions().add(
                    AddSanctionInput.builder(u, "mute").reason("changed").build(),
                            WriteOptions.none().withIfMatch(v1)));
            assertEquals(v1 + 1, replaced.version());
            assertEquals(first.startedAt(), replaced.startedAt(), "a replacement keeps the start");
            await(() -> mirror.sanction(u, "mute").map(s -> "changed".equals(s.reason())).orElse(false),
                    "the mirror sees the replacement");

            Moderation mod = join(client.bans().moderation(u)).value();
            assertEquals(v1 + 1, mod.version());
            assertEquals(1, mod.sanctions().size());

            JunjoException staleLift =
                    failure(client.sanctions().remove(u, "mute", null, WriteOptions.none().withIfMatch(v1)));
            assertEquals("precondition_failed", staleLift.code());
            join(client.sanctions().remove(u, "mute", null, WriteOptions.idempotent().withIfMatch(v1 + 1)));
            await(() -> mirror.isSanctioned(u, "mute") == Answer.NO, "the mirror sees the lift");

            List<SanctionHistoryEntry> history = join(client.sanctions().history(u, null)).value().items();
            assertEquals(List.of("lifted", "set", "set"), history.stream().map(SanctionHistoryEntry::kind).toList());

            JunjoException nothing = failure(client.sanctions().remove(u, "mute"));
            assertTrue(nothing.isNotActive());
        }
        assertTrue(mirrorErrors.isEmpty(), mirrorErrors.toString());

        List<WriteQueue.Outcome> ok = new CopyOnWriteArrayList<>();
        List<WriteQueue.Outcome> other = new CopyOnWriteArrayList<>();
        try (WriteQueue q = WriteQueue.builder(client, dir.resolve("q.jsonl"))
                .onSuccess(ok::add).onConflict(other::add).onRejected(other::add).open()) {
            // Inactive, and with a stale If-Match: nothing to lift wins over the precondition.
            q.enqueue(QueuedWrite.removeSanction(u, "mute", null).ifMatch(1));
            q.enqueue(QueuedWrite.removeSanction(LiveSupport.user(), "voice", null));
            q.enqueue(QueuedWrite.addSanction(AddSanctionInput.builder(u, "trade.lock").build()));
            assertTrue(q.flush(Duration.ofSeconds(30)));
        }
        assertEquals(3, ok.size());
        assertTrue(other.isEmpty(), other.toString());
        assertEquals(1, join(client.sanctions().forUser(u)).value().size());
    }
}
