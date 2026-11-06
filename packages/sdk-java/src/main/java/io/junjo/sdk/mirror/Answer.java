package io.junjo.sdk.mirror;

/** A three-valued answer from local state: {@link #UNKNOWN} when the state is not loaded. */
public enum Answer {
    /** The loaded state says yes. */
    YES,
    /** The loaded state says no. */
    NO,
    /** The state needed to answer is not loaded (yet). */
    UNKNOWN;

    public static Answer of(boolean value) {
        return value ? YES : NO;
    }

    /** The answer as a boolean, with {@code fallback} standing in for {@link #UNKNOWN}. */
    public boolean orElse(boolean fallback) {
        return this == UNKNOWN ? fallback : this == YES;
    }
}
