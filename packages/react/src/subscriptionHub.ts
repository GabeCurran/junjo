import type { Junjo, Subscription } from "@junjo.io/sdk";
import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import { createContext, useContext } from "react";

/** Per-group listener registered through {@link SubscriptionHub.subscribe}. */
export interface HubListener {
  /** Receives every event from the group's shared stream. */
  onEvent: (event: JunjoEvent) => void;
  /**
   * Receives stream-level failures: a rejected subscribe handshake or a
   * mid-stream error. The shared stream is torn down before this fires.
   */
  onError?: (err: Error) => void;
  /**
   * Receives server-initiated clean closes (a deploy, a proxy idle
   * timeout). The shared stream is torn down before this fires.
   */
  onClose?: () => void;
}

/**
 * Error surfaced by the hooks when the server closes a group's event
 * stream cleanly (a deploy, a proxy idle timeout). It rides the same
 * error surface as real stream failures, but it means something
 * different: the loaded snapshot is still valid; only the live feed
 * has stopped. There is no automatic reconnect because the server has
 * no event replay, so a silently reopened stream would hide a gap the
 * consumer cannot detect. Recover by remounting the hook or changing
 * groupId, which refetches a fresh snapshot and opens a new stream.
 * Distinguish it from real failures with {@link isStreamClosedError}.
 */
export class JunjoStreamClosedError extends Error {
  constructor() {
    super("group event stream closed by the server; remount or change groupId to resubscribe");
    this.name = "JunjoStreamClosedError";
  }
}

/**
 * True when `err` is the clean-close signal described on
 * {@link JunjoStreamClosedError}; false for handshake rejections and
 * mid-stream failures. Matches on the error name as well as the
 * prototype so duplicated copies of this package still agree.
 */
export function isStreamClosedError(err: unknown): err is JunjoStreamClosedError {
  return (
    err instanceof JunjoStreamClosedError ||
    (err instanceof Error && err.name === "JunjoStreamClosedError")
  );
}

interface Entry {
  listeners: Set<HubListener>;
  // The resolved SDK subscription; null while the handshake is still
  // in flight.
  subscription: Subscription | null;
  // Set by teardown. A handshake that resolves after teardown closes
  // itself; callbacks arriving after teardown are dropped.
  closed: boolean;
}

/**
 * Refcounted per-group SSE fan-out. The first listener for a groupId
 * opens ONE `junjo.groups.subscribe` stream; later listeners share it;
 * the last unsubscribe closes it. Three hooks on one group page cost
 * one server connection instead of three.
 *
 * Failure policy (matches the SDK's no-replay stance, no silent
 * auto-reconnect): on a stream error the hub tears the shared stream
 * down and fans the error to every listener's onError; on a
 * server-initiated close it tears down and fans onClose. Listeners are
 * NOT re-attached to a future stream: the entry is discarded, and the
 * next subscribe call for that groupId opens a fresh one. Hooks
 * translate both signals into their streamError surface and recover
 * the way they always have (remount / groupId change).
 */
export class SubscriptionHub {
  private readonly entries = new Map<GroupId, Entry>();

  constructor(private readonly junjo: Junjo) {}

  /**
   * Registers a listener on the group's shared stream, opening it if
   * this is the first listener. Returns an idempotent unsubscribe; the
   * last unsubscribe closes the underlying stream.
   */
  subscribe(groupId: GroupId, listener: HubListener): () => void {
    let entry = this.entries.get(groupId);
    if (entry === undefined) {
      entry = this.open(groupId);
    }
    entry.listeners.add(listener);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      // After a teardown (stream error, server close) the entry is
      // already gone, and a newer entry for the same groupId may have
      // replaced it. Only mutate the entry this listener joined.
      if (this.entries.get(groupId) !== entry) return;
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) this.teardown(groupId, entry);
    };
  }

  private open(groupId: GroupId): Entry {
    const entry: Entry = { listeners: new Set(), subscription: null, closed: false };
    this.entries.set(groupId, entry);
    void this.junjo.groups
      .subscribe(
        groupId,
        (event) => {
          // Never let a listener throw escape into the SDK: it would
          // treat the throw as a stream error and kill the shared
          // stream for every other listener.
          this.fan(entry, (l) => l.onEvent(event));
        },
        {
          onError: (err) => {
            // A consumer-initiated teardown can race the SDK callback;
            // the consumer asked for silence, so honor it.
            if (entry.closed) return;
            this.teardown(groupId, entry);
            this.fan(entry, (l) => l.onError?.(err));
          },
          onClose: () => {
            if (entry.closed) return;
            this.teardown(groupId, entry);
            this.fan(entry, (l) => l.onClose?.());
          },
        },
      )
      .then(
        (sub) => {
          // Teardown ran while the handshake was in flight (every
          // listener left); the stream nobody wants gets closed here.
          if (entry.closed) {
            sub.close();
            return;
          }
          entry.subscription = sub;
        },
        (err) => {
          if (entry.closed) return;
          this.teardown(groupId, entry);
          this.fan(entry, (l) => l.onError?.(err instanceof Error ? err : new Error(String(err))));
        },
      );
    return entry;
  }

  // Fan a notification to every listener, isolating throws: one broken
  // listener must not starve its neighbors (or, via the SDK's
  // throw-kills-stream contract, the stream itself). The snapshot means
  // a listener that unsubscribes mid-fan still receives this in-flight
  // notification; it receives nothing afterward.
  private fan(entry: Entry, notify: (listener: HubListener) => void): void {
    for (const listener of [...entry.listeners]) {
      try {
        notify(listener);
      } catch {
        // Intentionally swallowed; see above.
      }
    }
  }

  // Drops the shared stream. Listeners stay on the (now-orphaned) entry
  // so a teardown-then-fan sequence can still notify them.
  private teardown(groupId: GroupId, entry: Entry): void {
    if (entry.closed) return;
    entry.closed = true;
    if (this.entries.get(groupId) === entry) this.entries.delete(groupId);
    entry.subscription?.close();
    entry.subscription = null;
  }
}

export const SubscriptionHubContext = createContext<SubscriptionHub | null>(null);

export function useSubscriptionHub(): SubscriptionHub {
  const hub = useContext(SubscriptionHubContext);
  if (hub === null) {
    throw new Error("Subscription hub missing; group hooks must be used inside a <JunjoProvider>");
  }
  return hub;
}
