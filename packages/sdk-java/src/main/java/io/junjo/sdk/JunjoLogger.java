package io.junjo.sdk;

/**
 * The SDK's only logging seam. The SDK depends on no logging framework; it reports through this
 * interface, and the default implementation discards everything.
 *
 * <p>Implementations are called from SDK threads (HTTP callbacks, stream readers, the mirror's
 * applier and the queue's drain thread) and must be thread-safe and quick. A throwing logger is
 * caught and ignored.
 */
public interface JunjoLogger {
    /** A logger that discards every message. */
    JunjoLogger NONE = new JunjoLogger() {
        @Override
        public void log(Level level, String message, Throwable error) {}

        @Override
        public boolean isEnabled(Level level) {
            return false;
        }
    };

    /** Message severity. */
    enum Level {
        /** Detail useful only while diagnosing the SDK. */
        DEBUG,
        /** Lifecycle changes: connects, reconnects, resyncs. */
        INFO,
        /** A recoverable failure the SDK is retrying or working around. */
        WARN,
        /** A failure the SDK could not recover from on its own. */
        ERROR
    }

    /** Records one message; {@code error} may be null. */
    void log(Level level, String message, Throwable error);

    /** Lets the SDK skip building messages nobody reads. */
    default boolean isEnabled(Level level) {
        return true;
    }
}
