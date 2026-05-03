import { createHmac, timingSafeEqual } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";
import { type WebhookFetch, type WebhookFetchInit, runWorkerOnce } from "../webhookWorker";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE =
  'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

interface Captured {
  url: string;
  init: WebhookFetchInit;
}

function captureFetcher(): { fetcher: WebhookFetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetcher: WebhookFetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200 };
  };
  return { fetcher, calls };
}

describe.skipIf(!TEST_DATABASE_URL)(
  "integration: webhook endpoint registered, mutation enqueues, worker delivers with HMAC + canonical headers",
  () => {
    let app: Hono;
    let hub: EventHub;
    let authHeader: string;

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(TRUNCATE);
      const game = await createGame("Test Game", prisma);
      const seeded = await createApiKey(game.id, prisma);
      authHeader = `Bearer ${seeded.raw.full}`;
      hub = new EventHub();
      app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
    });

    function jsonHeaders() {
      return { authorization: authHeader, "content-type": "application/json" };
    }

    it("end-to-end: register webhook -> mutate state -> worker tick -> verify signature, body, and audit", async () => {
      const registerRes = await app.request("/v1/webhooks", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          url: "https://example.com/junjo-hook",
          events: ["group.updated"],
        }),
      });
      expect(registerRes.status).toBe(201);
      const endpoint = (await registerRes.json()) as { id: string; secret: string };
      expect(endpoint.secret).toMatch(/^[A-Za-z0-9_-]+$/);

      const groupRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "guild", name: "Crimson Wolves" }),
      });
      const group = (await groupRes.json()) as { id: string };

      expect(await prisma.webhookDelivery.count()).toBe(0);

      const patchRes = await app.request(`/v1/groups/${group.id}`, {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "Iron Hand" }),
      });
      expect(patchRes.status).toBe(200);

      const enqueued = await prisma.webhookDelivery.findMany();
      expect(enqueued).toHaveLength(1);
      const pendingDelivery = enqueued[0];
      expect(pendingDelivery?.status).toBe("pending");
      expect(pendingDelivery?.attemptCount).toBe(0);

      const { fetcher, calls } = captureFetcher();
      const tickAt = new Date("2026-05-04T08:00:00.000Z");
      const result = await runWorkerOnce(prisma, { fetch: fetcher, now: () => tickAt });
      expect(result).toEqual({ delivered: 1, pending: 0, failed: 0 });
      expect(calls).toHaveLength(1);

      const call = calls[0];
      expect(call?.url).toBe("https://example.com/junjo-hook");
      expect(call?.init.method).toBe("POST");
      const headers = call?.init.headers ?? {};
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-junjo-event"]).toBe("group.updated");
      expect(headers["x-junjo-event-id"]).toMatch(/^[0-9a-f]{24}$/);
      expect(headers["x-junjo-timestamp"]).toBe(tickAt.toISOString());

      const sig = headers["x-junjo-signature"] ?? "";
      expect(sig.startsWith("v1=")).toBe(true);
      const provided = Buffer.from(sig.slice("v1=".length), "hex");
      const expected = createHmac("sha256", endpoint.secret)
        .update(`${tickAt.toISOString()}.${call?.init.body ?? ""}`)
        .digest();
      expect(provided.length).toBe(expected.length);
      expect(timingSafeEqual(provided, expected)).toBe(true);

      const body = JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>;
      expect(body.type).toBe("group.updated");
      expect((body.group as Record<string, unknown>).name).toBe("Iron Hand");

      const stored = await prisma.webhookDelivery.findUniqueOrThrow({
        where: { id: pendingDelivery?.id ?? "" },
      });
      expect(stored.status).toBe("delivered");
      expect(stored.responseStatus).toBe(200);
      expect(stored.attemptCount).toBe(1);
      expect(stored.lastAttemptAt?.toISOString()).toBe(tickAt.toISOString());

      const auditActions = (
        await prisma.auditEntry.findMany({
          where: { groupId: group.id },
          orderBy: { createdAt: "asc" },
          select: { action: true },
        })
      ).map((e) => e.action);
      expect(auditActions).toEqual(["group.created", "group.updated"]);
    });
  },
);
