package io.junjo.sdk;

import io.junjo.sdk.events.GameEventListener;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.SubscribeOptions;
import io.junjo.sdk.internal.ApiSupport;
import io.junjo.sdk.internal.GameStream;
import io.junjo.sdk.internal.Json;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;

/**
 * The game stream: every event of the game in commit order, each with a gapless
 * stream position a reconnect resumes from.
 */
public final class EventsApi {
    private final ApiSupport api;

    EventsApi(ApiSupport api) {
        this.api = api;
    }

    /**
     * The game's current stream position, a decimal string ({@code "0"} for a game with no
     * events). A snapshot read after this call reflects every event up to it, and possibly a few
     * after.
     */
    public CompletableFuture<String> position() {
        return api.get("/v1/events/position", o -> {
            String p = Json.optStr(o, "position");
            if (p == null) throw Json.wire("position response carried no position");
            return p;
        });
    }

    /**
     * Opens the game stream. Completes once the server accepted the first connection; a failure of
     * that first connection fails the future and is not retried. Afterwards the stream reconnects
     * from its last position as configured in {@code opts}, which may be null for the defaults.
     */
    public CompletableFuture<GameSubscription> subscribe(GameEventListener listener, SubscribeOptions opts) {
        Objects.requireNonNull(listener, "listener");
        return GameStream.open(api.transport(), listener, opts == null ? SubscribeOptions.defaults() : opts);
    }

    /** Same as {@link #subscribe(GameEventListener, SubscribeOptions)} with every type, live from now. */
    public CompletableFuture<GameSubscription> subscribe(GameEventListener listener) {
        return subscribe(listener, SubscribeOptions.defaults());
    }
}
