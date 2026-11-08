package io.junjo.sdk.queue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.JunjoLogger;
import io.junjo.sdk.internal.Backoff;
import io.junjo.sdk.internal.Call;
import io.junjo.sdk.internal.ClientAccess;
import io.junjo.sdk.internal.DurableFiles;
import io.junjo.sdk.internal.HttpResult;
import io.junjo.sdk.internal.Json;
import io.junjo.sdk.internal.Safe;
import io.junjo.sdk.internal.Threads;
import io.junjo.sdk.internal.Transport;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Consumer;

/**
 * A durable, ordered queue of writes that survives a crash and replays safely.
 *
 * <p>Durability: {@link #enqueue} appends the entry to a journal and forces it to disk before
 * returning, so an entry the caller saw accepted is never lost; when the force fails the append
 * is rolled back and {@code enqueue} throws. Every journal line carries a CRC32 of its text.
 * Concurrent enqueues share forces: one force covers every entry written before it began, and the
 * force runs outside the queue's lock, so neither other enqueues nor the drain wait on the disk.
 * {@code enqueue} still blocks for one force, so call it from a thread that may wait on the disk,
 * not from one that must never stall.
 *
 * <p>Completion appends a {@code done} record. A success's done record is not forced on its own:
 * the next force, or closing the queue, carries it to disk. One lost to a crash first only makes
 * the entry pending again, and it is resent with its idempotency key. The done record of a
 * conflict or a refusal is forced, so a refused entry is not dead-lettered twice. On open the
 * journal is replayed and compacted:
 * rewritten with only the pending entries to a temporary file that is forced, atomically moved
 * over the journal, and followed by a force of the directory. When the file system cannot move
 * atomically the old journal is kept and an ERROR is logged; it stays correct, only larger.
 * Compaction also runs whenever the done records pass a threshold.
 *
 * <p>Dead letters: a line whose checksum fails, and every entry the server refused
 * ({@code 412} or another 4xx), is appended to the dead-letter file next to the journal
 * ({@link #deadLetterFile()}) with the reason, the status and the raw response body, before any
 * callback runs. Nothing the queue drops vanishes, even when a callback is unset or throws.
 *
 * <p>Replay safety: every entry gets a random UUID {@code Idempotency-Key} when it is enqueued and
 * keeps it across retries and restarts, so a write whose response was lost is not applied twice
 * within the server's key retention. An optional {@code If-Match} additionally refuses a replay
 * against state that changed since the write was decided, beyond that retention, and an optional
 * {@code If-None-Match: *} refuses one whose target already exists.
 *
 * <p>Ordering: one drain thread sends entries strictly in enqueue order; an entry is not sent
 * until every earlier one has finished.
 *
 * <p>Outcomes: 2xx is success. A lift answered with {@link JunjoException#isNotActive()} is
 * success too. {@code 412 precondition_failed} drops the entry and calls {@code onConflict}.
 * Network errors, timeouts, 5xx, 408, 429 and 409 {@code idempotency_key_in_progress} keep the
 * entry and retry it with backoff (honouring {@code Retry-After}). {@code 401} also keeps the
 * entry and retries: a missing or rotated credential is a configuration fault, and dropping every
 * queued write because of it would lose data. Every other 4xx drops the entry and calls
 * {@code onRejected}.
 *
 * <p>Shutdown: {@link #close()} stops accepting entries, keeps draining for up to the close
 * timeout, then stops; whatever is still pending stays in the journal for the next open.
 */
public final class WriteQueue implements AutoCloseable {
    private static final int DEFAULT_COMPACT_THRESHOLD = 1000;
    /** Longest wait for one send; the transport's own request timeout normally fires first. */
    private static final Duration SEND_TIMEOUT = Duration.ofMinutes(10);
    /** Longest wait for the drain thread to exit once told to stop. */
    private static final Duration DRAIN_STOP_WAIT = Duration.ofSeconds(5);
    /** A server's {@code Retry-After} is honoured up to this multiple of the backoff ceiling. */
    private static final int RETRY_AFTER_CAP_FACTOR = 10;
    private static final long MIN_RETRY_DELAY_MS = 1;
    private static final String DEAD_LETTER_SUFFIX = ".dead";

