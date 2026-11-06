package io.junjo.sdk.internal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.fail;

import static io.junjo.sdk.TestSupport.await;

import io.junjo.sdk.FakeServer;
import io.junjo.sdk.JunjoClient;
import io.junjo.sdk.TestSupport;
import io.junjo.sdk.JunjoException;
import io.junjo.sdk.events.EventType;
import io.junjo.sdk.events.GameEventListener;
import io.junjo.sdk.events.GameSubscription;
import io.junjo.sdk.events.SubscribeOptions;
import java.io.OutputStream;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

@Timeout(30)
class GameStreamTest {
    static final String META = "\"gameId\":\"gm\",\"occurredAt\":\"2026-11-06T12:00:00.000Z\"";

    FakeServer server;
    JunjoClient client;
    final CountDownLatch hold = new CountDownLatch(1);
    final LinkedBlockingQueue<String> events = new LinkedBlockingQueue<>();
    final List<Throwable> errors = new CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        server = new FakeServer();
        client = TestSupport.client(server.baseUrl());
    }

    @AfterEach
    void tearDown() {
        hold.countDown();
        client.close();
        server.close();
    }

    static String banned(String id, String userId) {
        return "event: game.user.banned\ndata: {\"id\":\"" + id + "\",\"type\":\"game.user.banned\"," + META
                + ",\"junjoUserId\":\"j\",\"userId\":\"" + userId + "\",\"reason\":null,\"expiresAt\":null}\n";
    }

    void holdOpen() throws InterruptedException {
        hold.await(25, TimeUnit.SECONDS);
    }

    SubscribeOptions.Builder fast() {
        return SubscribeOptions.builder().backoff(Duration.ofMillis(10), Duration.ofMillis(40)).onError(errors::add);
    }

    GameEventListener collect() {
        return (event, position) -> events.add(event.type().wire() + "@" + position);
    }

    @Test
    void deliversEventsAndAdvancesOnHeartbeatsAndUnknownTypes() throws Exception {
        server.on("GET", "/v1/events", (req, ex) -> {
            OutputStream out = FakeServer.openSse(ex, "10");
            FakeServer.write(out, banned("e1", "ns:a") + "id: 11\n\n");
            FakeServer.write(out, ":heartbeat\nid: 15\n\n");
            FakeServer.write(out, "event: future.kind\ndata: {\"id\":\"x\",\"type\":\"future.kind\","
                    + "" + META + "}\nid: 16\n\n");
            holdOpen();
        });
        GameSubscription sub = client.events().subscribe(collect(),
                fast().types(EventType.IDENTITY_LINKED, EventType.GAME_USER_BANNED).build()).get(10, TimeUnit.SECONDS);
        assertEquals("game.user.banned@11", events.poll(10, TimeUnit.SECONDS));
        await(() -> "16".equals(sub.position()), "position 16");
        // The position moves before a frame's event is delivered, so at 16 every earlier frame
        // has been handled.
        assertTrue(events.isEmpty(), "unknown types are skipped");
        assertEquals("types=game.user.banned%2Cidentity.linked", server.requests.get(0).query());
        assertNull(server.requests.get(0).header("Last-Event-ID"));
        assertEquals("text/event-stream", server.requests.get(0).header("Accept"));
        sub.close();
        assertTrue(sub.isClosed());
        assertTrue(errors.isEmpty());
    }

    @Test
    void resumesWithLastEventIdAfterTheServerEndsTheStream() throws Exception {
        AtomicInteger conn = new AtomicInteger();
        List<String> lastIds = new CopyOnWriteArrayList<>();
        server.on("GET", "/v1/events", (req, ex) -> {
            lastIds.add(String.valueOf(req.header("Last-Event-ID")));
            int n = conn.incrementAndGet();
            if (n == 1) {
                OutputStream out = FakeServer.openSse(ex, "10");
                FakeServer.write(out, banned("e1", "ns:a") + "id: 11\n\n:heartbeat\nid: 13\n\n");
                return;
            }
            OutputStream out = FakeServer.openSse(ex, "13");
            FakeServer.write(out, banned("e2", "ns:b") + "id: 14\n\n");
            holdOpen();
        });
        LinkedBlockingQueue<String> reconnected = new LinkedBlockingQueue<>();
        AtomicInteger reconnecting = new AtomicInteger();
        GameSubscription sub = client.events().subscribe(collect(), fast().from("9")
                .onReconnecting(i -> reconnecting.incrementAndGet())
                .onReconnected(reconnected::add).build()).get(10, TimeUnit.SECONDS);
        assertEquals("game.user.banned@11", events.poll(10, TimeUnit.SECONDS));
        assertEquals("game.user.banned@14", events.poll(10, TimeUnit.SECONDS));
        assertEquals("13", reconnected.poll(5, TimeUnit.SECONDS));
        assertEquals(List.of("9", "13"), lastIds);
        assertEquals(1, reconnecting.get());
        sub.close();
        assertTrue(errors.isEmpty());
    }

    @Test
    void expiredPositionResyncsLiveAndReportsTheNewPosition() throws Exception {
        AtomicInteger conn = new AtomicInteger();
        List<String> lastIds = new CopyOnWriteArrayList<>();
        server.on("GET", "/v1/events", (req, ex) -> {
            lastIds.add(String.valueOf(req.header("Last-Event-ID")));
            int n = conn.incrementAndGet();
            if (n == 1) {
                OutputStream out = FakeServer.openSse(ex, "4");
                FakeServer.write(out, banned("e1", "ns:a") + "id: 5\n\n");
            } else if (n == 2) {
                FakeServer.json(ex, 410, FakeServer.error("stream_position_expired", 410, "gone"));
            } else {
                OutputStream out = FakeServer.openSse(ex, "100");
                FakeServer.write(out, banned("e2", "ns:b") + "id: 101\n\n");
                holdOpen();
            }
        });
        LinkedBlockingQueue<String> resyncs = new LinkedBlockingQueue<>();
        GameSubscription sub = client.events().subscribe(collect(), fast().onResync(resyncs::add).build())
                .get(10, TimeUnit.SECONDS);
        assertEquals("game.user.banned@5", events.poll(10, TimeUnit.SECONDS));
        assertEquals("100", resyncs.poll(10, TimeUnit.SECONDS));
        assertEquals("game.user.banned@101", events.poll(10, TimeUnit.SECONDS));
        assertEquals(List.of("null", "5", "null"), lastIds, "the resync opens live, without Last-Event-ID");
        sub.close();
        assertTrue(errors.isEmpty());
    }

    @Test
    void expiredPositionWithoutResyncCallbackIsFatal() throws Exception {
        AtomicInteger conn = new AtomicInteger();
        server.on("GET", "/v1/events", (req, ex) -> {
            if (conn.incrementAndGet() == 1) {
                OutputStream out = FakeServer.openSse(ex, "4");
                FakeServer.write(out, ":heartbeat\nid: 5\n\n");
            } else {
                FakeServer.json(ex, 410, FakeServer.error("stream_position_expired", 410, "gone"));
            }
        });
        GameSubscription sub = client.events().subscribe(collect(), fast().build()).get(10, TimeUnit.SECONDS);
        await(() -> !errors.isEmpty(), "onError");
        assertEquals("stream_position_expired", assertInstanceOf(JunjoException.class, errors.get(0)).code());
        assertTrue(sub.isClosed());
    }

    @Test
    void tooManyStreamsOnReconnectIsFatalAndNotRetried() throws Exception {
        AtomicInteger conn = new AtomicInteger();
        server.on("GET", "/v1/events", (req, ex) -> {
            if (conn.incrementAndGet() == 1) {
                FakeServer.openSse(ex, "1");
            } else {
                FakeServer.json(ex, 429, FakeServer.error("too_many_streams", 429, "limit"));
            }
        });
        GameSubscription sub = client.events().subscribe(collect(), fast().build()).get(10, TimeUnit.SECONDS);
        await(() -> !errors.isEmpty(), "onError");
        assertEquals("too_many_streams", ((JunjoException) errors.get(0)).code());
        // onError runs after the subscription closed and cancelled its reconnect timer, so no
        // later connection can follow.
        assertTrue(sub.isClosed());
        assertEquals(2, conn.get());
        assertEquals(1, errors.size());
        assertTrue(sub.isClosed());
    }

    @Test
    void firstConnectionFailureFailsTheSubscribeFuture() throws Exception {
        server.on("GET", "/v1/events", (req, ex) ->
                FakeServer.json(ex, 429, FakeServer.error("too_many_streams", 429, "limit")));
        try {
            client.events().subscribe(collect(), fast().build()).get(10, TimeUnit.SECONDS);
            fail("expected a failure");
        } catch (ExecutionException e) {
            assertEquals("too_many_streams", assertInstanceOf(JunjoException.class, e.getCause()).code());
        }
        assertEquals(1, server.requests.size());
    }

    @Test
    void transient5xxOnReconnectIsRetried() throws Exception {
        AtomicInteger conn = new AtomicInteger();
        server.on("GET", "/v1/events", (req, ex) -> {
            int n = conn.incrementAndGet();
            if (n == 1) {
                FakeServer.openSse(ex, "1");
            } else if (n < 4) {
                FakeServer.json(ex, 503, FakeServer.error("internal", 503, "deploy"));
            } else {
                OutputStream out = FakeServer.openSse(ex, "1");
                FakeServer.write(out, banned("e9", "ns:z") + "id: 2\n\n");
                holdOpen();
            }
        });
        GameSubscription sub = client.events().subscribe(collect(), fast().build()).get(10, TimeUnit.SECONDS);
        assertEquals("game.user.banned@2", events.poll(10, TimeUnit.SECONDS));
        assertEquals(4, conn.get());
        sub.close();
        assertTrue(errors.isEmpty());
    }

    @Test
    void reconnectDisabledReportsNetworkError() throws Exception {
        server.on("GET", "/v1/events", (req, ex) -> FakeServer.openSse(ex, "1"));
        GameSubscription sub = client.events().subscribe(collect(), fast().reconnect(false).build())
                .get(10, TimeUnit.SECONDS);
        await(() -> !errors.isEmpty(), "onError");
        assertEquals(JunjoException.NETWORK_ERROR, ((JunjoException) errors.get(0)).code());
        assertTrue(sub.isClosed());
    }

    @Test
    void silentConnectionIsDroppedAndResumed() throws Exception {
        AtomicInteger conn = new AtomicInteger();
        server.on("GET", "/v1/events", (req, ex) -> {
            OutputStream out = FakeServer.openSse(ex, "3");
            if (conn.incrementAndGet() >= 2) FakeServer.write(out, banned("e", "ns:q") + "id: 4\n\n");
            holdOpen();
        });
        GameSubscription sub = client.events().subscribe(collect(),
                fast().idleTimeout(Duration.ofMillis(300)).build()).get(10, TimeUnit.SECONDS);
        assertEquals("game.user.banned@4", events.poll(10, TimeUnit.SECONDS));
        assertTrue(conn.get() >= 2);
        sub.close();
    }

    @Test
    void throwingListenerStopsTheSubscription() throws Exception {
        server.on("GET", "/v1/events", (req, ex) -> {
            OutputStream out = FakeServer.openSse(ex, "1");
            FakeServer.write(out, banned("e", "ns:a") + "id: 2\n\n");
            holdOpen();
        });
        GameSubscription sub = client.events().subscribe((e, p) -> {
            throw new IllegalStateException("handler bug");
        }, fast().build()).get(10, TimeUnit.SECONDS);
        await(() -> !errors.isEmpty(), "onError");
        assertInstanceOf(IllegalStateException.class, errors.get(0));
        assertTrue(sub.isClosed());
    }

    @Test
    void closeStopsReadingAndNeverReportsAnError() throws Exception {
        CountDownLatch handlerDone = new CountDownLatch(1);
        server.on("GET", "/v1/events", (req, ex) -> {
            try {
                OutputStream out = FakeServer.openSse(ex, "1");
                for (int i = 0; i < 200; i++) {
                    FakeServer.write(out, ":heartbeat\nid: " + (i + 2) + "\n\n");
                    Thread.sleep(20);
                }
            } finally {
                handlerDone.countDown();
            }
        });
        GameSubscription sub = client.events().subscribe(collect(), fast().build()).get(10, TimeUnit.SECONDS);
        await(() -> Long.parseLong(sub.position()) > 3, "heartbeats");
        sub.close();
        String frozen = sub.position();
        assertTrue(handlerDone.await(10, TimeUnit.SECONDS), "the server sees the disconnect");
        assertEquals(frozen, sub.position());
        assertFalse(errors.stream().findAny().isPresent());
        assertEquals(1, server.requests.size(), "a closed subscription never reconnects");
    }

    @Test
    void missingPositionHeaderIsInvalidWireData() throws Exception {
        server.on("GET", "/v1/events", (req, ex) -> FakeServer.openSse(ex, null));
        try {
            client.events().subscribe(collect(), fast().build()).get(10, TimeUnit.SECONDS);
            fail("expected a failure");
        } catch (ExecutionException e) {
            assertEquals(JunjoException.INVALID_WIRE_DATA, assertInstanceOf(JunjoException.class, e.getCause()).code());
        }
    }
}
