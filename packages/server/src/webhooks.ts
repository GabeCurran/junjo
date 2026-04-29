import type { JunjoEvent } from "@junjo/shared";
import type { Prisma, PrismaClient } from "@prisma/client";

// Serializes a `JunjoEvent` into a JSON-compatible value suitable for
// `Prisma.InputJsonValue` storage. The `JSON.stringify` round-trip turns
// every `Date` into its ISO 8601 string and strips any non-serializable
// fields, matching the wire format consumers receive over SSE and HTTP
// (the delivery worker POSTs this exact payload to the dev's endpoint).
export function serializeEventForStorage(event: JunjoEvent): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
}

// Looks up every active `WebhookEndpoint` for the event's game whose
// event filter matches (empty filter = match all; non-empty = membership
// test) and creates one `WebhookDelivery` row per match in the `pending`
// state, ready for the delivery worker (Phase 5.3b) to pick up. Returns
// the created delivery ids. The function is fire-and-forget from the
// route's perspective: a delivery is durable once enqueued, but the
// route's response does not block on delivery itself.
export async function enqueueWebhookDeliveries(
  prisma: PrismaClient,
  event: JunjoEvent,
): Promise<string[]> {
  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      gameId: event.gameId,
      disabledAt: null,
      OR: [{ events: { isEmpty: true } }, { events: { has: event.type } }],
    },
    select: { id: true },
  });
  if (endpoints.length === 0) return [];

  const payload = serializeEventForStorage(event);
  const now = new Date();

  const created = await prisma.$transaction(
    endpoints.map((endpoint) =>
      prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: endpoint.id,
          eventId: event.id,
          payload,
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: now,
        },
        select: { id: true },
      }),
    ),
  );
  return created.map((d) => d.id);
}
