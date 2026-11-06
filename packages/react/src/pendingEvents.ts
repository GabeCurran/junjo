import type { JunjoEvent } from "@junjo.io/shared";

/** What a {@link PendingEvents} held while a fetch was in flight. */
export interface HeldStream {
  /** Events in arrival order. */
  events: JunjoEvent[];
  /** The stream failure or close that arrived, if any. */
  failure: Error | null;
}

/**
 * Holds what a group stream delivers while a snapshot fetch is in
 * flight. The hooks subscribe before they fetch, so an event can land
 * before the snapshot does; applied at once it would be overwritten by
 * the snapshot, and a stream failure would be cleared by it. Both are
 * held and applied after the snapshot instead. Replaying events in
 * arrival order converges on the latest state: every event since the
 * subscription opened is in the replay, and each one is safe to apply
 * to a snapshot that already reflects it.
 */
export class PendingEvents {
  private events: JunjoEvent[] | null = null;
  private failure: Error | null = null;

  /** Starts holding; keeps anything already held by an earlier fetch. */
  begin(): void {
    this.events ??= [];
  }

  /** Holds `event` and returns true while a fetch is in flight. */
  hold(event: JunjoEvent): boolean {
    if (this.events === null) return false;
    this.events.push(event);
    return true;
  }

  /**
   * Holds a stream failure and returns true while a fetch is in flight.
   * Only the first is kept: the hub tears the stream down on it.
   */
  holdFailure(err: Error): boolean {
    if (this.events === null) return false;
    this.failure ??= err;
    return true;
  }

  /** Stops holding and returns what was held. */
  drain(): HeldStream {
    const held: HeldStream = { events: this.events ?? [], failure: this.failure };
    this.events = null;
    this.failure = null;
    return held;
  }

  /** Drops everything held and stops holding. */
  clear(): void {
    this.events = null;
    this.failure = null;
  }
}
