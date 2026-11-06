package io.junjo.sdk;

import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.fail;

import io.junjo.sdk.internal.ClientAccess;
import io.junjo.sdk.internal.Transport;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;

/** Helpers every test shares. */
public final class TestSupport {
    public static final Duration WAIT = Duration.ofSeconds(30);

    private TestSupport() {}

    public static <T> T join(CompletableFuture<T> f) throws Exception {
        return f.get(WAIT.toMillis(), TimeUnit.MILLISECONDS);
    }

    /** The JunjoException a future failed with; fails the test when it succeeds instead. */
    public static JunjoException failure(CompletableFuture<?> f) throws Exception {
        try {
            f.get(WAIT.toMillis(), TimeUnit.MILLISECONDS);
        } catch (ExecutionException e) {
            return assertInstanceOf(JunjoException.class, e.getCause());
        }
        fail("expected a failure");
        return null;
    }

    /** Polls a condition that another thread makes true; fails after {@link #WAIT}. */
    public static void await(BooleanSupplier condition, String what) throws InterruptedException {
        long deadline = System.nanoTime() + WAIT.toNanos();
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) fail("timed out waiting for " + what);
            Thread.sleep(10);
        }
    }

    /** A client for a test server, with a short request timeout. */
    public static JunjoClient client(String baseUrl) {
        return JunjoClient.builder().baseUrl(baseUrl).apiKey("k").requestTimeout(Duration.ofSeconds(5)).build();
    }

    public static Transport transport(JunjoClient client) {
        return ClientAccess.transport(client);
    }
}
