package io.junjo.sdk.internal;

import io.junjo.sdk.JunjoException;
import io.junjo.sdk.JunjoLogger;
import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.GameEventListener;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.JunjoEvent;
import io.junjo.sdk.events.SubscribeOptions;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * The game stream client: one connection at a time, read on a dedicated daemon thread, resumed
 * from the last position after a server-side end.
 *
 * <p>Invariants: the position advances on every frame that carries an id (events, heartbeats and
 * skipped unknown types), so a resume never replays a frame already seen. Only the newest
 * connection's reader may act: each connection gets a generation number and a reader whose
 * generation is stale exits silently. Every state change happens under the instance lock; the
 * listener and callbacks run outside it.
 *
 * <p>The first connection is not retried: its failure completes the {@code open} future.
 * Afterwards, transport failures, 5xx and 408 reconnect with backoff; a 410 resyncs (or is fatal
 * without a resync callback); every other 4xx is fatal because it would fail the same way forever.
 *
 * <p>Internal: not part of the supported API; reached through {@code JunjoClient.events()}.
 */
public final class GameStream implements GameSubscription {
    private static final AtomicInteger SEQ = new AtomicInteger();

    private final Transport transport;
    private final String path;
    private final SubscribeOptions opts;
    private final GameEventListener listener;
    private final JunjoLogger logger;
    private final int id = SEQ.incrementAndGet();

    private volatile String position;
    private volatile boolean closed;
    private volatile long lastActivityNanos = System.nanoTime();
    private int generation;
    private int attempt;
    private InputStream body;
    private ScheduledFuture<?> reconnectTimer;
    private ScheduledFuture<?> watchdog;

    private GameStream(Transport transport, String path, SubscribeOptions opts, GameEventListener listener) {
        this.transport = transport;
        this.path = path;
        this.opts = opts;
        this.listener = listener;
        this.logger = transport.logger();
    }

    /** Opens the stream. Completes once the server accepted the first connection. */
    public static CompletableFuture<GameSubscription> open(
            Transport transport, GameEventListener listener, SubscribeOptions opts) {
        String types = opts.types().stream().map(EventType::wire).sorted().collect(Collectors.joining(","));
        String path = new Paths.Query().add("types", types.isEmpty() ? null : types).appendTo("/v1/events");
        GameStream stream = new GameStream(transport, path, opts, listener);
        return stream.connect(opts.from()).thenApply(resp -> {
            String start = resp.headers().firstValue(Transport.POSITION_HEADER).orElse(opts.from());
            if (start == null) {
                closeQuietly(resp.body());
                throw new JunjoException(JunjoException.INVALID_WIRE_DATA, resp.statusCode(),
                        "game stream response carried no Junjo-Stream-Position header", null, null, null, null);
            }
            stream.position = start;
            stream.startReading(resp.body());
            stream.armWatchdog();
            return stream;
        });
    }

    private CompletableFuture<HttpResponse<InputStream>> connect(String from) {
        Map<String, String> headers = from == null ? Map.of() : Map.of("Last-Event-ID", from);
        return transport.openStream(path, headers);
    }

    @Override
    public String position() {
        return position;
    }

    @Override
    public boolean isClosed() {
        return closed;
    }

    @Override
    public void close() {
        InputStream toClose;
        synchronized (this) {
            if (closed) return;
            closed = true;
            generation++;
            if (reconnectTimer != null) reconnectTimer.cancel(false);
            if (watchdog != null) watchdog.cancel(false);
            toClose = body;
            body = null;
        }
        closeQuietly(toClose);
    }

    private void fail(Throwable err) {
        synchronized (this) {
            if (closed) return;
        }
        close();
        Safe.log(logger, JunjoLogger.Level.ERROR, "game stream stopped: " + err.getMessage(), err);
        Safe.accept(logger, "onError", opts.onError(), err);
    }

    private void startReading(InputStream raw) {
        int gen;
        InputStream in;
        synchronized (this) {
            if (closed) {
                closeQuietly(raw);
                return;
            }
            gen = ++generation;
            in = new ActivityStream(raw);
            body = in;
            lastActivityNanos = System.nanoTime();
        }
        Threads.start("junjo-events-" + id + "-" + gen, () -> pump(in, gen));
    }

    private boolean isCurrent(int gen) {
        synchronized (this) {
            return !closed && generation == gen;
        }
    }

    private void pump(InputStream in, int gen) {
        SseReader reader = new SseReader(in, opts.maxFrameBytes());
        Throwable endError = null;
        try {
            while (isCurrent(gen)) {
                SseReader.Frame frame = reader.next();
                if (frame == null) break;
                if (!isCurrent(gen)) return;
                JunjoEvent event;
                try {
                    event = frame.data() == null ? null : EventDecoder.decode(frame.data());
                } catch (RuntimeException e) {
                    fail(e);
                    return;
                }
                if (frame.id() != null) position = frame.id();
                if (event != null) {
                    try {
                        listener.onEvent(event, position);
                    } catch (Throwable t) {
                        fail(t);
                        return;
                    }
                }
            }
        } catch (JunjoException e) {
            if (isCurrent(gen)) fail(e);
            return;
        } catch (IOException | RuntimeException e) {
            endError = e;
        } finally {
            closeQuietly(in);
        }
        if (!isCurrent(gen)) return;
        onStreamEnd(endError);
    }

