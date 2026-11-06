import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { Errors } from "../errors.js";
import { type EventHub, eventHub as defaultHub } from "../eventHub.js";
import { type RenderTable, loadRenderTable, renderEvent } from "../eventRender.js";
import { currentPreferredNamespaces } from "../requestContext.js";
import {
  STREAM_WRITE_TIMEOUT_MS,
  StreamSlots,
  abandonResponse,
  writeWithin,
} from "./streamSlots.js";

// Browsers and intermediaries idle-time-out SSE after a couple of
// minutes; the heartbeat comment keeps the connection alive without
// showing up as a real event to the consumer.
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

// The API key is validated once at connect, so every stream re-reads it
// on each heartbeat: one indexed lookup by the unique prefix bounds the
// window in which a revoked or deleted key keeps a stream open to one
// interval, and carries a changed namespace preference to the stream.
// "unknown" is a failed lookup; the stream stays up and checks again on
// the next tick rather than dropping a healthy connection.
export type StreamKeyCheck =
  | { status: "live"; preferredNamespaces: string[] }
  | { status: "revoked" }
  | { status: "unknown" };

export async function recheckStreamKey(
  prisma: PrismaClient,
  prefix: string,
): Promise<StreamKeyCheck> {
  let key: { revokedAt: Date | null; preferredNamespaces: string[] } | null;
  try {
    key = await prisma.apiKey.findUnique({
      where: { prefix },
      select: { revokedAt: true, preferredNamespaces: true },
    });
  } catch {
    return { status: "unknown" };
  }
  if (key === null || key.revokedAt !== null) return { status: "revoked" };
  return { status: "live", preferredNamespaces: key.preferredNamespaces };
}

// Every subscriber of a group (and every game stream) receives the same
// event, so the identity lookup behind rendering runs once per event
// rather than once per stream. Holds raw id lists, not rendered ids, so
// it is valid for every namespace preference. Bounded; the oldest
// entries go first.
const RENDER_TABLE_MEMO_MAX = 512;
const renderTables = new Map<string, Promise<RenderTable>>();

export function renderTableFor(prisma: PrismaClient, event: JunjoEvent): Promise<RenderTable> {
  const hit = renderTables.get(event.id);
  if (hit) return hit;
  const pending = loadRenderTable(prisma, event.gameId, [event]).catch(
    // A failed lookup delivers the event as emitted rather than dropping it.
    () => new Map() as RenderTable,
  );
  renderTables.set(event.id, pending);
  if (renderTables.size > RENDER_TABLE_MEMO_MAX) {
    const oldest = renderTables.keys().next().value;
    if (oldest !== undefined) renderTables.delete(oldest);
  }
  return pending;
}

// Open group streams per API key and per game, counted per server
// process. A connection covers one group, so the caps are far above the
// game stream's.
export const MAX_GROUP_STREAMS_PER_KEY = 500;
export const MAX_GROUP_STREAMS_PER_GAME = 2_000;
// Events waiting to be written to one group stream. A client that falls
// this far behind has stopped reading, and the stream is closed rather
// than buffering without bound.
export const MAX_QUEUED_GROUP_EVENTS = 1_000;

export interface GroupStreamOptions {
  maxGroupStreamsPerKey?: number;
  maxGroupStreamsPerGame?: number;
  maxQueuedGroupEvents?: number;
}

interface SubscribeEventsOptions extends GroupStreamOptions {
  hub?: EventHub;
  heartbeatIntervalMs?: number;
  writeTimeoutMs?: number;
}

// 404-collapses missing / cross-game / soft-deleted groups BEFORE
// upgrading to a stream, so a bad request fails synchronously with the
// usual JSON envelope rather than opening a stream that never delivers.
// Too many open streams for the key or the game fails the same way.
//
// A frame that cannot be handed to the client within the write timeout,
// or a queue that reaches its cap, means the client stopped reading; the
// stream is closed.
export function subscribeEventsHandler(
  prisma: PrismaClient,
  opts: SubscribeEventsOptions = {},
): Handler {
  const hub = opts.hub ?? defaultHub;
  const heartbeatMs = opts.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const writeTimeoutMs = opts.writeTimeoutMs ?? STREAM_WRITE_TIMEOUT_MS;
  const maxQueued = Math.max(1, opts.maxQueuedGroupEvents ?? MAX_QUEUED_GROUP_EVENTS);
  const slots = new StreamSlots(
    opts.maxGroupStreamsPerKey ?? MAX_GROUP_STREAMS_PER_KEY,
    opts.maxGroupStreamsPerGame ?? MAX_GROUP_STREAMS_PER_GAME,
  );

  return async (c) => {
    const groupId = c.req.param("groupId") ?? "";
    const gameId = c.var.gameId;
    const apiKeyPrefix = c.var.apiKeyPrefix;
    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");
    const subscribedGroupId = group.id as GroupId;
    if (!slots.tryAcquire(apiKeyPrefix, gameId)) throw Errors.tooManyStreams();
    // Refreshed from the key row on every heartbeat, so a changed
    // preference reaches an open stream within one interval.
    let preferred: readonly string[] = currentPreferredNamespaces();

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      slots.release(apiKeyPrefix, gameId);
    };

    try {
      return streamSSE(c, async (stream) => {
        const queue: JunjoEvent[] = [];
        let wake: (() => void) | null = null;
        let closed = false;
        let heartbeatDue = false;

        const wakeup = () => {
          if (wake) {
            const w = wake;
            wake = null;
            w();
          }
        };

        const unsubscribe = hub.subscribe(subscribedGroupId, (event) => {
          if (closed) return;
          if (queue.length >= maxQueued) {
            closeStream();
            abandonResponse(c);
            return;
          }
          queue.push(event);
          wakeup();
        });

        const closeStream = () => {
          closed = true;
          unsubscribe();
          wakeup();
        };
        stream.onAbort(closeStream);

        // Every frame goes through here, so frames never interleave.
        const write = async (pending: Promise<unknown>): Promise<boolean> => {
          const outcome = await writeWithin(pending, writeTimeoutMs);
          if (outcome === "ok") return true;
          if (outcome === "timeout") abandonResponse(c);
          closeStream();
          return false;
        };

        const heartbeat = setInterval(() => {
          if (closed) return;
          void (async () => {
            const key = await recheckStreamKey(prisma, apiKeyPrefix);
            if (closed) return;
            if (key.status === "revoked") {
              closeStream();
              return;
            }
            if (key.status === "live") preferred = key.preferredNamespaces;
            heartbeatDue = true;
            wakeup();
          })();
        }, heartbeatMs);
        // Never let the heartbeat keep the Node process alive on its own.
        heartbeat.unref?.();

        try {
          while (!closed) {
            if (heartbeatDue) {
              heartbeatDue = false;
              if (!(await write(stream.write(":heartbeat\n\n")))) break;
            }
            const event = queue.shift();
            if (event) {
              const table = await renderTableFor(prisma, event);
              if (closed) break;
              const sent = await write(
                stream.writeSSE({
                  id: event.id,
                  event: event.type,
                  data: JSON.stringify(renderEvent(event, table, preferred)),
                }),
              );
              if (!sent) break;
              continue;
            }
            if (closed || heartbeatDue) continue;
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        } finally {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          release();
        }
      });
    } catch (err) {
      release();
      throw err;
    }
  };
}
