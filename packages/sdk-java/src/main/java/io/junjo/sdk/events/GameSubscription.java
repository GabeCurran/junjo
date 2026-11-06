package io.junjo.sdk.events;

/** Handle for an open game event stream. */
public interface GameSubscription extends AutoCloseable {
    /**
     * The last stream position seen, from events and heartbeats alike: the value to resume from.
     * Positions are decimal strings up to the signed 64-bit range; compare them as longs.
     */
    String position();

    /** Whether the subscription has stopped, by {@link #close()} or on its own. */
    boolean isClosed();

    /** Stops the stream and any pending reconnect. Idempotent; never calls {@code onError}. */
    @Override
    void close();
}
