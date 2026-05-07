import { createHmac } from "node:crypto";
import type { GameId, GroupId, GroupUpdatedEvent } from "@junjo/shared";
import { type Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "./events.js";
import { createApiKey, createGame } from "./seed.js";
import {
  WEBHOOK_AUTO_DISABLE_THRESHOLD,
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_WORKER_DRAIN_MS,
  type WebhookFetch,
  type WebhookFetchInit,
  deliverOne,
  pollDueDeliveries,
  runWorkerOnce,
  signWebhookBody,
  startWebhookWorker,
} from "./webhookWorker.js";
import { enqueueWebhookDeliveries } from "./webhooks.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function makeGroupUpdatedEvent(
  gameId: string,
  groupId: string,
  occurredAt = new Date("2026-04-28T12:00:00.000Z"),
): GroupUpdatedEvent {
  return {
    id: newEventId(),
    type: "group.updated",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    occurredAt,
    group: {
      id: groupId as GroupId,
      gameId: gameId as GameId,
      kind: "guild",
      name: "Crimson Wolves",
      visibility: "invite-only",
      metadata: {},
      defaultRoleId: null,
      parentGroupId: null,
      memberCount: 3,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: occurredAt,
      softDeletedAt: null,
    },
  };
}

interface CapturedRequest {
  url: string;
  init: WebhookFetchInit;
}

function makeFetcher(responses: Array<{ ok: boolean; status: number } | Error>): {
  fetcher: WebhookFetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  let index = 0;
  const fetcher: WebhookFetch = async (url, init) => {
    calls.push({ url, init });
    const next = responses[index];
    index += 1;
    if (next instanceof Error) throw next;
    if (!next) throw new Error(`fetcher exhausted at call ${index}`);
    return next;
  };
  return { fetcher, calls };
}

