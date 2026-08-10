import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { streamSSE } from "hono/streaming";
import { Errors } from "../errors.js";
import { type EventHub, eventHub as defaultHub } from "../eventHub.js";

// Browsers and intermediaries idle-time-out SSE after a couple of
// minutes; the heartbeat comment keeps the connection alive without
// showing up as a real event to the consumer.
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

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
        // The API key is validated once at connect; without this re-check
        // a revoked (or deleted) key would keep its group-scoped stream
        // alive until the TCP connection happens to drop. One indexed
        // lookup by the unique prefix per heartbeat tick bounds the
        // post-revocation window to at most one heartbeat interval.
        void (async () => {
          if (closed) return;
          let key: { revokedAt: Date | null } | null | undefined;
          try {
            key = await prisma.apiKey.findUnique({
              where: { prefix: apiKeyPrefix },
              select: { revokedAt: true },
            });
          } catch {
            // Transient lookup failure: leave the stream up and re-check
            // on the next tick rather than dropping a healthy connection.
            key = undefined;
          }
          if (closed) return;
          // null = key row gone; revokedAt set = revoked. Either closes.
          if (key === null || (key && key.revokedAt !== null)) {
            closeStream();
            return;
          }
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
