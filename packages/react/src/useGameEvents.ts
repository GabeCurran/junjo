import type { GameEventMeta } from "@junjo.io/sdk";
import type { JunjoEvent, JunjoEventType } from "@junjo.io/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGameEventsHub } from "./gameEventsHub.js";

/** Connection state reported by {@link useGameEvents}. */
export type UseGameEventsStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface UseGameEventsOptions {
  /** Deliver only these event types. Omitted or empty means every type. */
  types?: JunjoEventType[];
  /** False detaches from the stream and reports "closed". Defaults to true. */
  enabled?: boolean;
  /**
   * Called when the stream's resume position expired and a new live
   * stream replaced it; events in the gap were not delivered.
   */
  onResync?: (info: { position: string }) => void;
}

export interface UseGameEventsResult {
  status: UseGameEventsStatus;
  /** The fatal error that stopped the stream; null otherwise. */
  error: Error | null;
  /**
   * The newest stream position this hook knows: the stream's start or
   * resume position, or the position of the last event delivered to it.
   * Null until the stream is open.
   */
  position: string | null;
}

const CLOSED: UseGameEventsResult = { status: "closed", error: null, position: null };
const CONNECTING: UseGameEventsResult = { status: "connecting", error: null, position: null };

/**
 * Delivers game-wide events to `handler` from the provider's single
 * shared game stream; every mounted hook rides the same connection and
 * filters by `types` on the client. The latest `handler`, `types` and
 * `onResync` are read at delivery time, so changing them never reopens
 * the stream. Reconnection is the SDK's; this hook reports it through
 * `status`. A fatal error leaves `status` "closed" with `error` set;
 * remount or toggle `enabled` to open a fresh stream. A throwing
 * handler is isolated by the hub and does not affect the stream.
 */
export function useGameEvents(
  handler: (event: JunjoEvent, meta: GameEventMeta) => void,
  opts: UseGameEventsOptions = {},
): UseGameEventsResult {
  const hub = useGameEventsHub();
  const enabled = opts.enabled ?? true;

  // Compared by sorted value so a fresh array literal each render does
  // not rebuild the filter.
  const typesKey = opts.types === undefined ? "" : [...opts.types].sort().join(",");
  const typeFilter = useMemo(
    () => (typesKey === "" ? null : new Set(typesKey.split(","))),
    [typesKey],
  );

  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const typeFilterRef = useRef(typeFilter);
  typeFilterRef.current = typeFilter;
  const onResyncRef = useRef(opts.onResync);
  onResyncRef.current = opts.onResync;

  const [state, setState] = useState<UseGameEventsResult>(enabled ? CONNECTING : CLOSED);

  useEffect(() => {
    if (!enabled) {
      setState(CLOSED);
      return;
    }
    setState(CONNECTING);
    return hub.subscribe({
      onEvent: (event, meta) => {
        const filter = typeFilterRef.current;
        if (filter !== null && !filter.has(event.type)) return;
        setState((s) => (s.position === meta.position ? s : { ...s, position: meta.position }));
        handlerRef.current(event, meta);
      },
      onStatus: (status, position) => {
        setState((s) => ({ status, error: null, position: position ?? s.position }));
      },
      onResync: (info) => {
        onResyncRef.current?.(info);
      },
      onError: (err) => {
        setState((s) => ({ ...s, status: "closed", error: err }));
      },
    });
  }, [hub, enabled]);

  return state;
}