describe("signWebhookBody", () => {
  it("produces an HMAC-SHA256 hex digest with the v1 scheme prefix", () => {
    const sig = signWebhookBody("topsecret", '{"hello":"world"}', "2026-04-28T12:00:00.000Z");
    const expected = createHmac("sha256", "topsecret")
      .update('2026-04-28T12:00:00.000Z.{"hello":"world"}')
      .digest("hex");
    expect(sig).toBe(`v1=${expected}`);
  });

  it("returns different signatures for different secrets", () => {
    const a = signWebhookBody("a", "body", "ts");
    const b = signWebhookBody("b", "body", "ts");
    expect(a).not.toBe(b);
  });

  it("returns different signatures for different timestamps (replay defence)", () => {
    const a = signWebhookBody("s", "body", "ts1");
    const b = signWebhookBody("s", "body", "ts2");
    expect(a).not.toBe(b);
  });

  it("returns different signatures for different bodies (tamper defence)", () => {
    const a = signWebhookBody("s", "body-a", "ts");
    const b = signWebhookBody("s", "body-b", "ts");
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same inputs", () => {
    const a = signWebhookBody("s", "body", "ts");
    const b = signWebhookBody("s", "body", "ts");
    expect(a).toBe(b);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("webhookWorker (DB-backed)", () => {
  let prisma: PrismaClient;
  let gameId: string;
  let groupId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    await createApiKey(game.id, prisma);
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {} as Prisma.InputJsonValue,
      },
    });
    groupId = group.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeEndpoint(
    overrides: Partial<{
      url: string;
      events: string[];
      secret: string;
      disabledAt: Date | null;
      format: string;
    }> = {},
  ) {
    return prisma.webhookEndpoint.create({
      data: {
        gameId,
        url: overrides.url ?? "https://example.com/hook",
        secret: overrides.secret ?? "topsecret",
        events: overrides.events ?? [],
        disabledAt: overrides.disabledAt ?? null,
        ...(overrides.format !== undefined ? { format: overrides.format } : {}),
      },
    });
  }

  async function enqueueDelivery(): Promise<string> {
    await makeEndpoint({});
    const event = makeGroupUpdatedEvent(gameId, groupId);
    const ids = await enqueueWebhookDeliveries(prisma, event);
    expect(ids).toHaveLength(1);
    return ids[0] as string;
  }

  describe("deliverOne", () => {
    it("marks a delivery delivered on a 2xx response and stops retrying", async () => {
      const id = await enqueueDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 200 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome).toEqual({ status: "delivered", httpStatus: 200 });
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("delivered");
      expect(row.attemptCount).toBe(1);
      expect(row.responseStatus).toBe(200);
      expect(row.nextAttemptAt).toBeNull();
      expect(row.lastAttemptAt?.toISOString()).toBe(now.toISOString());
      expect(calls).toHaveLength(1);
    });

    it("sends the canonical headers including the v1 HMAC signature", async () => {
      const id = await enqueueDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 200 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      await deliverOne(prisma, id, fetcher, () => now);

      const call = calls[0];
      expect(call?.url).toBe("https://example.com/hook");
      expect(call?.init.method).toBe("POST");
      expect(call?.init.headers["content-type"]).toBe("application/json");
      expect(call?.init.headers["x-junjo-event"]).toBe("group.updated");
      expect(call?.init.headers["x-junjo-event-id"]).toMatch(/^[0-9a-f]{24}$/);
      expect(call?.init.headers["x-junjo-delivery-id"]).toBe(id);
      expect(call?.init.headers["x-junjo-timestamp"]).toBe(now.toISOString());
      const expected = signWebhookBody("topsecret", call?.init.body ?? "", now.toISOString());
      expect(call?.init.headers["x-junjo-signature"]).toBe(expected);
    });

    it("posts the stored payload body verbatim", async () => {
      const id = await enqueueDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 200 }]);

      await deliverOne(prisma, id, fetcher);

      const body = calls[0]?.init.body ?? "";
      const parsed = JSON.parse(body) as Record<string, unknown>;
      expect(parsed.type).toBe("group.updated");
      expect(parsed.gameId).toBe(gameId);
      expect(parsed.groupId).toBe(groupId);
    });

    it("schedules a retry on a 5xx response with the first backoff interval", async () => {
      const id = await enqueueDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 502 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("pending");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("pending");
      expect(row.attemptCount).toBe(1);
      expect(row.responseStatus).toBe(502);
      const expectedNext = new Date(now.getTime() + WEBHOOK_BACKOFF_MS[0]);
      expect(row.nextAttemptAt?.toISOString()).toBe(expectedNext.toISOString());
    });

    it("uses successive backoff intervals for successive failures", async () => {
      const id = await enqueueDelivery();
      const now = new Date("2026-04-28T12:00:00.000Z");

      const expectedIntervals = [
        WEBHOOK_BACKOFF_MS[0],
        WEBHOOK_BACKOFF_MS[1],
        WEBHOOK_BACKOFF_MS[2],
        WEBHOOK_BACKOFF_MS[3],
        WEBHOOK_BACKOFF_MS[4],
      ];
      for (let attempt = 1; attempt <= 5; attempt++) {
        const { fetcher } = makeFetcher([{ ok: false, status: 503 }]);
        const tickAt = new Date(now.getTime() + attempt * 60_000);
        await deliverOne(prisma, id, fetcher, () => tickAt);
        const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
        expect(row.attemptCount).toBe(attempt);
        expect(row.status).toBe("pending");
        const expectedNext = new Date(tickAt.getTime() + (expectedIntervals[attempt - 1] ?? 0));
        expect(row.nextAttemptAt?.toISOString()).toBe(expectedNext.toISOString());
      }
    });

    it("marks a delivery failed after MAX attempts of retriable failure", async () => {
      const id = await enqueueDelivery();
      const now = new Date("2026-04-28T12:00:00.000Z");

      for (let attempt = 1; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
        const { fetcher } = makeFetcher([{ ok: false, status: 500 }]);
        await deliverOne(prisma, id, fetcher, () => now);
      }
      const { fetcher } = makeFetcher([{ ok: false, status: 500 }]);
      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("failed");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("failed");
      expect(row.attemptCount).toBe(WEBHOOK_MAX_ATTEMPTS);
      expect(row.nextAttemptAt).toBeNull();
      expect(row.responseStatus).toBe(500);
    });

    it("marks a delivery failed immediately on a 4xx (non-retriable)", async () => {
      const id = await enqueueDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 410 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("failed");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("failed");
      expect(row.attemptCount).toBe(1);
      expect(row.responseStatus).toBe(410);
      expect(row.nextAttemptAt).toBeNull();
    });

    it("retries on 408 Request Timeout (transient)", async () => {
      const id = await enqueueDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 408 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("pending");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("pending");
      expect(row.responseStatus).toBe(408);
      expect(row.nextAttemptAt).not.toBeNull();
    });

    it("retries on 429 Too Many Requests (transient)", async () => {
      const id = await enqueueDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 429 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("pending");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("pending");
      expect(row.responseStatus).toBe(429);
      expect(row.nextAttemptAt).not.toBeNull();
    });

    it("retries on a thrown network error (no HTTP response)", async () => {
      const id = await enqueueDelivery();
      const { fetcher } = makeFetcher([new Error("ECONNREFUSED")]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("pending");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("pending");
      expect(row.responseStatus).toBeNull();
      expect(row.attemptCount).toBe(1);
      expect(row.nextAttemptAt).not.toBeNull();
    });

    it("returns missing for a delivery id that does not exist", async () => {
      const { fetcher, calls } = makeFetcher([]);
      const outcome = await deliverOne(prisma, "del_does_not_exist", fetcher);
      expect(outcome).toEqual({ status: "missing" });
      expect(calls).toHaveLength(0);
    });

    it("is a no-op on a delivery whose status is already terminal", async () => {
      const id = await enqueueDelivery();
      await prisma.webhookDelivery.update({
        where: { id },
        data: { status: "delivered", attemptCount: 1, responseStatus: 200, nextAttemptAt: null },
      });
      const { fetcher, calls } = makeFetcher([]);

      const outcome = await deliverOne(prisma, id, fetcher);

      expect(outcome.status).toBe("delivered");
      expect(calls).toHaveLength(0);
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.attemptCount).toBe(1);
    });
  });

  describe("pollDueDeliveries", () => {
    it("returns pending rows whose nextAttemptAt is at or before now", async () => {
      const id1 = await enqueueDelivery();
      await prisma.webhookDelivery.update({
        where: { id: id1 },
        data: { nextAttemptAt: new Date("2026-04-28T11:00:00.000Z") },
      });

      const due = await pollDueDeliveries(prisma, new Date("2026-04-28T12:00:00.000Z"), 50);
      expect(due).toEqual([id1]);
    });

    it("excludes rows whose nextAttemptAt is in the future", async () => {
      const id = await enqueueDelivery();
      await prisma.webhookDelivery.update({
        where: { id },
        data: { nextAttemptAt: new Date("2026-04-28T13:00:00.000Z") },
      });

      const due = await pollDueDeliveries(prisma, new Date("2026-04-28T12:00:00.000Z"), 50);
      expect(due).toEqual([]);
    });

    it("excludes delivered and failed rows", async () => {
      const idDelivered = await enqueueDelivery();
      await prisma.webhookDelivery.update({
        where: { id: idDelivered },
        data: { status: "delivered", nextAttemptAt: null },
      });
      await makeEndpoint({ url: "https://other.example/hook" });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      const newIds = await enqueueWebhookDeliveries(prisma, event);
      const idFailed = newIds.find((x) => x !== idDelivered);
      if (idFailed) {
        await prisma.webhookDelivery.update({
          where: { id: idFailed },
          data: { status: "failed", nextAttemptAt: null },
        });
      }

      const due = await pollDueDeliveries(prisma, new Date("2026-04-28T13:00:00.000Z"), 50);
      expect(due).toEqual([]);
    });

    it("orders by nextAttemptAt ascending and respects batchSize", async () => {
      const id1 = await enqueueDelivery();
      await makeEndpoint({ url: "https://second.example/hook" });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      const ids = await enqueueWebhookDeliveries(prisma, event);
      const id2 = ids.find((x) => x !== id1) ?? "";
      await prisma.webhookDelivery.update({
        where: { id: id1 },
        data: { nextAttemptAt: new Date("2026-04-28T10:00:00.000Z") },
      });
      await prisma.webhookDelivery.update({
        where: { id: id2 },
        data: { nextAttemptAt: new Date("2026-04-28T11:00:00.000Z") },
      });

      const due = await pollDueDeliveries(prisma, new Date("2026-04-28T12:00:00.000Z"), 1);
      expect(due).toEqual([id1]);
    });
  });

  describe("runWorkerOnce", () => {
    it("delivers all due rows and returns the outcome counts", async () => {
      await makeEndpoint({ url: "https://a.example/hook" });
      await makeEndpoint({ url: "https://b.example/hook" });
      await makeEndpoint({ url: "https://c.example/hook" });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      await enqueueWebhookDeliveries(prisma, event);
      const dueAt = new Date("2026-04-28T12:00:00.000Z");
      await prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: dueAt } });

      const { fetcher, calls } = makeFetcher([
        { ok: true, status: 200 },
        { ok: false, status: 500 },
        { ok: false, status: 410 },
      ]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const result = await runWorkerOnce(prisma, { fetch: fetcher, now: () => now });

      expect(result).toEqual({ delivered: 1, pending: 1, failed: 1 });
      expect(calls).toHaveLength(3);
      const rows = await prisma.webhookDelivery.findMany({ orderBy: { id: "asc" } });
      const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      expect(statusCounts).toEqual({ delivered: 1, pending: 1, failed: 1 });
    });

    it("returns zero counts when no deliveries are due", async () => {
      const { fetcher, calls } = makeFetcher([]);
      const result = await runWorkerOnce(prisma, {
        fetch: fetcher,
        now: () => new Date("2026-04-28T12:00:00.000Z"),
      });
      expect(result).toEqual({ delivered: 0, pending: 0, failed: 0 });
      expect(calls).toHaveLength(0);
    });

    it("skips deliveries whose nextAttemptAt is in the future", async () => {
      const id = await enqueueDelivery();
      await prisma.webhookDelivery.update({
        where: { id },
        data: { nextAttemptAt: new Date("2026-04-28T14:00:00.000Z") },
      });
      const { fetcher, calls } = makeFetcher([]);
      const result = await runWorkerOnce(prisma, {
        fetch: fetcher,
        now: () => new Date("2026-04-28T12:00:00.000Z"),
      });

      expect(result).toEqual({ delivered: 0, pending: 0, failed: 0 });
      expect(calls).toHaveLength(0);
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("pending");
      expect(row.attemptCount).toBe(0);
    });
  });

  describe("deliverOne (discord format)", () => {
    async function enqueueDiscordDelivery(): Promise<string> {
      await makeEndpoint({ url: "https://discord.com/api/webhooks/1/abc", format: "discord" });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      const ids = await enqueueWebhookDeliveries(prisma, event);
      expect(ids).toHaveLength(1);
      return ids[0] as string;
    }

    it("posts a Discord embed payload instead of the raw JunjoEvent", async () => {
      const id = await enqueueDiscordDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 204 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome).toEqual({ status: "delivered", httpStatus: 204 });
      const call = calls[0];
      expect(call?.url).toBe("https://discord.com/api/webhooks/1/abc");
      const body = JSON.parse(call?.init.body ?? "") as { embeds?: unknown[] };
      expect(Array.isArray(body.embeds)).toBe(true);
      expect(body.embeds).toHaveLength(1);
      const embed = body.embeds?.[0] as Record<string, unknown>;
      expect(embed.title).toBe("Group updated");
      expect(typeof embed.color).toBe("number");
    });

    it("omits all x-junjo-* headers and the HMAC signature on a Discord delivery", async () => {
      const id = await enqueueDiscordDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 204 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      await deliverOne(prisma, id, fetcher, () => now);

      const headers = calls[0]?.init.headers ?? {};
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-junjo-event"]).toBeUndefined();
      expect(headers["x-junjo-event-id"]).toBeUndefined();
      expect(headers["x-junjo-delivery-id"]).toBeUndefined();
      expect(headers["x-junjo-timestamp"]).toBeUndefined();
      expect(headers["x-junjo-signature"]).toBeUndefined();
    });

    it("retries Discord deliveries on 5xx with the same backoff as junjo format", async () => {
      const id = await enqueueDiscordDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 502 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("pending");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.attemptCount).toBe(1);
      expect(row.responseStatus).toBe(502);
      const expectedNext = new Date(now.getTime() + WEBHOOK_BACKOFF_MS[0]);
      expect(row.nextAttemptAt?.toISOString()).toBe(expectedNext.toISOString());
    });

    it("treats Discord 4xx as terminal failure (e.g. 401 unknown webhook)", async () => {
      const id = await enqueueDiscordDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 401 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("failed");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("failed");
      expect(row.attemptCount).toBe(1);
    });
  });

  describe("deliverOne (slack format)", () => {
    async function enqueueSlackDelivery(): Promise<string> {
      await makeEndpoint({
        url: "https://hooks.slack.com/services/T0/B0/abc",
        format: "slack",
      });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      const ids = await enqueueWebhookDeliveries(prisma, event);
      expect(ids).toHaveLength(1);
      return ids[0] as string;
    }

    it("posts a Slack Block Kit payload instead of the raw JunjoEvent", async () => {
      const id = await enqueueSlackDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 200 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome).toEqual({ status: "delivered", httpStatus: 200 });
      const call = calls[0];
      expect(call?.url).toBe("https://hooks.slack.com/services/T0/B0/abc");
      const body = JSON.parse(call?.init.body ?? "") as {
        text?: unknown;
        blocks?: Array<{ type: string }>;
      };
      expect(typeof body.text).toBe("string");
      expect(Array.isArray(body.blocks)).toBe(true);
      const types = body.blocks?.map((b) => b.type) ?? [];
      expect(types).toContain("header");
      expect(types).toContain("section");
      expect(types).toContain("context");
    });

    it("omits all x-junjo-* headers and the HMAC signature on a Slack delivery", async () => {
      const id = await enqueueSlackDelivery();
      const { fetcher, calls } = makeFetcher([{ ok: true, status: 200 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      await deliverOne(prisma, id, fetcher, () => now);

      const headers = calls[0]?.init.headers ?? {};
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-junjo-event"]).toBeUndefined();
      expect(headers["x-junjo-event-id"]).toBeUndefined();
      expect(headers["x-junjo-delivery-id"]).toBeUndefined();
      expect(headers["x-junjo-timestamp"]).toBeUndefined();
      expect(headers["x-junjo-signature"]).toBeUndefined();
    });

    it("retries Slack deliveries on 5xx with the same backoff as junjo format", async () => {
      const id = await enqueueSlackDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 502 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("pending");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.attemptCount).toBe(1);
      expect(row.responseStatus).toBe(502);
      const expectedNext = new Date(now.getTime() + WEBHOOK_BACKOFF_MS[0]);
      expect(row.nextAttemptAt?.toISOString()).toBe(expectedNext.toISOString());
    });

    it("treats Slack 4xx as terminal failure (e.g. 404 invalid webhook URL)", async () => {
      const id = await enqueueSlackDelivery();
      const { fetcher } = makeFetcher([{ ok: false, status: 404 }]);
      const now = new Date("2026-04-28T12:30:00.000Z");

      const outcome = await deliverOne(prisma, id, fetcher, () => now);

      expect(outcome.status).toBe("failed");
      const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe("failed");
      expect(row.attemptCount).toBe(1);
    });
  });

  describe("auto-disable on consecutive failures", () => {
    it("does not disable an endpoint after N consecutive successes", async () => {
      const ep = await makeEndpoint({ url: "https://ok.test/" });
      const total = WEBHOOK_AUTO_DISABLE_THRESHOLD + 5;
      const { fetcher } = makeFetcher(
        Array.from({ length: total }, () => ({ ok: true, status: 200 })),
      );
      for (let i = 0; i < total; i++) {
        const event = makeGroupUpdatedEvent(gameId, groupId);
        const [id] = await enqueueWebhookDeliveries(prisma, event);
        if (!id) throw new Error("expected enqueued delivery");
        await deliverOne(prisma, id, fetcher, () => new Date());
      }
      const final = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(final.disabledAt).toBeNull();
      expect(final.consecutiveFailures).toBe(0);
    });

    it(`disables an endpoint after exactly ${WEBHOOK_AUTO_DISABLE_THRESHOLD} consecutive 5xx failures`, async () => {
      const ep = await makeEndpoint({ url: "https://dead.test/" });
      // Fire one delivery short of the threshold; endpoint should still be live.
      const responses = Array.from({ length: WEBHOOK_AUTO_DISABLE_THRESHOLD - 1 }, () => ({
        ok: false,
        status: 500,
      }));
      const { fetcher } = makeFetcher(responses);
      for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD - 1; i++) {
        const event = makeGroupUpdatedEvent(gameId, groupId);
        const [id] = await enqueueWebhookDeliveries(prisma, event);
        if (!id) throw new Error("expected enqueued delivery");
        await deliverOne(prisma, id, fetcher, () => new Date());
      }
      let row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(row.disabledAt).toBeNull();
      expect(row.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD - 1);

      // The Nth failure flips disabledAt.
      const event = makeGroupUpdatedEvent(gameId, groupId);
      const [id] = await enqueueWebhookDeliveries(prisma, event);
      if (!id) throw new Error("expected enqueued delivery");
      const { fetcher: f2 } = makeFetcher([{ ok: false, status: 500 }]);
      const before = new Date();
      await deliverOne(prisma, id, f2, () => new Date());
      row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(row.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD);
      expect(row.disabledAt).not.toBeNull();
      expect(row.disabledAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    });

    it("disables on consecutive thrown network errors (no HTTP response)", async () => {
      const ep = await makeEndpoint({ url: "https://unreachable.test/" });
      const responses: Array<{ ok: boolean; status: number } | Error> = Array.from(
        { length: WEBHOOK_AUTO_DISABLE_THRESHOLD },
        () => new Error("ENOTFOUND unreachable.test"),
      );
      const { fetcher } = makeFetcher(responses);
      for (let i = 0; i < WEBHOOK_AUTO_DISABLE_THRESHOLD; i++) {
        const event = makeGroupUpdatedEvent(gameId, groupId);
        const [id] = await enqueueWebhookDeliveries(prisma, event);
        if (!id) throw new Error("expected enqueued delivery");
        await deliverOne(prisma, id, fetcher, () => new Date());
      }
      const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(row.consecutiveFailures).toBe(WEBHOOK_AUTO_DISABLE_THRESHOLD);
      expect(row.disabledAt).not.toBeNull();
    });

    it("a single success between failures resets the counter", async () => {
      const ep = await makeEndpoint({ url: "https://flaky.test/" });
      // Five 5xx, then one 2xx, then five more 5xx. The counter must
      // reset on the 2xx so the trailing 5xx run isn't enough to trip
      // the threshold.
      const responses: Array<{ ok: boolean; status: number }> = [
        ...Array.from({ length: 5 }, () => ({ ok: false, status: 500 })),
        { ok: true, status: 200 },
        ...Array.from({ length: 5 }, () => ({ ok: false, status: 500 })),
      ];
      const { fetcher } = makeFetcher(responses);
      for (let i = 0; i < responses.length; i++) {
        const event = makeGroupUpdatedEvent(gameId, groupId);
        const [id] = await enqueueWebhookDeliveries(prisma, event);
        if (!id) throw new Error("expected enqueued delivery");
        await deliverOne(prisma, id, fetcher, () => new Date());
      }
      const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(row.disabledAt).toBeNull();
      // Counter reflects only the trailing 5xx run, not the cumulative 10.
      expect(row.consecutiveFailures).toBe(5);
    });

    it("pollDueDeliveries skips pending rows whose endpoint is disabled", async () => {
      const live = await makeEndpoint({ url: "https://live.test/" });
      const dead = await makeEndpoint({ url: "https://dead.test/", disabledAt: new Date() });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      const livePending = await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: live.id,
          eventId: event.id,
          payload: { id: event.id, type: event.type },
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(),
        },
      });
      await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: dead.id,
          eventId: event.id,
          payload: { id: event.id, type: event.type },
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(),
        },
      });

      const due = await pollDueDeliveries(prisma, new Date());
      expect(due).toEqual([livePending.id]);
    });

    it("does not flip disabledAt a second time once already disabled", async () => {
      // Pre-disabled endpoint with an old disabledAt; a new failure must
      // not overwrite the timestamp (operators rely on it as the
      // disable cause / time-of-onset signal).
      const original = new Date(0);
      const ep = await makeEndpoint({ url: "https://manual.test/", disabledAt: original });
      const event = makeGroupUpdatedEvent(gameId, groupId);
      // enqueueWebhookDeliveries filters out disabled endpoints, so
      // create the delivery directly.
      const delivery = await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: ep.id,
          eventId: event.id,
          payload: { id: event.id, type: event.type },
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(),
        },
      });
      const { fetcher } = makeFetcher([{ ok: false, status: 500 }]);
      await deliverOne(prisma, delivery.id, fetcher, () => new Date());
      const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ep.id } });
      expect(row.disabledAt?.toISOString()).toBe(original.toISOString());
      // Counter still increments (informational).
      expect(row.consecutiveFailures).toBe(1);
    });
  });
});

