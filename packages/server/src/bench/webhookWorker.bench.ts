import { afterAll, beforeAll, bench, describe } from "vitest";
import {
  type WebhookFetch,
  type WebhookFetchInit,
  type WebhookFetchResult,
  deliverOne,
} from "../webhookWorker.js";
import {
  type BenchContext,
  disconnectBenchPrisma,
  ensureBenchSeed,
  isBenchDatabaseConfigured,
} from "./setup.js";

const ENABLED = isBenchDatabaseConfigured();

let ctx: BenchContext | null = null;
let endpointId: string | null = null;

const okFetcher: WebhookFetch = (
  _url: string,
  _init: WebhookFetchInit,
): Promise<WebhookFetchResult> => Promise.resolve({ ok: true, status: 200 });

beforeAll(async () => {
  if (!ENABLED) return;
  ctx = await ensureBenchSeed();
  // One endpoint per bench file is reused; each iteration enqueues a
  // fresh delivery row to bench against.
  const endpoint = await ctx.prisma.webhookEndpoint.upsert({
    where: { id: "bench_endpoint_v1" },
    create: {
      id: "bench_endpoint_v1",
      gameId: ctx.gameId,
      url: "http://localhost:1/bench",
      secret: "bench_secret",
      events: [],
      format: "junjo",
    },
    update: {},
  });
  endpointId = endpoint.id;
}, 600_000);

afterAll(async () => {
  if (!ENABLED) return;
  await disconnectBenchPrisma();
});

describe.skipIf(!ENABLED)("webhook worker deliverOne (mock fetcher, ok 200)", () => {
  bench("deliverOne (junjo format, HMAC sign + DB update)", async () => {
    if (!ctx || !endpointId) return;
    const delivery = await ctx.prisma.webhookDelivery.create({
      data: {
        webhookEndpointId: endpointId,
        eventId: "evt_bench",
        payload: {
          id: "evt_bench",
          type: "group.updated",
          gameId: ctx.gameId,
          groupId: ctx.sampleGroupId,
          occurredAt: new Date().toISOString(),
        },
        status: "pending",
        nextAttemptAt: new Date(),
      },
    });
    const outcome = await deliverOne(ctx.prisma, delivery.id, okFetcher);
    if (outcome.status !== "delivered") {
      throw new Error(`bench: expected delivered, got ${outcome.status}`);
    }
  });
});
