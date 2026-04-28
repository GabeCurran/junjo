import type { GroupId, JunjoEvent } from "@junjo/shared";
import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { Errors } from "../errors.js";
import { type EventHub, eventHub as defaultHub } from "../eventHub.js";

// Browsers and intermediaries time out idle SSE connections after a couple
// of minutes. A heartbeat comment every 30s keeps the connection alive
// without showing up as a real event to the consumer.
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

interface SubscribeEventsOptions {
  hub?: EventHub;
  heartbeatIntervalMs?: number;
}

// `GET /v1/events/:groupId` - opens a long-lived SSE stream that delivers
// every `JunjoEvent` published for the named group. The SDK's
// `groups.subscribe()` (Phase 5.1c) wraps this; for now any HTTP client
// that speaks SSE can subscribe with the standard `Authorization` header.
//
// The route 404-collapses missing / cross-game / soft-deleted groups before
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
    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");
    const subscribedGroupId = group.id as GroupId;

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

      const heartbeat = setInterval(() => {
        if (closed) return;
        stream.write(":heartbeat\n\n").catch(() => {
          closed = true;
          unsubscribe();
          wakeup();
        });
      }, heartbeatMs);
      // Never let the heartbeat keep a Node process alive on its own.
      heartbeat.unref?.();

      try {
        while (!closed) {
          while (queue.length > 0 && !closed) {
            const event = queue.shift();
            if (!event) break;
            await stream.writeSSE({
              id: event.id,
              event: event.type,
              data: JSON.stringify(event),
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
