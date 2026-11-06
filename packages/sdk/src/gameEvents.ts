import type { JunjoEvent, JunjoEventType } from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { decodeEventData, readSSEFrames, toError } from "./sse.js";

const DEFAULT_INITIAL_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

// How long a stream must stay open, without delivering a frame, before
// the reconnect backoff starts over.
export const STABLE_STREAM_MS = 10_000;

// Bounds the backoff exponent so `initialDelayMs * 2 ** n` stays finite
// (and never becomes 0 * Infinity = NaN) on a long outage.
const MAX_BACKOFF_EXPONENT = 30;

const POSITION_HEADER = "junjo-stream-position";

/** Per-event context passed to a {@link GameEventsApi.subscribe} handler. */
export interface GameEventMeta {
  /** The stream position of this event's frame; a decimal string. */
  position: string;
}

/** Options for {@link GameEventsApi.subscribe}. */
export interface GameSubscribeOptions {
  /** Deliver only these event types. Omitted or empty means every type. */
  types?: JunjoEventType[];
  /**
   * Resume after this stream position (sent as `Last-Event-ID`).
   * Omitted means live from the moment the server accepts the stream.
   */
  from?: string;
  /**
   * Aborting closes the subscription (equivalent to `close()`), including
   * a pending reconnect. Aborting before the first connection is
   * established rejects `subscribe` with JunjoError code "cancelled".
   */
  signal?: AbortSignal;
  /**
   * Reconnect after the server ends an established stream, resuming from
   * the last position seen. Defaults to true with a 1000 ms initial and
   * 30000 ms maximum delay (full jitter, doubling per attempt until a
   * stream stays up).
   * With false, a server-initiated end stops the subscription and fires
   * `onError` with JunjoError code "network_error".
   */
  reconnect?: boolean | { initialDelayMs?: number; maxDelayMs?: number };
  /**
   * Called when a reconnect found the last position expired (410
   * `stream_position_expired`). By then a new stream is already open,
   * live from `position`; events between the old position and it were
   * not delivered, so state built from the stream must be reloaded.
   * Without this callback an expired position is fatal.
   */
  onResync?: (info: { position: string }) => void;
  /**
   * Called before each reconnect wait. `attempt` is 1 for the first
   * retry after a drop. It starts over once a stream has delivered a
   * frame or stayed open for 10 seconds, so a stream that drops right
   * after opening keeps backing off; `error`
   * is the transport failure or rejected reconnect that caused it, and
   * is absent for a clean server close.
   */
  onReconnecting?: (info: { attempt: number; delayMs: number; error?: Error }) => void;
  /**
   * Called after a reconnect re-established the stream, resuming after
   * `position`. A resync reports through `onResync` instead.
   */
  onReconnected?: (info: { position: string }) => void;
  /**
   * Called once when the subscription stops on its own: a fatal
   * reconnect answer (any 4xx other than 408 and a handled 410), a
   * malformed frame, the frame size cap, a throwing handler, or a
   * server-initiated end with reconnect disabled. Never called after
   * `close()` or an abort.
   */
  onError?: (err: Error) => void;
}

/** Handle for an open game event stream. */
export interface GameSubscription {
  /** Stops the stream and any pending reconnect; idempotent. */
  close(): void;
  /** The last stream position seen; a decimal string. */
  readonly position: string;
}

interface OpenedStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  start: string;
}

