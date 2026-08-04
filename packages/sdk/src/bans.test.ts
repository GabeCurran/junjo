import type { UserId } from "@junjo-io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo } from "./index.js";

function makeFetch(handler: (req: Request) => Promise<Response>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input.clone() : new Request(input.toString(), init);
    return handler(req);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const banFixture = {
  id: "ban_1",
  gameId: "game_1",
  userId: "user_alice",
  bannedAt: "2026-05-09T00:00:00.000Z",
  expiresAt: null as string | null,
  reason: null as string | null,
  bannedBy: null as string | null,
};

describe("client.bans.list", () => {
  it("GETs /v1/bans with no query when no opts", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("GET");
      const u = new URL(req.url);
      expect(u.pathname).toBe("/v1/bans");
      expect(u.search).toBe("");
      return jsonResponse({ items: [banFixture], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.bans.list();
    expect(page.items[0]?.userId).toBe("user_alice");
    expect(page.items[0]?.bannedAt).toBeInstanceOf(Date);
    expect(page.items[0]?.expiresAt).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("forwards limit, cursor, and includeExpired", async () => {
    const fetchMock = makeFetch(async (req) => {
      const u = new URL(req.url);
      expect(u.searchParams.get("limit")).toBe("25");
      expect(u.searchParams.get("cursor")).toBe("ban_42");
      expect(u.searchParams.get("includeExpired")).toBe("true");
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.list({ limit: 25, cursor: "ban_42", includeExpired: true });
  });

  it("omits includeExpired when false (default)", async () => {
    const fetchMock = makeFetch(async (req) => {
      const u = new URL(req.url);
      expect(u.searchParams.has("includeExpired")).toBe(false);
      return jsonResponse({ items: [], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.list({ includeExpired: false });
  });

  it("deserializes a non-null expiresAt to a Date", async () => {
    const expiry = "2026-06-01T00:00:00.000Z";
    const fetchMock = makeFetch(async () =>
      jsonResponse({
        items: [{ ...banFixture, expiresAt: expiry }],
        nextCursor: null,
      }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.bans.list();
    expect(page.items[0]?.expiresAt).toBeInstanceOf(Date);
    expect(page.items[0]?.expiresAt?.toISOString()).toBe(expiry);
  });
});

describe("client.bans.add", () => {
  it("POSTs /v1/bans with userId only when no opts", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("POST");
      expect(new URL(req.url).pathname).toBe("/v1/bans");
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ userId: "user_alice" });
      return jsonResponse(banFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const ban = await junjo.bans.add({ userId: "user_alice" as UserId });
    expect(ban.userId).toBe("user_alice");
  });

  it("forwards reason and Date expiresAt as ISO string", async () => {
    const expiry = new Date("2026-06-01T00:00:00.000Z");
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({
        userId: "user_alice",
        reason: "cheating",
        expiresAt: "2026-06-01T00:00:00.000Z",
      });
      return jsonResponse(
        { ...banFixture, reason: "cheating", expiresAt: expiry.toISOString() },
        201,
      );
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.add({
      userId: "user_alice" as UserId,
      reason: "cheating",
      expiresAt: expiry,
    });
  });

  it("forwards an ISO-string expiresAt verbatim", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload.expiresAt).toBe("2026-06-01T00:00:00.000Z");
      return jsonResponse(banFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.add({
      userId: "user_alice" as UserId,
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("forwards explicit null expiresAt to lift the expiry on a re-ban", async () => {
    const fetchMock = makeFetch(async (req) => {
      const payload = (await req.json()) as Record<string, unknown>;
      expect(payload).toEqual({ userId: "user_alice", expiresAt: null });
      return jsonResponse(banFixture, 201);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.add({ userId: "user_alice" as UserId, expiresAt: null });
  });
});

describe("client.bans.remove", () => {
  it("DELETEs /v1/bans/:userId", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      expect(new URL(req.url).pathname).toBe("/v1/bans/user_alice");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.remove("user_alice" as UserId);
  });

  it("URL-encodes the user id", async () => {
    const fetchMock = makeFetch(async (req) => {
      expect(new URL(req.url).pathname).toBe("/v1/bans/weird%2Fuser");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.bans.remove("weird/user" as UserId);
  });

  it("throws JunjoError on 404 not_found", async () => {
    const fetchMock = makeFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "ban not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(junjo.bans.remove("ghost" as UserId)).rejects.toMatchObject({
      name: "JunjoError",
      code: "not_found",
    });
  });
});
