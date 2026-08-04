import type { GroupId, JunjoEvent } from "@junjo-io/shared";
import { isGroupScopedEvent } from "@junjo-io/shared";

export type EventListener = (event: JunjoEvent) => void;

// In-process pub/sub bus keyed by groupId. No persistence, no fan-out
// across processes: a horizontally-scaled deployment will need a
// transport-level bus (Redis, NATS, Postgres LISTEN/NOTIFY) behind this
// same interface. V1 is single-process by design.
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
    // User-scoped events (friends, blocks) have no groupId and are not
    // routed through the per-group SSE channels. They reach consumers
    // via webhook delivery only in V1; a per-user SSE channel is a
    // post-V1 addition.
    if (!isGroupScopedEvent(event)) return;
    const set = this.subscribers.get(event.groupId);
    if (!set || set.size === 0) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // Swallow so one misbehaving subscriber cannot starve the others;
        // listeners own their observability.
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
