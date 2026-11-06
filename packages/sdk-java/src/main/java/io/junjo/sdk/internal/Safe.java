package io.junjo.sdk.internal;

import io.junjo.sdk.JunjoLogger;
import java.util.function.Consumer;
import java.util.function.Supplier;

/**
 * Calls into caller-supplied code (loggers and callbacks) from SDK threads. A logger or callback
 * that throws must never break a request, a stream, the mirror or the queue, so every such call
 * goes through here.
 *
 * <p>Internal: not part of the supported API.
 */
public final class Safe {
    private Safe() {}

    /** Logs when the level is enabled; a throwing logger is ignored, as {@link JunjoLogger} allows. */
    public static void log(JunjoLogger logger, JunjoLogger.Level level, String message, Throwable error) {
        try {
            if (logger.isEnabled(level)) logger.log(level, message, error);
        } catch (RuntimeException ignored) {
            // The logger contract says a throwing logger is ignored.
        }
    }

    /** Builds the message only when debug logging is enabled. */
    public static void debug(JunjoLogger logger, Supplier<String> message) {
        try {
            if (logger.isEnabled(JunjoLogger.Level.DEBUG)) logger.log(JunjoLogger.Level.DEBUG, message.get(), null);
        } catch (RuntimeException ignored) {
            // The logger contract says a throwing logger is ignored.
        }
    }

    /**
     * Runs a callback that may be null. A throw is logged at WARN under {@code name} and swallowed,
     * so the SDK thread that called it carries on.
     */
    public static <T> void accept(JunjoLogger logger, String name, Consumer<T> callback, T value) {
        if (callback == null) return;
        try {
            callback.accept(value);
        } catch (RuntimeException e) {
            log(logger, JunjoLogger.Level.WARN, name + " callback threw", e);
        }
    }
}
