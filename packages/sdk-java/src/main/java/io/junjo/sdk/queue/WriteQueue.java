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
 * Completion appends a {@code done} record. On open the journal is replayed and compacted:
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
 * against state that changed since the write was decided, beyond that retention.
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
    private int doneSinceCompact;
    private boolean accepting;
    private boolean stopNow;
    private CompletableFuture<HttpResult> inFlight;
    private Thread drainThread;

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
     * Appends a write. Returns only after the entry is forced to disk.
     *
     * @throws IOException when the journal cannot be written or forced; the entry is then not
     *     queued
     * @throws IllegalStateException when the queue is closed
     */
    public Entry enqueue(QueuedWrite write) throws IOException {
        Objects.requireNonNull(write, "write");
        Entry entry = new Entry(UUID.randomUUID().toString(), UUID.randomUUID().toString(), write, Instant.now());
        synchronized (lock) {
            if (!accepting) throw new IllegalStateException("write queue is closed");
            append(putRecord(entry));
            queue.addLast(entry);
            lock.notifyAll();
        }
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
        doneSinceCompact = 0;
    }

    // Appends one record and forces it to disk. Called with the lock held. A failed write or force
    // rolls the file back to its previous length, so a record the caller was told failed cannot
    // be replayed later.
    private void append(String json) throws IOException {
        if (channel == null) throw new IOException("write queue journal is closed");
        long before = channel.size();
        try {
            DurableFiles.writeFully(channel, DurableFiles.line(json));
            disk.force(channel);
        } catch (IOException e) {
            try {
                channel.truncate(before);
                disk.force(channel);
            } catch (IOException rollback) {
                e.addSuppressed(rollback);
                Safe.log(logger, JunjoLogger.Level.ERROR,
                        "write queue journal rollback failed; the record may be replayed", rollback);
            }
            throw e;
        }
    }

    private void appendDeadLetter(String json) throws IOException {
        try (FileChannel out = FileChannel.open(deadLetters, StandardOpenOption.CREATE, StandardOpenOption.WRITE,
                StandardOpenOption.APPEND)) {
            DurableFiles.writeFully(out, json + "\n");
            disk.force(out);
        }
    }

    private void closeChannel() {
        if (channel == null) return;
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
                Json.optStr(o, "label"));
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
        synchronized (lock) {
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
            try {
                append(doneRecord(head, outcome));
                doneSinceCompact++;
            } catch (IOException ex) {
                // The done record did not reach disk; the entry leaves memory anyway so the queue
                // moves on, and a restart resends it with the same idempotency key.
                Safe.log(logger, JunjoLogger.Level.ERROR, "write queue journal write failed", ex);
                Safe.accept(logger, "onError", onError, ex);
            }
        }
        Safe.accept(logger, "on" + Character.toUpperCase(outcome.charAt(0)) + outcome.substring(1), cb,
                new Outcome(head, r.status(), r.error()));
        synchronized (lock) {
            queue.pollFirst();
            if (doneSinceCompact >= compactThreshold) {
                try {
                    rewrite();
                } catch (IOException ex) {
                    Safe.log(logger, JunjoLogger.Level.ERROR, "write queue journal reopen failed", ex);
                    Safe.accept(logger, "onError", onError, ex);
                }
            }
            lock.notifyAll();
        }
        return true;
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
