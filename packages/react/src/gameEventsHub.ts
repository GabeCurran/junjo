import type { GameEventMeta, GameSubscription, Junjo } from "@junjo.io/sdk";
import type { JunjoEvent } from "@junjo.io/shared";
import { createContext, useContext } from "react";

/** Connection state of the shared game stream, as seen by listeners. */
export type GameStreamStatus = "connecting" | "open" | "reconnecting";

/** Listener registered through {@link GameEventsHub.subscribe}. */
export interface GameHubListener {
  /** Receives every event on the shared, unfiltered game stream. */
  onEvent: (event: JunjoEvent, meta: GameEventMeta) => void;
  /**
   * Receives connection state changes, with the stream position known at
   * that moment (null before the first connection is up). A listener
   * that joins an already-open stream is told its state at once.
   */
  onStatus?: (status: GameStreamStatus, position: string | null) => void;
  /** Receives the SDK's resync signal; the live stream is already open. */
  onResync?: (info: { position: string }) => void;
  /**
   * Receives a fatal failure: the first connection was refused, or the
   * SDK stopped the subscription. The shared stream is torn down first.
   */
  onError?: (err: Error) => void;
}

interface Entry {
  listeners: Set<GameHubListener>;
  // Null while the first connection is still being established.
  subscription: GameSubscription | null;
  // Set by teardown. A handshake that resolves after teardown closes
  // itself; callbacks arriving after teardown are dropped.
  closed: boolean;
  status: GameStreamStatus;
  position: string | null;
}

/**
 * Refcounted fan-out over ONE unfiltered `junjo.events.subscribe`
 * stream per client. The server caps open game streams per API key, so
 * every hook shares this one connection and filters on its own side.
 * The first listener opens the stream and the last one closes it.
 *
 * Reconnection belongs to the SDK; the hub only relays its state. After
 * a fatal error the hub discards the stream and notifies the current
 * listeners; they are not carried over, and the next subscribe opens a
 * fresh stream.
 */
export class GameEventsHub {
  private entry: Entry | null = null;

  constructor(private readonly junjo: Junjo) {}

  /**
   * Registers a listener, opening the shared stream if none is open.
   * Returns an idempotent unsubscribe; the last unsubscribe closes the
   * stream.
   */
  subscribe(listener: GameHubListener): () => void {
    const entry = this.entry ?? this.open();
    entry.listeners.add(listener);
    if (entry.status !== "connecting") {
      try {
        listener.onStatus?.(entry.status, entry.position);
      } catch {
        // Isolated like every other notification; see fan().
      }
    }
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // After a teardown the entry is gone, and a newer one may have
      // replaced it. Only mutate the entry this listener joined.
      if (this.entry !== entry) return;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.teardown(entry);
    };
  }

  private open(): Entry {
    const entry: Entry = {
      listeners: new Set(),
      subscription: null,
      closed: false,
      status: "connecting",
      position: null,
    };
    this.entry = entry;
    const setStatus = (status: GameStreamStatus, position: string | null) => {
      entry.status = status;
      entry.position = position;
      this.fan(entry, (l) => l.onStatus?.(status, position));
    };
    void this.junjo.events
      .subscribe(
        (event, meta) => {
          if (entry.closed) return;
          entry.position = meta.position;
          // A listener throw must never reach the SDK, which treats a
          // throwing handler as fatal for the shared stream.
          this.fan(entry, (l) => l.onEvent(event, meta));
        },
        {
          onReconnecting: () => {
            if (entry.closed) return;
            setStatus("reconnecting", entry.position);
          },
          onReconnected: ({ position }) => {
            if (entry.closed) return;
            setStatus("open", position);
          },
          onResync: (info) => {
            if (entry.closed) return;
            setStatus("open", info.position);
            this.fan(entry, (l) => l.onResync?.(info));
          },
          onError: (err) => {
            if (entry.closed) return;
            this.teardown(entry);
            this.fan(entry, (l) => l.onError?.(err));
          },
        },
      )
      .then(
        (sub) => {
          // Every listener left while the handshake was in flight.
          if (entry.closed) {
            sub.close();
            return;
          }
          entry.subscription = sub;
          setStatus("open", sub.position);
        },
        (err) => {
          if (entry.closed) return;
          this.teardown(entry);
          this.fan(entry, (l) => l.onError?.(err instanceof Error ? err : new Error(String(err))));
        },
      );
    return entry;
  }

  // Notifies every listener, isolating throws so one broken listener
  // cannot starve the others. The snapshot means a listener that leaves
  // mid-fan still receives this in-flight notification, and nothing
  // after it.
  private fan(entry: Entry, notify: (listener: GameHubListener) => void): void {
    for (const listener of [...entry.listeners]) {
      try {
        notify(listener);
      } catch {
        // Intentionally swallowed; see above.
      }
    }
  }

  // Drops the shared stream. Listeners stay on the orphaned entry so a
  // teardown-then-fan sequence can still notify them.
  private teardown(entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (this.entry === entry) this.entry = null;
    entry.subscription?.close();
    entry.subscription = null;
  }
}

export const GameEventsHubContext = createContext<GameEventsHub | null>(null);

export function useGameEventsHub(): GameEventsHub {
  const hub = useContext(GameEventsHubContext);
  if (hub === null) {
    throw new Error("Game events hub missing; useGameEvents must be used inside a <JunjoProvider>");
  }
  return hub;
}