    private final Transport transport;
    private final Path journal;
    private final Path deadLetters;
    private final Consumer<Outcome> onSuccess;
    private final Consumer<Outcome> onConflict;
    private final Consumer<Outcome> onRejected;
    private final Consumer<Throwable> onError;
    private final Duration retryBase;
    private final Duration retryMax;
    private final Duration closeTimeout;
    private final int compactThreshold;
    private final JunjoLogger logger;
    private final DurableFiles.Disk disk;

    private final Object lock = new Object();
    private final Deque<Entry> queue = new ArrayDeque<>();
    private FileChannel channel;
    // Journal bookkeeping, under the lock. written is the journal's length including lines not
    // forced yet, durable the length a completed force covers. A failed force truncates the
    // journal back to durable and starts a new epoch, which fails every line written in the old
    // one that was not durable yet. unforced holds the entries written but not yet covered by a
    // force, in journal order; they join the queue, still in that order, once one covers them.
    private long written;
    private long durable;
    private int epoch;
    // Bumped by every journal rewrite. A rewrite runs only when no record is waiting for a force,
    // so every record from an earlier generation was durable before the rewrite, and its offset
    // no longer refers to the current file.
    private int generation;
    private boolean forcing;
    private IOException forceFailure;
    private final Deque<Unforced> unforced = new ArrayDeque<>();
    private int doneSinceCompact;
    private boolean accepting;
    private boolean stopNow;
    private CompletableFuture<HttpResult> inFlight;
    private Thread drainThread;

    // An entry whose put record ends at byte end of the journal.
    private record Unforced(Entry entry, long end) {}

    // Where one record ends: the journal length after it, and the epoch and journal generation it
    // was written in.
    private record Mark(long end, int epoch, int generation) {}

    /** One pending entry. {@code idempotencyKey} is sent with every attempt. */
    public record Entry(String id, String idempotencyKey, QueuedWrite write, Instant enqueuedAt) {}

    /**
     * The final outcome of an entry.
     *
     * @param status the HTTP status of the final answer
     * @param error the server's error for a conflict or rejection, else null
     */
    public record Outcome(Entry entry, int status, JunjoException error) {}

    private WriteQueue(Builder b) {
        this.transport = ClientAccess.transport(b.client);
        this.journal = b.journal;
        this.deadLetters = b.journal.resolveSibling(b.journal.getFileName() + DEAD_LETTER_SUFFIX);
        this.onSuccess = b.onSuccess;
        this.onConflict = b.onConflict;
        this.onRejected = b.onRejected;
        this.onError = b.onError;
        this.retryBase = b.retryBase;
        this.retryMax = b.retryMax;
        this.closeTimeout = b.closeTimeout;
        this.compactThreshold = b.compactThreshold;
        this.logger = transport.logger();
        this.disk = b.disk;
    }

    /** {@code journal} is created when missing; its directory holds the dead-letter file too. */
    public static Builder builder(JunjoClient client, Path journal) {
        return new Builder(client, journal);
    }

    // ------------------------------------------------------------------ public API

    /**
     * Appends a write. Returns only after the entry is forced to disk, which blocks the calling
     * thread for one force; enqueues from several threads share forces.
     *
     * @throws IOException when the journal cannot be written or forced; the entry is then not
     *     queued
     * @throws IllegalStateException when the queue is closed
     */
    public Entry enqueue(QueuedWrite write) throws IOException {
        Objects.requireNonNull(write, "write");
        Entry entry = new Entry(UUID.randomUUID().toString(), UUID.randomUUID().toString(), write, Instant.now());
        Mark mark;
        synchronized (lock) {
            if (!accepting) throw new IllegalStateException("write queue is closed");
            mark = write(putRecord(entry));
            unforced.addLast(new Unforced(entry, mark.end()));
        }
        forceThrough(mark);
        return entry;
    }

    /** The number of entries not yet finished. */
    public int size() {
        synchronized (lock) {
            return queue.size();
        }
    }

    /** A snapshot of the pending entries, in send order. */
    public List<Entry> pending() {
        synchronized (lock) {
            return List.copyOf(queue);
        }
    }

    public Path journal() {
        return journal;
    }

    /**
     * The JSON-lines file that receives refused entries and quarantined journal lines. Each line
     * holds {@code reason}, {@code at}, and either the {@code entry} with the answer's
     * {@code status} and raw {@code response} body, or the unreadable {@code line}.
     */
    public Path deadLetterFile() {
        return deadLetters;
    }

