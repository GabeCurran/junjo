package io.junjo.sdk.internal;

import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Thread factories for the SDK's own threads. Every SDK thread is a daemon so a forgotten
 * {@code close()} never keeps a host process alive.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Threads {
    private Threads() {}

    public static ThreadFactory daemonFactory(String prefix) {
        AtomicInteger seq = new AtomicInteger();
        return r -> {
            Thread t = new Thread(r, prefix + "-" + seq.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    /** Starts a named daemon thread. */
    public static Thread start(String name, Runnable body) {
        Thread t = new Thread(body, name);
        t.setDaemon(true);
        t.start();
        return t;
    }
}
