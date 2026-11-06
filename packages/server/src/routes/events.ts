import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { Errors } from "../errors.js";
import { type EventHub, eventHub as defaultHub } from "../eventHub.js";
import { type RenderTable, loadRenderTable, renderEvent } from "../eventRender.js";
import { currentPreferredNamespaces } from "../requestContext.js";

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

interface SubscribeEventsOptions {
  hub?: EventHub;
  heartbeatIntervalMs?: number;
}

// 404-collapses missing / cross-game / soft-deleted groups BEFORE
// upgrading to a stream, so a bad request fails synchronously with the
// usual JSON envelope rather than opening a stream that never delivers.
export function subscribeEventsHandler(
  prisma: PrismaClient,
  opts: SubscribeEventsOptions = {},
): Handler {
  const hub = opts.hub ?? defaultHub;
  const heartbeatMs = opts.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;

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
    // Refreshed from the key row on every heartbeat, so a changed
    // preference reaches an open stream within one interval.
    let preferred: readonly string[] = currentPreferredNamespaces();

    return streamSSE(c, async (stream) => {
      const queue: JunjoEvent[] = [];
      let wake: (() => void) | null = null;
      let closed = false;

      const wakeup = () => {
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      };

      const unsubscribe = hub.subscribe(subscribedGroupId, (event) => {
        queue.push(event);
        wakeup();
      });

      stream.onAbort(() => {
        closed = true;
        unsubscribe();
        wakeup();
      });

      const closeStream = () => {
        closed = true;
        unsubscribe();
        wakeup();
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        void (async () => {
          if (closed) return;
          const key = await recheckStreamKey(prisma, apiKeyPrefix);
          if (closed) return;
          if (key.status === "revoked") {
            closeStream();
            return;
          }
          if (key.status === "live") preferred = key.preferredNamespaces;
          stream.write(":heartbeat\n\n").catch(closeStream);
        })();
      }, heartbeatMs);
      // Never let the heartbeat keep the Node process alive on its own.
      heartbeat.unref?.();

      try {
        while (!closed) {
          while (queue.length > 0 && !closed) {
            const event = queue.shift();
            if (!event) break;
            const table = await renderTableFor(prisma, event);
            if (closed) break;
            await stream.writeSSE({
              id: event.id,
              event: event.type,
              data: JSON.stringify(renderEvent(event, table, preferred)),
            });
          }
          if (closed) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
      }
    });
  };
}
