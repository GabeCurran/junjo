import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface WireWebhookEndpoint {
  id: string;
  gameId: string;
  url: string;
  events: string[];
  createdAt: string;
  disabledAt: string | null;
}

interface WireWebhookEndpointWithSecret extends WireWebhookEndpoint {
  secret: string;
}

describe.skipIf(!TEST_DATABASE_URL)("webhook endpoint CRUD", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function jsonRequest(method: string, path: string, body?: unknown, header = authHeader) {
    return app.request(path, {
      method,
      headers: {
        authorization: header,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  describe("POST /v1/webhooks", () => {
    it("creates an endpoint with a server-generated secret and returns it", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "https://dev.example.com/hook",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpointWithSecret;
      expect(body.gameId).toBe(gameId);
      expect(body.url).toBe("https://dev.example.com/hook");
      expect(body.events).toEqual([]);
      expect(body.disabledAt).toBeNull();
      expect(typeof body.id).toBe("string");
      expect(typeof body.createdAt).toBe("string");
      expect(typeof body.secret).toBe("string");
      expect(body.secret.length).toBeGreaterThanOrEqual(32);

      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: body.id } });
      expect(stored?.secret).toBe(body.secret);
      expect(stored?.gameId).toBe(gameId);
    });

    it("uses a caller-supplied secret verbatim when present", async () => {
      const supplied = "supplied-secret-12345678";
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "https://dev.example.com/hook",
        secret: supplied,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpointWithSecret;
      expect(body.secret).toBe(supplied);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: body.id } });
      expect(stored?.secret).toBe(supplied);
    });

    it("forwards the events filter and stores it on the row", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "https://dev.example.com/hook",
        events: ["member.joined", "group.deleted"],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpointWithSecret;
      expect(body.events).toEqual(["member.joined", "group.deleted"]);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: body.id } });
      expect(stored?.events).toEqual(["member.joined", "group.deleted"]);
    });

    it("rejects an unknown event type", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "https://dev.example.com/hook",
        events: ["member.joined", "not.a.real.event"],
      });
      expect(res.status).toBe(400);
      const before = await prisma.webhookEndpoint.count();
      expect(before).toBe(0);
    });

    it("rejects a missing url", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {});
      expect(res.status).toBe(400);
    });

    it("rejects a non-http(s) URL scheme", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "ftp://dev.example.com/hook",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed URL", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "not a url",
      });
      expect(res.status).toBe(400);
    });

    it("rejects a secret that is too short", async () => {
      const res = await jsonRequest("POST", "/v1/webhooks", {
        url: "https://dev.example.com/hook",
        secret: "short",
      });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON", async () => {
      const res = await app.request("/v1/webhooks", {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: "{ malformed",
      });
      expect(res.status).toBe(400);
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/v1/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://dev.example.com/hook" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/webhooks", () => {
    it("returns an empty array when no endpoints are configured", async () => {
      const res = await jsonRequest("GET", "/v1/webhooks");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: WireWebhookEndpoint[] };
      expect(body.items).toEqual([]);
    });

    it("returns endpoints newest-first and omits the secret", async () => {
      const old = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://old.example.com/hook",
          secret: "old-secret-1234567890",
          events: [],
          createdAt: new Date("2026-04-01T00:00:00Z"),
        },
      });
      const newer = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://new.example.com/hook",
          secret: "new-secret-1234567890",
          events: ["member.joined"],
          createdAt: new Date("2026-04-02T00:00:00Z"),
        },
      });
      const res = await jsonRequest("GET", "/v1/webhooks");
      const body = (await res.json()) as { items: WireWebhookEndpoint[] };
      expect(body.items.map((i) => i.id)).toEqual([newer.id, old.id]);
      for (const item of body.items) {
        expect(item).not.toHaveProperty("secret");
      }
      expect(body.items[0]?.events).toEqual(["member.joined"]);
      expect(body.items[1]?.events).toEqual([]);
    });

    it("scopes endpoints to the calling game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      await prisma.webhookEndpoint.create({
        data: {
          gameId: otherGame.id,
          url: "https://other.example.com/hook",
          secret: "other-secret-1234567890",
          events: [],
        },
      });
      await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://mine.example.com/hook",
          secret: "mine-secret-1234567890",
          events: [],
        },
      });
      const res = await jsonRequest("GET", "/v1/webhooks");
      const body = (await res.json()) as { items: WireWebhookEndpoint[] };
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.url).toBe("https://mine.example.com/hook");
    });

    it("returns disabledAt as ISO 8601 when set", async () => {
      const disabledAt = new Date("2026-04-15T00:00:00Z");
      await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://dev.example.com/hook",
          secret: "muted-secret-1234567890",
          events: [],
          disabledAt,
        },
      });
      const res = await jsonRequest("GET", "/v1/webhooks");
      const body = (await res.json()) as { items: WireWebhookEndpoint[] };
      expect(body.items[0]?.disabledAt).toBe(disabledAt.toISOString());
    });

    it("returns 401 without auth", async () => {
      const res = await app.request("/v1/webhooks", { method: "GET" });
      expect(res.status).toBe(401);
    });
  });

  describe("PATCH /v1/webhooks/:id", () => {
    async function seedEndpoint(
      overrides: Partial<{
        url: string;
        events: string[];
        disabledAt: Date | null;
        gameId: string;
      }> = {},
    ) {
      return prisma.webhookEndpoint.create({
        data: {
          gameId: overrides.gameId ?? gameId,
          url: overrides.url ?? "https://dev.example.com/hook",
          secret: "test-secret-1234567890",
          events: overrides.events ?? [],
          disabledAt: overrides.disabledAt ?? null,
        },
      });
    }

    it("updates the URL and returns the post-state without the secret", async () => {
      const ep = await seedEndpoint();
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, {
        url: "https://renamed.example.com/hook",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpoint;
      expect(body.url).toBe("https://renamed.example.com/hook");
      expect(body).not.toHaveProperty("secret");
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } });
      expect(stored?.url).toBe("https://renamed.example.com/hook");
    });

    it("updates the events filter", async () => {
      const ep = await seedEndpoint({ events: ["member.joined"] });
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, {
        events: ["group.updated", "role.created"],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpoint;
      expect(body.events).toEqual(["group.updated", "role.created"]);
    });

    it("clears the events filter when an empty array is supplied", async () => {
      const ep = await seedEndpoint({ events: ["member.joined"] });
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, { events: [] });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpoint;
      expect(body.events).toEqual([]);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } });
      expect(stored?.events).toEqual([]);
    });

    it("disables the endpoint and stamps disabledAt when disabled: true", async () => {
      const ep = await seedEndpoint();
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, { disabled: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpoint;
      expect(body.disabledAt).not.toBeNull();
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } });
      expect(stored?.disabledAt).toBeInstanceOf(Date);
    });

    it("re-enables the endpoint and clears disabledAt when disabled: false", async () => {
      const ep = await seedEndpoint({ disabledAt: new Date("2026-04-15T00:00:00Z") });
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, { disabled: false });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireWebhookEndpoint;
      expect(body.disabledAt).toBeNull();
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } });
      expect(stored?.disabledAt).toBeNull();
    });

    it("is idempotent on a no-op PATCH (matching url, events, disabled)", async () => {
      const ep = await seedEndpoint({ events: ["member.joined"] });
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, {
        url: ep.url,
        events: ["member.joined"],
        disabled: false,
      });
      expect(res.status).toBe(200);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } });
      expect(stored?.url).toBe(ep.url);
      expect(stored?.disabledAt).toBeNull();
    });

    it("rejects an empty body", async () => {
      const ep = await seedEndpoint();
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, {});
      expect(res.status).toBe(400);
    });

    it("rejects an unknown event type", async () => {
      const ep = await seedEndpoint();
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, {
        events: ["bogus.event"],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a non-http(s) URL", async () => {
      const ep = await seedEndpoint();
      const res = await jsonRequest("PATCH", `/v1/webhooks/${ep.id}`, {
        url: "ftp://nope.example.com/hook",
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 for a missing endpoint", async () => {
      const res = await jsonRequest("PATCH", "/v1/webhooks/whe_missing", { disabled: true });
      expect(res.status).toBe(404);
    });

    it("returns 404 for cross-game endpoints (no row leak)", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const otherEp = await prisma.webhookEndpoint.create({
        data: {
          gameId: otherGame.id,
          url: "https://other.example.com/hook",
          secret: "other-secret-1234567890",
          events: [],
        },
      });
      const res = await jsonRequest("PATCH", `/v1/webhooks/${otherEp.id}`, {
        disabled: true,
      });
      expect(res.status).toBe(404);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: otherEp.id } });
      expect(stored?.disabledAt).toBeNull();
    });

    it("returns 401 without auth", async () => {
      const ep = await seedEndpoint();
      const res = await app.request(`/v1/webhooks/${ep.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ disabled: true }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /v1/webhooks/:id", () => {
    it("hard-deletes the endpoint and returns 204", async () => {
      const ep = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://dev.example.com/hook",
          secret: "test-secret-1234567890",
          events: [],
        },
      });
      const res = await jsonRequest("DELETE", `/v1/webhooks/${ep.id}`);
      expect(res.status).toBe(204);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: ep.id } });
      expect(stored).toBeNull();
    });

    it("cascades to pending WebhookDelivery rows", async () => {
      const ep = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://dev.example.com/hook",
          secret: "test-secret-1234567890",
          events: [],
        },
      });
      await prisma.webhookDelivery.create({
        data: {
          webhookEndpointId: ep.id,
          eventId: "evt_1",
          payload: { hi: 1 },
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date(),
        },
      });
      const res = await jsonRequest("DELETE", `/v1/webhooks/${ep.id}`);
      expect(res.status).toBe(204);
      const remaining = await prisma.webhookDelivery.count();
      expect(remaining).toBe(0);
    });

    it("returns 404 on a missing endpoint", async () => {
      const res = await jsonRequest("DELETE", "/v1/webhooks/whe_missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 for cross-game endpoints (no row deleted)", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const otherEp = await prisma.webhookEndpoint.create({
        data: {
          gameId: otherGame.id,
          url: "https://other.example.com/hook",
          secret: "other-secret-1234567890",
          events: [],
        },
      });
      const res = await jsonRequest("DELETE", `/v1/webhooks/${otherEp.id}`);
      expect(res.status).toBe(404);
      const stored = await prisma.webhookEndpoint.findUnique({ where: { id: otherEp.id } });
      expect(stored).not.toBeNull();
    });

    it("returns 404 on the second delete (idempotency: not built in)", async () => {
      const ep = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://dev.example.com/hook",
          secret: "test-secret-1234567890",
          events: [],
        },
      });
      const first = await jsonRequest("DELETE", `/v1/webhooks/${ep.id}`);
      expect(first.status).toBe(204);
      const second = await jsonRequest("DELETE", `/v1/webhooks/${ep.id}`);
      expect(second.status).toBe(404);
    });

    it("returns 401 without auth", async () => {
      const ep = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://dev.example.com/hook",
          secret: "test-secret-1234567890",
          events: [],
        },
      });
      const res = await app.request(`/v1/webhooks/${ep.id}`, { method: "DELETE" });
      expect(res.status).toBe(401);
    });
  });
});