// A rejected reconnect is retried only when it looks transient:
// transport failures (no status), 5xx, and 408. Every other 4xx means
// the request itself is refused (bad input, credential, limit) and
// would fail the same way forever. 410 is classified separately.
function isFatalStatus(err: Error): boolean {
  const status = err instanceof JunjoError ? err.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

function isExpired(err: Error): boolean {
  return err instanceof JunjoError && err.status === 410;
}

/**
 * The game-wide event stream: every event in the game, in commit order,
 * each tagged with a gapless stream position that a reconnect resumes
 * from.
 */
export class GameEventsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * The game's current stream position (GET /v1/events/position). A
   * snapshot read after this call reflects every event up to it.
   */
  async position(opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
    const wire = await this.http.get<{ position?: unknown }>("/v1/events/position", {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    if (typeof wire?.position !== "string") {
      throw new JunjoError("position response carried no position", "invalid_wire_data");
    }
    return wire.position;
  }

  /**
   * Opens the game event stream (SSE). Resolves once the server accepts
   * the first connection; any failure of that first connection rejects
   * with its JunjoError and is not retried. After that, a server-side
   * end reconnects from the last position seen (see `reconnect`), so
   * the handler sees each event at most once and, short of an expired
   * position, none are skipped. Positions are decimal strings that can
   * exceed Number's exact range; compare them with BigInt.
   */
  async subscribe(
    handler: (event: JunjoEvent, meta: GameEventMeta) => void,
    opts: GameSubscribeOptions = {},
  ): Promise<GameSubscription> {
    if (opts.signal?.aborted) {
      throw new JunjoError("request cancelled", "cancelled");
    }
    const types = opts.types ?? [];
    const path =
      types.length > 0
        ? `/v1/events?${new URLSearchParams({ types: types.join(",") }).toString()}`
        : "/v1/events";
    const reconnectOpt = opts.reconnect ?? true;
    const reconnectEnabled = reconnectOpt !== false;
    const backoff = typeof reconnectOpt === "object" ? reconnectOpt : {};
    const initialDelayMs = backoff.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    const maxDelayMs = backoff.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

    let closed = false;
    let position = "";
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    // The connection currently being opened or read; close() tears down
    // whichever exists.
    let controller: AbortController | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    const callerSignal = opts.signal;
    // Upgraded to the full close() once the first connection is up.
    let onAbort: () => void = () => controller?.abort();
    const onCallerAbort = () => onAbort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    const open = async (from: string | undefined): Promise<OpenedStream> => {
      const ctrl = new AbortController();
      controller = ctrl;
      const res = await this.http.openStream(path, {
        signal: ctrl.signal,
        ...(from !== undefined ? { headers: { "last-event-id": from } } : {}),
      });
      const body = res.body?.getReader();
      const start = res.headers.get(POSITION_HEADER) ?? from;
      if (body === undefined || start === undefined) {
        ctrl.abort();
        body?.cancel().catch(() => undefined);
        throw new JunjoError(
          body === undefined
            ? "response has no body"
            : "game stream response carried no Junjo-Stream-Position header",
          "invalid_wire_data",
          res.status,
        );
      }
      reader = body;
      return { reader: body, start };
    };

    const close = () => {
      if (closed) return;
      closed = true;
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      stableTimer = undefined;
      controller?.abort();
      reader?.cancel().catch(() => undefined);
    };

    const fail = (err: Error) => {
      if (closed) return;
      close();
      opts.onError?.(err);
    };

    // The timer is armed before onReconnecting runs, so a close() from
    // inside the callback also cancels the wait.
    const schedule = (error?: Error) => {
      const cap = Math.min(
        maxDelayMs,
        initialDelayMs * 2 ** Math.min(attempt, MAX_BACKOFF_EXPONENT),
      );
      const delayMs = Math.floor(Math.random() * cap);
      attempt += 1;
      timer = setTimeout(() => {
        timer = undefined;
        void reconnect();
      }, delayMs);
      opts.onReconnecting?.({ attempt, delayMs, ...(error !== undefined ? { error } : {}) });
    };

    const onConnectError = (err: Error) => {
      if (closed) return;
      if (isExpired(err)) {
        if (opts.onResync === undefined) fail(err);
        else void resync();
      } else if (isFatalStatus(err)) {
        fail(err);
      } else {
        schedule(err);
      }
    };

    // The backoff starts over only once a stream has proven itself by
    // delivering a frame or staying open for STABLE_STREAM_MS. A stream
    // that opens and drops at once keeps the backoff growing instead
    // of reconnecting at the initial delay forever.
    const markStable = () => {
      attempt = 0;
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      stableTimer = undefined;
    };
    const watchStability = () => {
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      stableTimer = setTimeout(markStable, STABLE_STREAM_MS);
      // Never hold the event loop open for this timer alone.
      if (typeof (stableTimer as { unref?: () => void }).unref === "function") {
        (stableTimer as unknown as { unref: () => void }).unref();
      }
    };

    const onStreamEnd = (error?: Error) => {
      if (stableTimer !== undefined) clearTimeout(stableTimer);
      stableTimer = undefined;
      if (closed) return;
      if (!reconnectEnabled) {
        fail(
          new JunjoError(
            "game event stream ended by the server",
            "network_error",
            undefined,
            error !== undefined ? { cause: error } : undefined,
          ),
        );
        return;
      }
      schedule(error);
    };

    // Frame errors (malformed JSON, a throwing handler) end the
    // subscription through fail(), which flips `closed` and stops the
    // reader; only transport failures and the buffer cap reach the
    // rejection branch. The position advances on every frame that
    // carries an id, including heartbeats and skipped unknown types, so
    // a reconnect never replays frames already seen.
    const pump = (body: ReadableStreamDefaultReader<Uint8Array>) => {
      watchStability();
      readSSEFrames(
        body,
        () => closed,
        (frame) => {
          markStable();
          let event: JunjoEvent | null = null;
          try {
            if (frame.data !== undefined) event = decodeEventData(frame.data);
            if (frame.id !== undefined) position = frame.id;
            if (event !== null) handler(event, { position });
          } catch (err) {
            fail(toError(err));
          }
        },
      ).then(
        () => onStreamEnd(),
        (err) => {
          const error = toError(err);
          if (error instanceof JunjoError && error.code === "stream_overflow") fail(error);
          else onStreamEnd(error);
        },
      );
    };

    const reconnect = async () => {
      if (closed) return;
      let opened: OpenedStream;
      try {
        opened = await open(position);
      } catch (err) {
        onConnectError(toError(err));
        return;
      }
      if (closed) {
        opened.reader.cancel().catch(() => undefined);
        return;
      }
      position = opened.start;
      pump(opened.reader);
      opts.onReconnected?.({ position });
    };

    // The live stream is opened BEFORE onResync fires, so every event
    // committed while the caller reloads its state is still delivered.
    // A 410 here cannot be cured by another resync, so it is fatal.
    const resync = async () => {
      let opened: OpenedStream;
      try {
        opened = await open(undefined);
      } catch (err) {
        const error = toError(err);
        if (isExpired(error)) fail(error);
        else onConnectError(error);
        return;
      }
      if (closed) {
        opened.reader.cancel().catch(() => undefined);
        return;
      }
      position = opened.start;
      pump(opened.reader);
      opts.onResync?.({ position });
    };

    let first: OpenedStream;
    try {
      first = await open(opts.from);
    } catch (err) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      throw err;
    }
    // An abort that landed after the response arrived but before the
    // handle exists still cancels the subscription.
    if (callerSignal?.aborted) {
      close();
      throw new JunjoError("request cancelled", "cancelled");
    }
    onAbort = close;
    position = first.start;
    pump(first.reader);

    return {
      close,
      get position() {
        return position;
      },
    };
  }
}
