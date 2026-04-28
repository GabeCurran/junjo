import { createHmac } from "node:crypto";
import type { GameId, GroupId, GroupUpdatedEvent } from "@junjo/shared";
import { type Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "./events.js";
import { createApiKey, createGame } from "./seed.js";
import {
  WEBHOOK_BACKOFF_MS,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookFetch,
  type WebhookFetchInit,
  deliverOne,
  pollDueDeliveries,
  runWorkerOnce,
  signWebhookBody,
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
});