describe("startWebhookWorker heartbeat", () => {
  it("initializes lastHeartbeat to the worker's startup time", async () => {
    const t0 = new Date("2026-05-02T17:00:00.000Z");
    const fakePrisma = {} as unknown as PrismaClient;
    const handle = startWebhookWorker(fakePrisma, {
      intervalMs: 1_000_000,
      now: () => t0,
    });
    try {
      const initial = handle.getLastHeartbeat();
      expect(initial.toISOString()).toBe(t0.toISOString());
    } finally {
      await handle.stop();
    }
  });

  it("returns a Date that exposes a stable reading via getLastHeartbeat()", async () => {
    const fakePrisma = {} as unknown as PrismaClient;
    const handle = startWebhookWorker(fakePrisma, { intervalMs: 1_000_000 });
    try {
      const a = handle.getLastHeartbeat();
      const b = handle.getLastHeartbeat();
      expect(a).toBeInstanceOf(Date);
      expect(b).toBeInstanceOf(Date);
      expect(a.toISOString()).toBe(b.toISOString());
    } finally {
      await handle.stop();
    }
  });

  it("stop() resolves a Promise<void> and is safe to call once", async () => {
    const fakePrisma = {} as unknown as PrismaClient;
    const handle = startWebhookWorker(fakePrisma, { intervalMs: 1_000_000 });
    const result = handle.stop();
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBeUndefined();
  });
});

