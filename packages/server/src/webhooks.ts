import type { JunjoEvent } from "@junjo/shared";
import type { Prisma, PrismaClient } from "@prisma/client";

// The JSON round-trip turns every `Date` into its ISO 8601 string and
// strips non-serializable fields, matching the wire format consumers
// receive over SSE + HTTP (the delivery worker POSTs this exact payload).
export function serializeEventForStorage(event: JunjoEvent): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
}

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
