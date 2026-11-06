import type { JunjoEvent } from "@junjo.io/shared";
import type { Prisma } from "@prisma/client";
import type { Db } from "./db.js";
import {
  type RenderTable,
  loadRenderTable,
  preferenceKey,
  renderEvent,
  renderIsIdentity,
} from "./eventRender.js";

// The JSON round-trip turns every `Date` into its ISO 8601 string and
// strips non-serializable fields, matching the wire format consumers
// receive over SSE + HTTP (the delivery worker POSTs this exact payload).
export function serializeEventForStorage(event: JunjoEvent): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(event)) as Prisma.InputJsonValue;
}

interface MatchedEndpoint {
  id: string;
  preferredNamespaces: string[];
}

// Each endpoint's payload names users per that endpoint's namespace
// preference. Endpoints sharing a preference share one serialized
// payload; when no emitted id has a linked alternative, every endpoint
// shares the emitted payload.
function payloadsFor(
  event: JunjoEvent,
  table: RenderTable,
  endpoints: readonly MatchedEndpoint[],
): Map<string, Prisma.InputJsonValue> {
  const out = new Map<string, Prisma.InputJsonValue>();
  if (renderIsIdentity(table)) {
    const payload = serializeEventForStorage(event);
    for (const endpoint of endpoints) out.set(endpoint.id, payload);
    return out;
  }
  const byPreference = new Map<string, Prisma.InputJsonValue>();
  for (const endpoint of endpoints) {
    const key = preferenceKey(endpoint.preferredNamespaces);
    let payload = byPreference.get(key);
    if (payload === undefined) {
      payload = serializeEventForStorage(renderEvent(event, table, endpoint.preferredNamespaces));
      byPreference.set(key, payload);
    }
    out.set(endpoint.id, payload);
  }
  return out;
}

// Accepts a TransactionClient so mutation routes can stage deliveries
// atomically with their domain writes (the transactional-outbox shape:
// if the mutation rolls back, the staged deliveries vanish with it; if
// it commits, the worker is guaranteed to see them). A top-level
// PrismaClient still works for callers with no surrounding transaction.
export async function enqueueWebhookDeliveries(db: Db, event: JunjoEvent): Promise<string[]> {
  const endpoints = await db.webhookEndpoint.findMany({
    where: {
      gameId: event.gameId,
      disabledAt: null,
      OR: [{ events: { isEmpty: true } }, { events: { has: event.type } }],
    },
    select: { id: true, preferredNamespaces: true },
  });
  if (endpoints.length === 0) return [];

  const table = await loadRenderTable(db, event.gameId, [event]);
  const payloads = payloadsFor(event, table, endpoints);
  const now = new Date();

  const created = await db.webhookDelivery.createManyAndReturn({
    data: endpoints.map((endpoint) => ({
      webhookEndpointId: endpoint.id,
      eventId: event.id,
      payload: payloads.get(endpoint.id) as Prisma.InputJsonValue,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
    })),
    select: { id: true },
  });
  return created.map((d) => d.id);
}

// Batch variant for N homogeneous events (same gameId and type, e.g.
// bulk-invite's member.invited fan-out): one endpoint match and one
// delivery insert regardless of N, instead of 2N statements inside the
// caller's transaction. Throws on mixed batches; that would need the
// per-event path.
export async function enqueueWebhookDeliveriesBatch(db: Db, events: JunjoEvent[]): Promise<void> {
  const first = events[0];
  if (!first) return;
  for (const event of events) {
    if (event.gameId !== first.gameId || event.type !== first.type) {
      throw new Error("enqueueWebhookDeliveriesBatch requires events sharing one gameId and type");
    }
  }
  const endpoints = await db.webhookEndpoint.findMany({
    where: {
      gameId: first.gameId,
      disabledAt: null,
      OR: [{ events: { isEmpty: true } }, { events: { has: first.type } }],
    },
    select: { id: true, preferredNamespaces: true },
  });
  if (endpoints.length === 0) return;

  const table = await loadRenderTable(db, first.gameId, events);
  const now = new Date();
  await db.webhookDelivery.createMany({
    data: events.flatMap((event) => {
      const payloads = payloadsFor(event, table, endpoints);
      return endpoints.map((endpoint) => ({
        webhookEndpointId: endpoint.id,
        eventId: event.id,
        payload: payloads.get(endpoint.id) as Prisma.InputJsonValue,
        status: "pending",
        attemptCount: 0,
        nextAttemptAt: now,
      }));
    }),
  });
}