    private void onStreamEnd(Throwable err) {
        if (!opts.reconnect()) {
            fail(new JunjoException(JunjoException.NETWORK_ERROR, "game event stream ended by the server", err));
            return;
        }
        Safe.log(logger, JunjoLogger.Level.INFO, "game stream ended; reconnecting from " + position, err);
        schedule(err);
    }

    private void schedule(Throwable err) {
        long delay;
        int n;
        synchronized (this) {
            if (closed) return;
            delay = Backoff.fullJitterMillis(attempt, opts.initialDelay(), opts.maxDelay());
            n = ++attempt;
            body = null;
            try {
                reconnectTimer = transport.schedule(this::reconnect, delay);
            } catch (RuntimeException rejected) {
                closed = true;
                return;
            }
        }
        Safe.accept(logger, "onReconnecting", opts.onReconnecting(),
                new SubscribeOptions.ReconnectInfo(n, Duration.ofMillis(delay), err));
    }

    private void reconnect() {
        if (closed) return;
        connect(position).whenComplete((resp, err) -> {
            if (err != null) {
                onConnectError(Transport.unwrap(err));
                return;
            }
            String start = resp.headers().firstValue(Transport.POSITION_HEADER).orElse(position);
            synchronized (this) {
                if (closed) {
                    closeQuietly(resp.body());
                    return;
                }
                attempt = 0;
                position = start;
            }
            startReading(resp.body());
            Safe.accept(logger, "onReconnected", opts.onReconnected(), start);
        });
    }

    private void onConnectError(Throwable err) {
        if (closed) return;
        if (isExpired(err)) {
            if (opts.onResync() == null) fail(err);
            else resync();
        } else if (isFatal(err)) {
            fail(err);
        } else {
            schedule(err);
        }
    }

    // The live stream opens before onResync runs, so every event committed while the caller
    // reloads its state is still delivered. A 410 here cannot be cured by another resync.
    private void resync() {
        connect(null).whenComplete((resp, err) -> {
            if (err != null) {
                Throwable t = Transport.unwrap(err);
                if (isExpired(t)) fail(t);
                else onConnectError(t);
                return;
            }
            String start = resp.headers().firstValue(Transport.POSITION_HEADER).orElse(null);
            if (start == null) {
                closeQuietly(resp.body());
                fail(new JunjoException(JunjoException.INVALID_WIRE_DATA,
                        "game stream response carried no Junjo-Stream-Position header", null));
                return;
            }
            synchronized (this) {
                if (closed) {
                    closeQuietly(resp.body());
                    return;
                }
                attempt = 0;
                position = start;
            }
            Safe.log(logger, JunjoLogger.Level.WARN, "game stream position expired; resynced at " + start, null);
            startReading(resp.body());
            Safe.accept(logger, "onResync", opts.onResync(), start);
        });
    }

    private void armWatchdog() {
        long idle = opts.idleTimeout().toMillis();
        if (idle <= 0) return;
        long period = Math.max(50, idle / 4);
        synchronized (this) {
            if (closed) return;
            watchdog = transport.schedule(new Runnable() {
                @Override
                public void run() {
                    InputStream stale = null;
                    synchronized (GameStream.this) {
                        if (closed) return;
                        long silentMs = (System.nanoTime() - lastActivityNanos) / 1_000_000;
                        if (body != null && silentMs > idle) {
                            stale = body;
                            lastActivityNanos = System.nanoTime();
                        }
                        try {
                            watchdog = transport.schedule(this, period);
                        } catch (RuntimeException rejected) {
                            return;
                        }
                    }
                    if (stale != null) {
                        Safe.log(logger, JunjoLogger.Level.WARN,
                                "game stream silent for over " + idle + " ms; reconnecting", null);
                        closeQuietly(stale);
                    }
                }
            }, period);
        }
    }

    private static boolean isExpired(Throwable err) {
        return err instanceof JunjoException je && je.status() == 410;
    }

    private static boolean isFatal(Throwable err) {
        if (!(err instanceof JunjoException je)) return false;
        int s = je.status();
        return s >= 400 && s < 500 && s != 408;
    }

    private static void closeQuietly(InputStream in) {
        if (in == null) return;
        try {
            in.close();
        } catch (IOException | RuntimeException ignored) {
            // Nothing to recover.
        }
    }

    // Records the time of every successful read so the watchdog can spot a silent connection.
    private final class ActivityStream extends FilterInputStream {
        ActivityStream(InputStream in) {
            super(in);
        }

        @Override
        public int read() throws IOException {
            int b = super.read();
            lastActivityNanos = System.nanoTime();
            return b;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, len);
            lastActivityNanos = System.nanoTime();
            return n;
        }
    }
}
