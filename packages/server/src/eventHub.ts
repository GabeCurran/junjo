import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import { isGroupScopedEvent } from "@junjo.io/shared";

export type EventListener = (event: JunjoEvent) => void;

// In-process pub/sub bus. Group listeners receive the events of one
// group; game listeners are told about every event of one game and use
// it as a wake-up to read the durable event log, which is what carries
// game streams across processes. No persistence here and no fan-out
// across processes: group streams in a horizontally-scaled deployment
// still need a transport-level bus behind this same interface.
export class EventHub {
  private readonly subscribers = new Map<string, Set<EventListener>>();
  private readonly gameSubscribers = new Map<string, Set<EventListener>>();

  subscribe(groupId: GroupId, listener: EventListener): () => void {
    return addListener(this.subscribers, groupId, listener);
  }

  subscribeGame(gameId: string, listener: EventListener): () => void {
    return addListener(this.gameSubscribers, gameId, listener);
  }

  publish(event: JunjoEvent): void {
    notify(this.gameSubscribers.get(event.gameId), event);
    // Events without a groupId (friends, game bans, identity links)
    // reach no group listener.
    if (!isGroupScopedEvent(event)) return;
    notify(this.subscribers.get(event.groupId), event);
  }

  subscriberCount(groupId: GroupId): number {
    return this.subscribers.get(groupId)?.size ?? 0;
  }

  gameSubscriberCount(gameId: string): number {
    return this.gameSubscribers.get(gameId)?.size ?? 0;
  }

  clear(): void {
    this.subscribers.clear();
    this.gameSubscribers.clear();
  }
}

function addListener(
  map: Map<string, Set<EventListener>>,
  key: string,
  listener: EventListener,
): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) map.delete(key);
  };
}

function notify(set: Set<EventListener> | undefined, event: JunjoEvent): void {
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

export const eventHub = new EventHub();
