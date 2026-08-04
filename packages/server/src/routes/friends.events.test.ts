import type { JunjoEvent } from "@junjo-io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { EventHub } from "../eventHub.js";
import { createApiKey, createGame } from "../seed.js";
import type { WireFriendRequest, WireFriendRequestSendResult } from "./friends.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-friend-events";

const TRUNCATE =
  'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("friend-event dispatch (webhook + SSE skip)", () => {
  let prisma: PrismaClient;
  let hub: EventHub;
  let app: Hono;
  // The hub publishes user-scoped events as a no-op (no per-group
  // subscribers). To verify dispatch actually ran, we instrument the
  // hub via a wrapping subscriber on a synthetic groupId; better yet,
  // monkey-patch publish to capture every call.
  let captured: JunjoEvent[];

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    hub = new EventHub();
    captured = [];
    const originalPublish = hub.publish.bind(hub);
    hub.publish = (event: JunjoEvent) => {
      captured.push(event);
      originalPublish(event);
    };
    app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    captured.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setupGame(configPatch?: Record<string, unknown>) {
    const game = await createGame("Alpha", prisma);
    if (configPatch) {
      await prisma.game.update({
        where: { id: game.id },
        data: { config: configPatch as object },
      });
    }
    const { raw } = await createApiKey(game.id, prisma);
    return { gameId: game.id, apiKey: raw.full };
  }

  async function makeUser(gameId: string): Promise<string> {
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, externalUserId: u.id, junjoUserId: u.id },
    });
    return u.id;
  }

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
  }

  it("POST friend-request fires friend.request.sent (carries actor + target + requestId)", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const body = (await res.json()) as WireFriendRequestSendResult;
    expect(body.status).toBe("pending");

    expect(captured).toHaveLength(1);
    const evt = captured[0];
    expect(evt?.type).toBe("friend.request.sent");
    expect(evt?.gameId).toBe(gameId);
    if (evt?.type === "friend.request.sent") {
      expect(evt.actorJunjoUserId).toBe(a);
      expect(evt.targetJunjoUserId).toBe(b);
      expect(evt.requestId).toBe(body.request?.id);
    }
  });

  it("POST accept fires friend.request.accepted with the relationship snapshot", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;
    captured.length = 0; // ignore the .sent event from the request

    await app.request(`/v1/friend-requests/${req.id}/accept`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });

    expect(captured).toHaveLength(1);
    const evt = captured[0];
    expect(evt?.type).toBe("friend.request.accepted");
    if (evt?.type === "friend.request.accepted") {
      expect(evt.actorJunjoUserId).toBe(a);
      expect(evt.targetJunjoUserId).toBe(b);
      expect(evt.relationshipId).toBeDefined();
      expect(evt.respondedAt).toBeDefined();
    }
  });

  it("POST friend-request with requestsRequired=false fires friend.request.accepted only (no .sent)", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { requestsRequired: false } });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.type).toBe("friend.request.accepted");
  });

  it("POST decline fires friend.request.declined", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;
    captured.length = 0;

    await app.request(`/v1/friend-requests/${req.id}/decline`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(captured).toHaveLength(1);
    const evt = captured[0];
    expect(evt?.type).toBe("friend.request.declined");
    if (evt?.type === "friend.request.declined") {
      expect(evt.requestId).toBe(req.id);
      expect(evt.actorJunjoUserId).toBe(a);
      expect(evt.targetJunjoUserId).toBe(b);
    }
  });

  it("DELETE unfriend fires friend.removed", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;
    await app.request(`/v1/friend-requests/${req.id}/accept`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    captured.length = 0;

    await app.request(`/v1/users/${a}/friends/${b}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(captured).toHaveLength(1);
    const evt = captured[0];
    expect(evt?.type).toBe("friend.removed");
    if (evt?.type === "friend.removed") {
      expect(evt.removedByJunjoUserId).toBe(a);
      expect(evt.otherJunjoUserId).toBe(b);
    }
  });

  it("POST block fires friend.blocked", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(captured).toHaveLength(1);
    const evt = captured[0];
    expect(evt?.type).toBe("friend.blocked");
    if (evt?.type === "friend.blocked") {
      expect(evt.byJunjoUserId).toBe(a);
      expect(evt.otherJunjoUserId).toBe(b);
    }
  });

  it("friend events are durable (enqueued as webhook deliveries)", async () => {
    const { gameId, apiKey } = await setupGame();
    // Register a webhook endpoint subscribing to friend.request.sent.
    await prisma.webhookEndpoint.create({
      data: {
        gameId,
        url: "https://example.test/junjo-hook",
        secret: "topsecret",
        events: ["friend.request.sent"],
        format: "junjo",
      },
    });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.status).toBe("pending");
    const payload = deliveries[0]?.payload as { type?: string; actorJunjoUserId?: string };
    expect(payload?.type).toBe("friend.request.sent");
    expect(payload?.actorJunjoUserId).toBe(a);
  });

  it("friend events do not register on the SSE hub (no group context)", async () => {
    const { gameId, apiKey } = await setupGame();
    const groupId = "test-group" as never;
    let received = 0;
    hub.subscribe(groupId, () => {
      received += 1;
    });

    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(received).toBe(0);
  });
});
