package io.junjo.sdk.events;

import java.time.Duration;
import java.util.Arrays;
import java.util.Collection;
import java.util.EnumSet;
import java.util.Objects;
import java.util.Set;
import java.util.function.Consumer;

/**
 * Options for the game event stream.
 *
 * <p>Callbacks run on SDK threads: event delivery and {@code onError} after a frame failure on the
 * stream's reader thread, the reconnect callbacks on the transport's threads. A callback must not
 * block for long; a throwing reconnect callback is caught and logged.
 */
public final class SubscribeOptions {
    /** The default cap on one frame, in bytes. */
    public static final int DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;

    /** The smallest frame cap the builder accepts, in bytes. */
    public static final int MIN_MAX_FRAME_BYTES = 1024;

    private final Set<EventType> types;
    private final String from;
    private final boolean reconnect;
    private final Duration initialDelay;
    private final Duration maxDelay;
    private final Duration idleTimeout;
    private final int maxFrameBytes;
    private final Consumer<String> onResync;
    private final Consumer<ReconnectInfo> onReconnecting;
    private final Consumer<String> onReconnected;
    private final Consumer<Throwable> onError;

    private SubscribeOptions(Builder b) {
        this.types = b.types.isEmpty() ? Set.of() : Set.copyOf(b.types);
        this.from = b.from;
        this.reconnect = b.reconnect;
        this.initialDelay = b.initialDelay;
        this.maxDelay = b.maxDelay;
        this.idleTimeout = b.idleTimeout;
        this.maxFrameBytes = b.maxFrameBytes;
        this.onResync = b.onResync;
        this.onReconnecting = b.onReconnecting;
        this.onReconnected = b.onReconnected;
        this.onError = b.onError;
    }

    public static Builder builder() {
        return new Builder();
    }

    /** Every type, live from now, reconnecting with the default backoff. */
    public static SubscribeOptions defaults() {
        return builder().build();
    }

    /** The type filter; empty means every type. */
    public Set<EventType> types() {
        return types;
    }

    /** The position to resume after, or null for live from now. */
    public String from() {
        return from;
    }

    public boolean reconnect() {
        return reconnect;
    }

    public Duration initialDelay() {
        return initialDelay;
    }

    public Duration maxDelay() {
        return maxDelay;
    }

    /** How long a silent connection is trusted before it is dropped; zero disables the check. */
    public Duration idleTimeout() {
        return idleTimeout;
    }

    public int maxFrameBytes() {
        return maxFrameBytes;
    }

    /** Null when unset. */
    public Consumer<String> onResync() {
        return onResync;
    }

    /** Null when unset. */
    public Consumer<ReconnectInfo> onReconnecting() {
        return onReconnecting;
    }

    /** Null when unset. */
    public Consumer<String> onReconnected() {
        return onReconnected;
    }

    /** Null when unset. */
    public Consumer<Throwable> onError() {
        return onError;
    }

    /**
     * Details of a pending reconnect.
     *
     * @param attempt 1 for the first retry after a drop; resets after a successful reconnect
     * @param delay the wait before the attempt
     * @param error the failure that caused it, or null for a clean server close
     */
    public record ReconnectInfo(int attempt, Duration delay, Throwable error) {}

    /** Builds {@link SubscribeOptions}. */
    public static final class Builder {
        private final Set<EventType> types = EnumSet.noneOf(EventType.class);
        private String from;
        private boolean reconnect = true;
        private Duration initialDelay = Duration.ofSeconds(1);
        private Duration maxDelay = Duration.ofSeconds(30);
        private Duration idleTimeout = Duration.ofSeconds(75);
        private int maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
        private Consumer<String> onResync;
        private Consumer<ReconnectInfo> onReconnecting;
        private Consumer<String> onReconnected;
        private Consumer<Throwable> onError;

        private Builder() {}

        /** Delivers only these event types, replacing any earlier filter; empty means every type. */
        public Builder types(Collection<EventType> eventTypes) {
            types.clear();
            for (EventType t : eventTypes) types.add(Objects.requireNonNull(t, "event type"));
            return this;
        }

        /** Same as {@link #types(Collection)}. */
        public Builder types(EventType... eventTypes) {
            return types(Arrays.asList(eventTypes));
        }

        /**
         * Resumes after this decimal stream position, sent as {@code Last-Event-ID}; null starts
         * live from now.
         */
        public Builder from(String position) {
            this.from = position;
            return this;
        }

        /**
         * With false, a server-ended stream stops the subscription and reports
         * {@code network_error} to {@code onError}. Default true.
         */
        public Builder reconnect(boolean enabled) {
            this.reconnect = enabled;
            return this;
        }

        /**
         * Full-jitter backoff bounds: the n-th consecutive retry waits a uniform random time up to
         * {@code min(max, initial * 2^(n-1))}. Defaults 1 s and 30 s.
         */
        public Builder backoff(Duration initial, Duration max) {
            this.initialDelay = Objects.requireNonNull(initial, "initial");
            this.maxDelay = Objects.requireNonNull(max, "max");
            return this;
        }

        /**
         * The server sends a heartbeat every 30 s; a connection silent for longer than this is
         * treated as dropped and reconnected. Zero disables the check. Default 75 s.
         */
        public Builder idleTimeout(Duration timeout) {
            this.idleTimeout = Objects.requireNonNull(timeout, "timeout");
            return this;
        }

        /**
         * The cap on one frame in bytes; a larger frame fails the subscription with
         * {@code invalid_wire_data}. At least {@link #MIN_MAX_FRAME_BYTES}.
         */
        public Builder maxFrameBytes(int bytes) {
            if (bytes < MIN_MAX_FRAME_BYTES) {
                throw new IllegalArgumentException("maxFrameBytes must be at least " + MIN_MAX_FRAME_BYTES);
            }
            this.maxFrameBytes = bytes;
            return this;
        }

        /**
         * Called with the new position when a reconnect found the last position expired
         * ({@code 410}). By then a new stream is open, live from that position; events between the
         * old position and it were not delivered, so state built from the stream must be reloaded.
         * Without this callback an expired position is fatal.
         */
        public Builder onResync(Consumer<String> callback) {
            this.onResync = callback;
            return this;
        }

        /** Called before each reconnect wait. */
        public Builder onReconnecting(Consumer<ReconnectInfo> callback) {
            this.onReconnecting = callback;
            return this;
        }

        /** Called after a reconnect resumed, with the position it resumed after. */
        public Builder onReconnected(Consumer<String> callback) {
            this.onReconnected = callback;
            return this;
        }

        /**
         * Called once when the subscription stops on its own: a fatal reconnect answer (any 4xx
         * other than 408 and a handled 410), a malformed frame, the frame cap, a throwing
         * listener, or a server-ended stream with reconnect disabled. Never called after
         * {@code close()}.
         */
        public Builder onError(Consumer<Throwable> callback) {
            this.onError = callback;
            return this;
        }

        public SubscribeOptions build() {
            return new SubscribeOptions(this);
        }
    }
}
