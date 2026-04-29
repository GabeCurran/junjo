import type { GroupId, JunjoEvent } from "@junjo/shared";

// Listener invoked once per event matching the subscribed group. Listeners
// are called synchronously in registration order; failures in one listener
// do not interrupt the others.
export type EventListener = (event: JunjoEvent) => void;

// In-process pub/sub bus keyed by groupId. The SSE route subscribes; the
// mutation routes call `publish`. There is no persistence and no fan-out
// across processes: a horizontally-scaled deployment will need a
// transport-level bus (Redis, NATS, Postgres LISTEN/NOTIFY) plugged in
// behind this same interface. V1 is single-process by design.
export class EventHub {
  private readonly subscribers = new Map<string, Set<EventListener>>();

  subscribe(groupId: GroupId, listener: EventListener): () => void {
    let set = this.subscribers.get(groupId);
    if (!set) {
      set = new Set();
      this.subscribers.set(groupId, set);
    }
    set.add(listener);
    return () => {
      const current = this.subscribers.get(groupId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.subscribers.delete(groupId);
    };
  }

  publish(event: JunjoEvent): void {
    const set = this.subscribers.get(event.groupId);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Swallow listener errors so one misbehaving subscriber cannot
        // starve the others. Listeners are responsible for their own
        // observability.
      }
    }
  }

  subscriberCount(groupId: GroupId): number {
    return this.subscribers.get(groupId)?.size ?? 0;
  }

  clear(): void {
    this.subscribers.clear();
  }
}

export const eventHub = new EventHub();
