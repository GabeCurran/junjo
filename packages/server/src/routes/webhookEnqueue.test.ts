import { type Prisma, PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { EventHub } from "../eventHub.js";
import { createApiKey, createGame } from "../seed.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("webhook delivery enqueue from mutation routes", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let hub: EventHub;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
    hub = new EventHub();
    app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeGroup(name = "Crimson Wolves") {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        metadata: {} as Prisma.InputJsonValue,
      },
    });
  }

  async function makeEndpoint(
    overrides: Partial<{ url: string; events: string[]; disabledAt: Date | null }> = {},
  ) {
    return prisma.webhookEndpoint.create({
      data: {
        gameId,
        url: overrides.url ?? "https://example.com/hook",
        hashedSecret: "deadbeef",
        events: overrides.events ?? [],
        disabledAt: overrides.disabledAt ?? null,
      },
    });
  }

  it("PATCH /v1/groups/:id enqueues a delivery to a matching endpoint", async () => {
    await makeEndpoint({});
    const group = await makeGroup();

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Wolves" }),
    });
    expect(res.status).toBe(200);

    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0];
    expect(delivery?.status).toBe("pending");
    expect(delivery?.attemptCount).toBe(0);
    expect(delivery?.responseStatus).toBeNull();
    expect(delivery?.lastAttemptAt).toBeNull();
    const payload = delivery?.payload as Record<string, unknown>;
    expect(payload.type).toBe("group.updated");
    expect(payload.gameId).toBe(gameId);
    expect(payload.groupId).toBe(group.id);
    const inner = payload.group as Record<string, unknown>;
    expect(inner.name).toBe("Renamed Wolves");
  });

  it("enqueues nothing when no endpoint exists", async () => {
    const group = await makeGroup();

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Wolves" }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("respects the per-endpoint events filter (only matching deliveries enqueued)", async () => {
    await makeEndpoint({
      url: "https://updates.example/hook",
      events: ["group.updated"],
    });
    await makeEndpoint({
      url: "https://members.example/hook",
      events: ["member.joined"],
    });
    const group = await makeGroup();

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Wolves" }),
    });
    expect(res.status).toBe(200);

    const deliveries = await prisma.webhookDelivery.findMany({ include: { endpoint: true } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.endpoint.url).toBe("https://updates.example/hook");
  });

  it("emits no delivery on a no-op PATCH (matches the audit-log + event no-op precedent)", async () => {
    await makeEndpoint({});
    const group = await makeGroup();

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: group.name }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("DELETE /v1/groups/:id (soft) enqueues group.deleted", async () => {
    await makeEndpoint({});
    const group = await makeGroup();

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);

    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    const payload = deliveries[0]?.payload as Record<string, unknown>;
    expect(payload.type).toBe("group.deleted");
    expect(payload.groupId).toBe(group.id);
  });

  it("creates one delivery per matching endpoint when multiple match", async () => {
    await makeEndpoint({ url: "https://a.example/hook" });
    await makeEndpoint({ url: "https://b.example/hook" });
    await makeEndpoint({ url: "https://c.example/hook" });
    const group = await makeGroup();

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed Wolves" }),
    });
    expect(res.status).toBe(200);

    expect(await prisma.webhookDelivery.count()).toBe(3);
    const urls = (
      await prisma.webhookDelivery.findMany({
        select: { endpoint: { select: { url: true } } },
      })
    )
      .map((d) => d.endpoint.url)
      .sort();
    expect(urls).toEqual([
      "https://a.example/hook",
      "https://b.example/hook",
      "https://c.example/hook",
    ]);
  });
});
