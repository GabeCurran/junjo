import type { PrismaClient } from "@prisma/client";
import type { Context, Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { Errors } from "../errors.js";
import { type EventHub, eventHub as defaultHub } from "../eventHub.js";
import { type LoggedEvent, hasEventAfter, readEventLog, readStreamPosition } from "../eventLog.js";
import { renderEvent } from "../eventRender.js";
import { EVENT_LOG_PAGE, type GameFeed, type GameFeedOptions, GameFeeds } from "../gameFeed.js";
import { currentPreferredNamespaces } from "../requestContext.js";
import { SSE_HEARTBEAT_INTERVAL_MS, recheckStreamKey, renderTableFor } from "./events.js";
import { WEBHOOK_EVENT_TYPES } from "./webhooks.schema.js";

export const STREAM_POSITION_HEADER = "Junjo-Stream-Position";
export const MAX_GAME_STREAMS_PER_KEY = 10;
export const MAX_GAME_STREAMS_PER_GAME = 200;
// A frame that cannot be handed to the client within this long means the
// client stopped reading; the stream is closed and the client resumes
// from its position.
export const STREAM_WRITE_TIMEOUT_MS = 30_000;

const MAX_POSITION = 9_223_372_036_854_775_807n;
const POSITION_PATTERN = /^\d{1,19}$/;
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(WEBHOOK_EVENT_TYPES);

export interface GameStreamOptions extends GameFeedOptions {
  hub?: EventHub;
  heartbeatIntervalMs?: number;
  maxStreamsPerKey?: number;
  writeTimeoutMs?: number;
}

// Open game streams in this process, per API key and per game.
class StreamSlots {
  private readonly perKey = new Map<string, number>();
  private readonly perGame = new Map<string, number>();

  constructor(
    private readonly maxPerKey: number,
    private readonly maxPerGame: number,
  ) {}

  tryAcquire(key: string, gameId: string): boolean {
    if ((this.perKey.get(key) ?? 0) >= this.maxPerKey) return false;
    if ((this.perGame.get(gameId) ?? 0) >= this.maxPerGame) return false;
    this.perKey.set(key, (this.perKey.get(key) ?? 0) + 1);
    this.perGame.set(gameId, (this.perGame.get(gameId) ?? 0) + 1);
    return true;
  }

  release(key: string, gameId: string): void {
    decrement(this.perKey, key);
    decrement(this.perGame, gameId);
  }
}

function decrement(map: Map<string, number>, key: string): void {
  const next = (map.get(key) ?? 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

// `?types=` as a set of event types, or null for every type. Names are
// comma-separated and must be known event types; an empty value means
// every type.
export function parseTypesFilter(raw: string | undefined): ReadonlySet<string> | null {
  if (raw === undefined) return null;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (names.length === 0) return null;
  const unknown = names.filter((n) => !KNOWN_EVENT_TYPES.has(n));
  if (unknown.length > 0) {
    const noun = unknown.length === 1 ? "type" : "types";
    throw Errors.badRequest(`unknown event ${noun}: ${unknown.join(", ")}`);
  }
  return new Set(names);
}

export function parsePosition(raw: string): bigint {
  if (!POSITION_PATTERN.test(raw) || BigInt(raw) > MAX_POSITION) {
    throw Errors.badRequest("Last-Event-ID must be a stream position");
  }
  return BigInt(raw);
}

// The position a new stream starts after. Without `lastEventId` the
// stream starts at the game's current position. A position the log can
// no longer serve in full (ahead of the game, or older than the oldest
// retained event) is refused rather than resumed with a gap.
export async function resolveStartPosition(
  prisma: PrismaClient,
  gameId: string,
  lastEventId: string | undefined,
): Promise<bigint> {
  const current = await readStreamPosition(prisma, gameId);
  if (lastEventId === undefined || lastEventId === "") return current;
  const position = parsePosition(lastEventId);
  if (position > current) throw Errors.streamPositionExpired();
  if (position === current) return position;
  if (!(await hasEventAfter(prisma, gameId, position))) throw Errors.streamPositionExpired();
  return position;
}

// Sets the stream position header from a read taken BEFORE the caller
// loads its data, so the data reflects at least every event up to it.
export async function stampStreamPosition(
  c: Context,
  prisma: PrismaClient,
  gameId: string,
): Promise<void> {
  const position = await readStreamPosition(prisma, gameId);
  c.header(STREAM_POSITION_HEADER, position.toString());
}

// Destroys the underlying socket when the Node adapter exposes it; a
// stalled client would otherwise hold the half-written response open.
function abandonResponse(c: Context): void {
  const outgoing = (c.env as { outgoing?: { destroy?: () => void } } | undefined)?.outgoing;
  outgoing?.destroy?.();
}

export function gameEventsHandlers(
  prisma: PrismaClient,
  opts: GameStreamOptions = {},
): { subscribe: Handler; position: Handler; feeds: GameFeeds } {
  const hub = opts.hub ?? defaultHub;
  const heartbeatMs = opts.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const writeTimeoutMs = opts.writeTimeoutMs ?? STREAM_WRITE_TIMEOUT_MS;
  const feeds = new GameFeeds(prisma, hub, opts);
  const slots = new StreamSlots(
    opts.maxStreamsPerKey ?? MAX_GAME_STREAMS_PER_KEY,
    MAX_GAME_STREAMS_PER_GAME,
  );

  const position: Handler = async (c) => {
    const current = await readStreamPosition(prisma, c.var.gameId);
    c.header(STREAM_POSITION_HEADER, current.toString());
    return c.json({ position: current.toString() });
  };

  // Every refusal (bad filter, expired position, too many streams)
  // fails synchronously with the JSON error envelope before the upgrade.
  const subscribe: Handler = async (c) => {
    const gameId = c.var.gameId;
    const apiKeyPrefix = c.var.apiKeyPrefix;
    const types = parseTypesFilter(c.req.query("types"));
    let cursor = await resolveStartPosition(prisma, gameId, c.req.header("last-event-id"));
    if (!slots.tryAcquire(apiKeyPrefix, gameId)) throw Errors.tooManyStreams();
    let feed: GameFeed;
    try {
      feed = await feeds.acquire(gameId);
    } catch (err) {
      slots.release(apiKeyPrefix, gameId);
      throw err;
    }
    // Refreshed from the key row on every heartbeat, so a changed
    // preference reaches an open stream within one interval.
    let preferred: readonly string[] = currentPreferredNamespaces();
    c.header(STREAM_POSITION_HEADER, cursor.toString());

    return streamSSE(c, async (stream) => {
      let closed = false;
      let signalled = false;
      let heartbeatDue = false;
      let wake: (() => void) | null = null;

      const wakeup = () => {
        signalled = true;
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      };
      const close = () => {
        closed = true;
        wakeup();
      };
      const stopAdvance = feed.onAdvance(wakeup);
      stream.onAbort(close);

      // Every frame goes through here, so frames never interleave and the
      // heartbeat's position is never ahead of a frame still being sent.
      const write = async (pending: Promise<unknown>): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), writeTimeoutMs);
        });
        try {
          const outcome = await Promise.race([
            pending.then(
              () => "ok" as const,
              () => "error" as const,
            ),
            deadline,
          ]);
          if (outcome === "ok") return true;
          if (outcome === "timeout") abandonResponse(c);
          close();
          return false;
        } finally {
          clearTimeout(timer);
        }
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        void (async () => {
          const key = await recheckStreamKey(prisma, apiKeyPrefix);
          if (closed) return;
          if (key.status === "revoked") {
            close();
            return;
          }
          if (key.status === "live") preferred = key.preferredNamespaces;
          heartbeatDue = true;
          wakeup();
        })();
      }, heartbeatMs);
      heartbeat.unref?.();

      const sendHeartbeat = async (): Promise<boolean> => {
        heartbeatDue = false;
        // The id line carries the stream's position, which advances past
        // events the type filter skipped.
        return write(stream.write(`:heartbeat\nid: ${cursor}\n\n`));
      };

      const send = async (item: LoggedEvent): Promise<boolean> => {
        const table = await renderTableFor(prisma, item.event);
        if (closed) return false;
        return write(
          stream.writeSSE({
            id: item.seq.toString(),
            event: item.type,
            data: JSON.stringify(renderEvent(item.event, table, preferred)),
          }),
        );
      };

      try {
        while (!closed) {
          signalled = false;
          let batch = feed.eventsAfter(cursor);
          if (batch === null) {
            batch = await readEventLog(prisma, gameId, cursor, EVENT_LOG_PAGE);
            if (closed) break;
            // Positions are gapless: anything but the next one means the
            // sweeper removed events this stream still owed. Only the
            // contiguous prefix is sent; the next read then finds the
            // gap, the stream closes, and the client's resume answers 410,
            // which tells it to resync.
            let contiguous = 0;
            while (
              contiguous < batch.length &&
              batch[contiguous]?.seq === cursor + BigInt(contiguous) + 1n
            ) {
              contiguous++;
            }
            if (contiguous === 0) break;
            batch = batch.slice(0, contiguous);
          }
          for (const item of batch) {
            if (closed) break;
            if (types === null || types.has(item.type)) {
              if (!(await send(item))) break;
            }
            cursor = item.seq;
            if (heartbeatDue && !(await sendHeartbeat())) break;
          }
          if (closed) break;
          if (heartbeatDue && !(await sendHeartbeat())) break;
          if (batch.length > 0 || signalled) continue;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        closed = true;
        clearInterval(heartbeat);
        stopAdvance();
        feeds.release(feed);
        slots.release(apiKeyPrefix, gameId);
      }
    });
  };

  return { subscribe, position, feeds };
}
