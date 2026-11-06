package io.junjo.sdk.events;

/**
 * Receives game stream events, one at a time, in position order, on the stream's reader thread.
 * A throwing listener stops the subscription and is reported to {@code onError}.
 */
@FunctionalInterface
public interface GameEventListener {
    /** {@code position} is the stream position of the event's frame, a decimal string. */
    void onEvent(JunjoEvent event, String position);
}