describe("WEBHOOK_WORKER_DRAIN_MS constant", () => {
  it("exports a 30s ceiling matching typical orchestrator terminationGracePeriod", () => {
    expect(WEBHOOK_WORKER_DRAIN_MS).toBe(30_000);
  });
});

describe("runWorkerOnce shouldStop", () => {
  it("breaks the batch loop early when shouldStop returns true", async () => {
    const calls: string[] = [];
    let stop = false;
    const fetcher: WebhookFetch = async (url) => {
      calls.push(url);
      stop = true;
      return { ok: true, status: 200 };
    };
    const fakePrisma = {
      webhookDelivery: {
        findMany: async () => [{ id: "del_1" }, { id: "del_2" }, { id: "del_3" }],
        findUnique: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          status: "pending",
          attemptCount: 0,
          payload: { id: "evt_1", type: "group.updated" },
          endpoint: {
            id: "wh_1",
            url: `https://example.test/${where.id}`,
            secret: "topsecret",
            format: "junjo",
            disabledAt: null,
            consecutiveFailures: 0,
          },
        }),
        update: async () => ({}),
      },
      webhookEndpoint: {
        update: async () => ({}),
      },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    } as unknown as PrismaClient;

    const result = await runWorkerOnce(fakePrisma, {
      fetch: fetcher,
      shouldStop: () => stop,
    });

    expect(result.delivered).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("does not break the loop when shouldStop is omitted", async () => {
    const calls: string[] = [];
    const fetcher: WebhookFetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    };
    const fakePrisma = {
      webhookDelivery: {
        findMany: async () => [{ id: "del_1" }, { id: "del_2" }],
        findUnique: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          status: "pending",
          attemptCount: 0,
          payload: { id: "evt_1", type: "group.updated" },
          endpoint: {
            id: "wh_1",
            url: `https://example.test/${where.id}`,
            secret: "topsecret",
            format: "junjo",
            disabledAt: null,
            consecutiveFailures: 0,
          },
        }),
        update: async () => ({}),
      },
      webhookEndpoint: {
        update: async () => ({}),
      },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
    } as unknown as PrismaClient;

    const result = await runWorkerOnce(fakePrisma, { fetch: fetcher });
    expect(result.delivered).toBe(2);
    expect(calls).toHaveLength(2);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("startWebhookWorker graceful drain", () => {
  let prisma: PrismaClient;
  let gameId: string;
  let groupId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    await createApiKey(game.id, prisma);
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {} as Prisma.InputJsonValue,
      },
    });
    groupId = group.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeDueEndpoint(url: string): Promise<void> {
    await prisma.webhookEndpoint.create({
      data: {
        gameId,
        url,
        secret: "topsecret",
        events: [],
        disabledAt: null,
      },
    });
  }

  async function enqueueDueDelivery(): Promise<string[]> {
    const event = makeGroupUpdatedEvent(gameId, groupId);
    const ids = await enqueueWebhookDeliveries(prisma, event);
    await prisma.webhookDelivery.updateMany({ data: { nextAttemptAt: new Date() } });
    return ids;
  }

  it("waits for the in-flight deliverOne to complete before stop() resolves", async () => {
    await makeDueEndpoint("https://example.test/slow");
    const [id] = await enqueueDueDelivery();

    let releaseFetcher: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const fetcherStarted = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const fetcher: WebhookFetch = async () => {
      resolveStarted?.();
      await new Promise<void>((r) => {
        releaseFetcher = r;
      });
      return { ok: true, status: 200 };
    };

    const handle = startWebhookWorker(prisma, { fetch: fetcher, intervalMs: 5 });
    try {
      await fetcherStarted;
      const stopPromise = handle.stop({ drainMs: 5_000 });
      // Give the event loop a turn so any racing tick callbacks would
      // surface; stop should still be pending because the fetcher hangs.
      await new Promise((r) => setTimeout(r, 30));
      releaseFetcher?.();
      await stopPromise;
    } finally {
      releaseFetcher?.();
      await handle.stop();
    }

    const row = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: id as string } });
    expect(row.status).toBe("delivered");
    expect(row.responseStatus).toBe(200);
    expect(row.attemptCount).toBe(1);
  });

  it("does not pick up new deliveries after stop() is called", async () => {
    await makeDueEndpoint("https://example.test/a");
    await makeDueEndpoint("https://example.test/b");
    await enqueueDueDelivery();

    let callCount = 0;
    let releaseFirst: (() => void) | undefined;
    let resolveStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((r) => {
      resolveStarted = r;
    });
    const fetcher: WebhookFetch = async () => {
      callCount++;
      if (callCount === 1) {
        resolveStarted?.();
        await new Promise<void>((r) => {
          releaseFirst = r;
        });
      }
      return { ok: true, status: 200 };
    };

    const handle = startWebhookWorker(prisma, { fetch: fetcher, intervalMs: 5 });
    try {
      await firstStarted;
      const stopPromise = handle.stop({ drainMs: 5_000 });
      // Late ticks (cleared interval) must not fire while we wait.
      await new Promise((r) => setTimeout(r, 30));
      releaseFirst?.();
      await stopPromise;
      // Quiet window after drain to ensure no late tick sneaks in.
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      releaseFirst?.();
      await handle.stop();
    }

    expect(callCount).toBe(1);
    const rows = await prisma.webhookDelivery.findMany({});
    const delivered = rows.filter((r) => r.status === "delivered").length;
    const pending = rows.filter((r) => r.status === "pending").length;
    expect(delivered).toBe(1);
    expect(pending).toBe(1);
  });

  it("clips the drain at the configured ceiling when the in-flight deliverOne hangs", async () => {
    await makeDueEndpoint("https://example.test/hang");
    await enqueueDueDelivery();

    let resolveStarted: (() => void) | undefined;
    const started = new Promise<void>((r) => {
      resolveStarted = r;
    });
    let releaseFetcher: (() => void) | undefined;
    const fetcher: WebhookFetch = async () => {
      resolveStarted?.();
      await new Promise<void>((r) => {
        releaseFetcher = r;
      });
      return { ok: true, status: 200 };
    };

    const handle = startWebhookWorker(prisma, { fetch: fetcher, intervalMs: 5 });
    try {
      await started;
      const t0 = Date.now();
      // Drain ceiling fires while the fetcher is still hanging; stop()
      // resolves at the ceiling rather than waiting for the in-flight
      // delivery to finish.
      await handle.stop({ drainMs: 100 });
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      // Release the fetcher and await the still-pending in-flight tick
      // so the test process tears down cleanly. In production this maps
      // to `process.exit(0)` killing the remaining work after the
      // ceiling fires.
      releaseFetcher?.();
      await handle.stop();
    }
  });

  it("stop() is a no-op when no tick is in flight", async () => {
    const handle = startWebhookWorker(prisma, { intervalMs: 1_000_000 });
    const t0 = Date.now();
    await handle.stop({ drainMs: 5_000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(50);
  });

  it("a second stop() call resolves cleanly after the first drain completed", async () => {
    const handle = startWebhookWorker(prisma, { intervalMs: 1_000_000 });
    await handle.stop();
    await expect(handle.stop()).resolves.toBeUndefined();
  });
});