    /**
     * Waits until every entry enqueued so far has finished, or the timeout passes. Returns whether
     * the queue was empty in time.
     */
    public boolean flush(Duration timeout) throws InterruptedException {
        long deadline = System.nanoTime() + timeout.toNanos();
        synchronized (lock) {
            while (!queue.isEmpty()) {
                long left = deadline - System.nanoTime();
                if (left <= 0 || drainThread == null || !drainThread.isAlive()) return queue.isEmpty();
                TimeUnit.NANOSECONDS.timedWait(lock, left);
            }
            return true;
        }
    }

    /** Closes with the configured close timeout. */
    @Override
    public void close() {
        try {
            close(closeTimeout);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Stops accepting entries, drains for up to {@code timeout}, then stops the drain thread and
     * closes the journal. Pending entries stay in the journal. Idempotent. Returns whether the
     * queue was empty when it stopped.
     */
    public boolean close(Duration timeout) throws InterruptedException {
        Thread t;
        synchronized (lock) {
            if (channel == null) return queue.isEmpty();
            accepting = false;
        }
        boolean flushed = flush(timeout);
        CompletableFuture<HttpResult> current;
        synchronized (lock) {
            stopNow = true;
            current = inFlight;
            t = drainThread;
            lock.notifyAll();
        }
        // A request still in flight is cancelled; its entry stays pending and is resent, with the
        // same idempotency key, on the next open.
        if (current != null) current.cancel(true);
        if (t != null) t.join(DRAIN_STOP_WAIT.toMillis());
        synchronized (lock) {
            // An enqueue accepted before closing may still be forcing; its outcome comes first.
            long deadline = System.nanoTime() + DRAIN_STOP_WAIT.toNanos();
            while (forcing || !unforced.isEmpty()) {
                long left = deadline - System.nanoTime();
                if (left <= 0) break;
                TimeUnit.NANOSECONDS.timedWait(lock, left);
            }
            closeChannel();
            return flushed && queue.isEmpty();
        }
    }

    // ------------------------------------------------------------------ open and journal

    private WriteQueue open() throws IOException {
        Path parent = journal.toAbsolutePath().getParent();
        if (parent != null) Files.createDirectories(parent);
        List<Entry> pendingEntries = replay();
        synchronized (lock) {
            queue.addAll(pendingEntries);
            rewrite();
            accepting = true;
        }
        drainThread = Threads.start("junjo-write-queue", this::drainLoop);
        return this;
    }

    // Reads the journal. A line that fails its checksum, does not parse, or is the torn tail of a
    // crashed append is quarantined in the dead-letter file before compaction drops it, so it is
    // never misread and never lost. The quarantine must reach disk first: if it cannot, open fails
    // and the journal is left untouched.
    private List<Entry> replay() throws IOException {
        if (!Files.exists(journal)) return List.of();
        String text = new String(Files.readAllBytes(journal), StandardCharsets.UTF_8);
        boolean endsClean = text.isEmpty() || text.endsWith("\n");
        String[] lines = text.split("\n", -1);
        int count = endsClean ? lines.length - 1 : lines.length;
        Map<String, Entry> puts = new LinkedHashMap<>();
        Set<String> done = new LinkedHashSet<>();
        List<String> quarantine = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            String raw = lines[i].endsWith("\r") ? lines[i].substring(0, lines[i].length() - 1) : lines[i];
            if (raw.isBlank()) continue;
            boolean torn = !endsClean && i == count - 1;
            String reason;
            try {
                JsonObject o = DurableFiles.parseLine(raw);
                String op = Json.str(o, "op");
                if (op.equals("put")) {
                    Entry e = entryFrom(o);
                    puts.put(e.id(), e);
                } else if (op.equals("done")) {
                    done.add(Json.str(o, "id"));
                }
                continue;
            } catch (DurableFiles.ChecksumException e) {
                reason = torn ? "torn_line" : "checksum_mismatch";
            } catch (RuntimeException e) {
                reason = torn ? "torn_line" : "unreadable";
            }
            Safe.log(logger, torn ? JunjoLogger.Level.INFO : JunjoLogger.Level.ERROR,
                    "write queue journal line " + (i + 1) + " failed validation (" + reason + ") and was quarantined",
                    null);
            JsonObject q = new JsonObject();
            q.addProperty("reason", reason);
            q.addProperty("at", Instant.now().toString());
            q.addProperty("lineNumber", i + 1);
            q.addProperty("line", raw);
            quarantine.add(Json.GSON.toJson(q));
        }
        for (String q : quarantine) appendDeadLetter(q);
        List<Entry> out = new ArrayList<>();
        for (Entry e : puts.values()) if (!done.contains(e.id())) out.add(e);
        return out;
    }

    // Compacts once enough entries are done. Compaction rewrites the queue only, so it waits while
    // a force is running or an enqueue's put is not covered by one yet; a later completion tries
    // again. Only the drain thread calls it, right after removing a finished entry, because an
    // entry whose done record is written but which is still at the head of the queue would be
    // rewritten as pending. Called with the lock held.
    private void maybeCompact() {
        if (doneSinceCompact < compactThreshold || forcing || !unforced.isEmpty()) return;
        try {
            rewrite();
        } catch (IOException ex) {
            Safe.log(logger, JunjoLogger.Level.ERROR, "write queue journal reopen failed", ex);
            Safe.accept(logger, "onError", onError, ex);
        }
    }

    // Rewrites the journal with only the pending entries. Called with the lock held. When the new
    // file cannot replace the old one atomically, the old journal is kept: a plain move could
    // leave neither file complete after a crash.
    private void rewrite() throws IOException {
        StringBuilder sb = new StringBuilder();
        for (Entry e : queue) sb.append(DurableFiles.line(putRecord(e)));
        closeChannel();
        try {
            DurableFiles.replaceAtomically(journal, sb.toString().getBytes(StandardCharsets.UTF_8), disk);
        } catch (IOException e) {
            Safe.log(logger, JunjoLogger.Level.ERROR,
                    "write queue compaction failed; keeping the old journal: " + e.getMessage(), e);
        }
        channel = FileChannel.open(journal, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                StandardOpenOption.APPEND);
        written = channel.size();
        durable = written;
        generation++;
        doneSinceCompact = 0;
    }

    // Appends one record without forcing it. Called with the lock held. A failed write rolls the
    // file back to its previous length, so a record the caller was told failed cannot be
    // replayed later.
    private Mark write(String json) throws IOException {
        if (channel == null) throw new IOException("write queue journal is closed");
        ByteBuffer buf = ByteBuffer.wrap(DurableFiles.line(json).getBytes(StandardCharsets.UTF_8));
        int length = buf.remaining();
        try {
            while (buf.hasRemaining()) channel.write(buf);
        } catch (IOException e) {
            try {
                channel.truncate(written);
            } catch (IOException rollback) {
                e.addSuppressed(rollback);
                Safe.log(logger, JunjoLogger.Level.ERROR,
                        "write queue journal rollback failed; the record may be replayed", rollback);
            }
            throw e;
        }
        written += length;
        return new Mark(written, epoch, generation);
    }

    // Returns once a force covers the record, forcing the journal itself when no other thread is.
    // Called without the lock. The force runs outside the lock and covers everything written
    // before it began, so threads that wrote meanwhile share the next one. Throws when a force
    // failed before the record was covered: the record was then rolled back. Interrupts are
    // remembered, not acted on, because the outcome must be known before returning.
    private void forceThrough(Mark mark) throws IOException {
        boolean interrupted = false;
        try {
            while (true) {
                FileChannel ch;
                long target;
                synchronized (lock) {
                    while (true) {
                        if (epoch != mark.epoch()) {
                            throw new IOException("the write queue journal could not be forced", forceFailure);
                        }
                        if (mark.generation() != generation || durable >= mark.end()) return;
                        if (!forcing) break;
                        try {
                            lock.wait();
                        } catch (InterruptedException e) {
                            interrupted = true;
                        }
                    }
                    forcing = true;
                    ch = channel;
                    target = written;
                }
                IOException failure = null;
                try {
                    if (ch == null) throw new IOException("write queue journal is closed");
                    disk.force(ch);
                } catch (IOException e) {
                    failure = e;
                } catch (RuntimeException e) {
                    failure = new IOException("the write queue journal force failed", e);
                }
                synchronized (lock) {
                    forcing = false;
                    if (failure == null) {
                        durable = target;
                        while (!unforced.isEmpty() && unforced.peekFirst().end() <= target) {
                            queue.addLast(unforced.pollFirst().entry());
                        }
                    } else {
                        rollBack(failure);
                    }
                    lock.notifyAll();
                }
            }
        } finally {
            if (interrupted) Thread.currentThread().interrupt();
        }
    }

    // After a failed force: drops every line that no force covered, and fails their writers.
    // Called with the lock held. The done records among them only make their entries pending
    // again on the next open, where they are resent with their idempotency keys.
    private void rollBack(IOException failure) {
        try {
            if (channel != null) {
                channel.truncate(durable);
                disk.force(channel);
            }
        } catch (IOException | RuntimeException rollback) {
            failure.addSuppressed(rollback);
            Safe.log(logger, JunjoLogger.Level.ERROR,
                    "write queue journal rollback failed; the record may be replayed", rollback);
        }
        written = durable;
        epoch++;
        forceFailure = failure;
        unforced.clear();
    }

    private void appendDeadLetter(String json) throws IOException {
        try (FileChannel out = FileChannel.open(deadLetters, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                StandardOpenOption.APPEND)) {
            DurableFiles.writeFully(out, json + "\n");
            disk.force(out);
        }
    }

    // Forces what is written, the unforced done records among it, then closes the journal.
    private void closeChannel() {
        if (channel == null) return;
        if (!forcing && written > durable) {
            try {
                disk.force(channel);
                durable = written;
            } catch (IOException e) {
                Safe.log(logger, JunjoLogger.Level.WARN, "forcing the write queue journal at close failed", e);
            }
        }
        try {
            channel.close();
        } catch (IOException e) {
            Safe.log(logger, JunjoLogger.Level.WARN, "closing the write queue journal failed", e);
        }
        channel = null;
    }

    private static JsonObject putObject(Entry e) {
        JsonObject o = new JsonObject();
        o.addProperty("op", "put");
        o.addProperty("id", e.id());
        o.addProperty("key", e.idempotencyKey());
        o.addProperty("method", e.write().method());
        o.addProperty("path", e.write().path());
        o.addProperty("body", e.write().body());
        o.addProperty("ifMatch", e.write().ifMatch());
        o.addProperty("ifNoneMatch", e.write().ifNoneMatch());
        o.addProperty("lift", e.write().lift());
        o.addProperty("label", e.write().label());
        o.addProperty("at", e.enqueuedAt().toString());
        return o;
    }

    private static String putRecord(Entry e) {
        return Json.GSON.toJson(putObject(e));
    }

    private static String doneRecord(Entry e, String outcome) {
        JsonObject o = new JsonObject();
        o.addProperty("op", "done");
        o.addProperty("id", e.id());
        o.addProperty("outcome", outcome);
        return Json.GSON.toJson(o);
    }

    private static String deadRecord(Entry e, String reason, int status, String response) {
        JsonObject o = new JsonObject();
        o.addProperty("reason", reason);
        o.addProperty("at", Instant.now().toString());
        o.addProperty("status", status);
        o.addProperty("response", response);
        o.add("entry", putObject(e));
        return Json.GSON.toJson(o);
    }

    private static Entry entryFrom(JsonObject o) {
        QueuedWrite w = new QueuedWrite(
                Json.str(o, "method"),
                Json.str(o, "path"),
                Json.optStr(o, "body"),
                Json.optStr(o, "ifMatch"),
                Json.optBool(o, "lift", false),
                Json.optStr(o, "label"),
                Json.optStr(o, "ifNoneMatch"));
        Instant at = Json.optInstant(o, "at");
        return new Entry(Json.str(o, "id"), Json.str(o, "key"), w, at == null ? Instant.EPOCH : at);
    }

    // ------------------------------------------------------------------ drain

    private enum Kind { SUCCESS, CONFLICT, REJECTED, RETRY, STOP }

    private record Result(Kind kind, int status, JunjoException error, String body, long retryAfterMillis) {
        static Result of(Kind kind) {
            return new Result(kind, 0, null, null, -1);
        }
    }

    private void drainLoop() {
        int attempt = 0;
        while (true) {
            Entry head;
            synchronized (lock) {
                while (!stopNow && queue.isEmpty()) {
                    try {
                        lock.wait();
                    } catch (InterruptedException e) {
                        return;
                    }
                }
                if (stopNow) return;
                head = queue.peekFirst();
            }
            Result r = send(head);
            synchronized (lock) {
                inFlight = null;
            }
            long delay;
            switch (r.kind()) {
                case STOP -> {
                    return;
                }
                case SUCCESS, CONFLICT, REJECTED -> {
                    if (finish(head, r)) {
                        attempt = 0;
                        continue;
                    }
                    // The dead letter could not be written; the entry stays at the head.
                    delay = backoff(attempt++);
                }
                default -> {
                    delay = r.retryAfterMillis() >= 0 ? r.retryAfterMillis() : backoff(attempt);
                    attempt++;
                    if (r.error() != null) {
                        Safe.log(logger, JunjoLogger.Level.WARN, "queued write '" + head.write().label()
                                + "' failed with " + r.error().code() + "; retrying in " + delay + " ms", r.error());
                        Safe.accept(logger, "onError", onError, r.error());
                    }
                }
            }
            if (!pause(delay)) return;
        }
    }

    private long backoff(int attempt) {
        return Math.max(MIN_RETRY_DELAY_MS, Backoff.fullJitterMillis(attempt, retryBase, retryMax));
    }

    // Waits on the lock so close() can cut the wait short. Returns false when the queue stops.
    private boolean pause(long delayMillis) {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(delayMillis);
        synchronized (lock) {
            while (!stopNow) {
                long left = deadline - System.nanoTime();
                if (left <= 0) break;
                try {
                    TimeUnit.NANOSECONDS.timedWait(lock, left);
                } catch (InterruptedException e) {
                    return false;
                }
            }
            return !stopNow;
        }
    }

    private Result send(Entry e) {
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Idempotency-Key", e.idempotencyKey());
        if (e.write().ifMatch() != null) headers.put("If-Match", e.write().ifMatch());
        if (e.write().ifNoneMatch() != null) headers.put("If-None-Match", e.write().ifNoneMatch());
        Call call = new Call(e.write().method(), e.write().path(), e.write().body(), headers, false, null);
        CompletableFuture<HttpResult> f = transport.exchange(call);
        synchronized (lock) {
            if (stopNow) {
                f.cancel(true);
                return Result.of(Kind.STOP);
            }
            inFlight = f;
        }
        try {
            HttpResult res = f.get(SEND_TIMEOUT.toMillis(), TimeUnit.MILLISECONDS);
            if (res.status() >= 200 && res.status() < 300) {
                return new Result(Kind.SUCCESS, res.status(), null, null, -1);
            }
            String body = res.bodyString();
            return classify(e, Transport.errorFrom(res.status(), body, res.headers(), null), body);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return Result.of(Kind.STOP);
        } catch (TimeoutException ex) {
            f.cancel(true);
            return new Result(Kind.RETRY, 0,
                    new JunjoException(JunjoException.TIMEOUT, "queued write timed out", ex), null, -1);
        } catch (ExecutionException | CancellationException ex) {
            Throwable cause = Transport.unwrap(ex);
            JunjoException je = cause instanceof JunjoException j
                    ? j
                    : new JunjoException(JunjoException.NETWORK_ERROR, String.valueOf(cause.getMessage()), cause);
            boolean stopping;
            synchronized (lock) {
                stopping = stopNow;
            }
            if (stopping || transport.isClosed()) return new Result(Kind.STOP, 0, je, null, -1);
            return new Result(Kind.RETRY, 0, je, null, -1);
        }
    }

    private Result classify(Entry e, JunjoException je, String body) {
        int s = je.status();
        if (e.write().lift() && je.isNotActive()) return new Result(Kind.SUCCESS, s, null, null, -1);
        if (s == 412) return new Result(Kind.CONFLICT, s, je, body, -1);
        boolean transientStatus = s >= 500 || s == 408 || s == 429 || s == 401
                || (s == 409 && "idempotency_key_in_progress".equals(je.code()));
        if (transientStatus) {
            long retryAfter = je.retryAfterSeconds().isPresent()
                    ? Math.min(je.retryAfterSeconds().getAsLong() * 1000, retryMax.toMillis() * RETRY_AFTER_CAP_FACTOR)
                    : -1;
            return new Result(Kind.RETRY, s, je, body, retryAfter);
        }
        return new Result(Kind.REJECTED, s, je, body, -1);
    }

    // Records the outcome, runs the callback, then removes the head, so flush() returns only after
    // every callback has run. A refused entry reaches the dead-letter file before anything else
    // happens; when that write fails the entry stays queued and false is returned.
    private boolean finish(Entry head, Result r) {
        String outcome = switch (r.kind()) {
            case CONFLICT -> "conflict";
            case REJECTED -> "rejected";
            default -> "success";
        };
        Consumer<Outcome> cb = switch (r.kind()) {
            case CONFLICT -> onConflict;
            case REJECTED -> onRejected;
            default -> onSuccess;
        };
        // Only the drain thread writes the dead-letter file once the queue is open, so it needs no lock.
        if (r.kind() != Kind.SUCCESS) {
            try {
                appendDeadLetter(deadRecord(head, outcome, r.status(), r.body()));
            } catch (IOException ex) {
                Safe.log(logger, JunjoLogger.Level.ERROR,
                        "write queue dead-letter write failed; the entry stays queued", ex);
                Safe.accept(logger, "onError", onError, ex);
                return false;
            }
        }
        Mark mark = null;
        synchronized (lock) {
            try {
                mark = write(doneRecord(head, outcome));
                doneSinceCompact++;
            } catch (IOException ex) {
                journalWriteFailed(ex);
            }
        }
        if (mark != null && r.kind() != Kind.SUCCESS) {
            try {
                forceThrough(mark);
            } catch (IOException ex) {
                journalWriteFailed(ex);
            }
        }
        Safe.accept(logger, "on" + Character.toUpperCase(outcome.charAt(0)) + outcome.substring(1), cb,
                new Outcome(head, r.status(), r.error()));
        synchronized (lock) {
            queue.pollFirst();
            maybeCompact();
            lock.notifyAll();
        }
        return true;
    }

    // The done record did not reach disk; the entry leaves memory anyway so the queue moves on,
    // and a restart resends it with the same idempotency key.
    private void journalWriteFailed(IOException ex) {
        Safe.log(logger, JunjoLogger.Level.ERROR, "write queue journal write failed", ex);
        Safe.accept(logger, "onError", onError, ex);
    }

    // ------------------------------------------------------------------ builder

    /** Builds and opens a {@link WriteQueue}. Callbacks run on the drain thread. */
    public static final class Builder {
        private final JunjoClient client;
        private final Path journal;
        private Consumer<Outcome> onSuccess;
        private Consumer<Outcome> onConflict;
        private Consumer<Outcome> onRejected;
        private Consumer<Throwable> onError;
        private Duration retryBase = Duration.ofSeconds(1);
        private Duration retryMax = Duration.ofSeconds(60);
        private Duration closeTimeout = Duration.ofSeconds(10);
        private int compactThreshold = DEFAULT_COMPACT_THRESHOLD;
        private DurableFiles.Disk disk = DurableFiles.Disk.SYSTEM;

        private Builder(JunjoClient client, Path journal) {
            this.client = Objects.requireNonNull(client, "client");
            this.journal = Objects.requireNonNull(journal, "journal");
        }

        public Builder onSuccess(Consumer<Outcome> cb) {
            this.onSuccess = cb;
            return this;
        }

        /** Called after a {@code 412} dropped an entry, once its dead letter is on disk. */
        public Builder onConflict(Consumer<Outcome> cb) {
            this.onConflict = cb;
            return this;
        }

        /** Called after any other refusal dropped an entry, once its dead letter is on disk. */
        public Builder onRejected(Consumer<Outcome> cb) {
            this.onRejected = cb;
            return this;
        }

        /** Called for each transient failure that will be retried, and for journal write failures. */
        public Builder onError(Consumer<Throwable> cb) {
            this.onError = cb;
            return this;
        }

        /** Full-jitter retry bounds. Defaults 1 s and 60 s. */
        public Builder retryBackoff(Duration base, Duration max) {
            this.retryBase = Objects.requireNonNull(base, "base");
            this.retryMax = Objects.requireNonNull(max, "max");
            return this;
        }

        /** How long {@link WriteQueue#close()} keeps draining. Default 10 s. */
        public Builder closeTimeout(Duration timeout) {
            this.closeTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        /** Done records that trigger a compaction, at least 1. Default 1000. */
        public Builder compactThreshold(int doneRecords) {
            if (doneRecords < 1) throw new IllegalArgumentException("compactThreshold must be at least 1");
            this.compactThreshold = doneRecords;
            return this;
        }

        // A seam for tests that need a force to fail.
        Builder disk(DurableFiles.Disk d) {
            this.disk = Objects.requireNonNull(d, "disk");
            return this;
        }

        /**
         * Replays the journal and starts draining.
         *
         * @throws IOException when the journal cannot be read, or a quarantined line cannot be
         *     written to the dead-letter file
         */
        public WriteQueue open() throws IOException {
            return new WriteQueue(this).open();
        }
    }
}
