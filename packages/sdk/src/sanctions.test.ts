import type { UserId } from "@junjo.io/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError, isNotActive } from "./index.js";

const U = "mc:alice" as UserId;

interface Captured {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(respond: (req: Captured) => Response) {
  const calls: Captured[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input.toString(), init);
    const captured: Captured = {
      method: req.method,
      url: new URL(req.url),
      headers: req.headers,
      body: init?.body === undefined || init.body === null ? "" : await req.text(),
    };
    calls.push(captured);
    return respond(captured);
  });
  const junjo = new Junjo({
    apiKey: "jk_test.secret",
    baseUrl: "https://example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { junjo, calls };
}

const wireSanction = {
  id: "san_1",
  userId: U,
  type: "mute",
  reason: "spam in global chat",
  issuer: "Console",
  issuedBy: "mc:mod",
  startedAt: "2026-11-09T12:00:00.000Z",
  expiresAt: "2026-11-09T13:00:00.000Z",
  version: 4,
};

const wireHistory = {
  id: "sh_1",
  gameId: "game_1",
  userId: U,
  type: "mute",
  kind: "lifted",
  reason: null,
  expiresAt: null,
  eventAt: "2026-11-09T12:30:00.000Z",
  actorUserId: "mc:mod",
  issuer: null,
};

describe("sanctions.add", () => {
  it("POSTs /v1/sanctions with the user, type and only the fields given", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse(wireSanction, 201));
    const sanction = await junjo.sanctions.add(U, { type: "mute" });
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.pathname).toBe("/v1/sanctions");
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ userId: U, type: "mute" });
    expect(sanction).toEqual({
      id: "san_1",
      userId: U,
      type: "mute",
      reason: "spam in global chat",
      issuer: "Console",
      issuedBy: "mc:mod",
      startedAt: new Date("2026-11-09T12:00:00.000Z"),
      expiresAt: new Date("2026-11-09T13:00:00.000Z"),
      version: 4,
    });
  });

  it("serializes Date fields to ISO and passes every optional field", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse(wireSanction, 201));
    await junjo.sanctions.add(U, {
      type: "trade.lock",
      reason: "scam report",
      expiresAt: new Date("2026-11-10T00:00:00.000Z"),
      startedAt: "2026-11-01T00:00:00.000Z",
      issuer: "Console",
      actorUserId: "mc:mod" as UserId,
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      userId: U,
      type: "trade.lock",
      reason: "scam report",
      expiresAt: "2026-11-10T00:00:00.000Z",
      startedAt: "2026-11-01T00:00:00.000Z",
      issuer: "Console",
      actorUserId: "mc:mod",
    });
  });

  it("sends an explicit null expiresAt and reason", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse(wireSanction, 200));
    await junjo.sanctions.add(U, { type: "mute", reason: null, expiresAt: null });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({
      userId: U,
      type: "mute",
      reason: null,
      expiresAt: null,
    });
  });

  it("decodes a permanent sanction with no issuer", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse({ ...wireSanction, expiresAt: null, issuedBy: null, issuer: null }),
    );
    const sanction = await junjo.sanctions.add(U, { type: "mute" });
    expect(sanction.expiresAt).toBeNull();
    expect(sanction.issuedBy).toBeNull();
    expect(sanction.issuer).toBeNull();
  });

  it("sends If-Match and Idempotency-Key", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse(wireSanction, 201));
    await junjo.sanctions.add(U, { type: "mute" }, { ifMatch: 3, idempotencyKey: "q-1" });
    expect(calls[0]?.headers.get("if-match")).toBe('"3"');
    expect(calls[0]?.headers.get("idempotency-key")).toBe("q-1");
  });

  it("surfaces bad_request for the reserved type", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse({ code: "bad_request", status: 400, message: "reserved" }, 400),
    );
    const err = await junjo.sanctions.add(U, { type: "ban" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JunjoError);
    expect((err as JunjoError).code).toBe("bad_request");
  });

  it("throws invalid_wire_data naming startedAt on a malformed timestamp", async () => {
    const { junjo } = makeClient(() => jsonResponse({ ...wireSanction, startedAt: "x" }));
    await expect(junjo.sanctions.add(U, { type: "mute" })).rejects.toMatchObject({
      code: "invalid_wire_data",
      message: expect.stringContaining("startedAt"),
    });
  });
});

describe("sanctions.remove", () => {
  it("DELETEs /v1/sanctions/:userId/:type with both segments encoded and no body", async () => {
    const { junjo, calls } = makeClient(() => new Response(null, { status: 204 }));
    await junjo.sanctions.remove("a/b" as UserId, "trade.lock");
    expect(calls[0]?.method).toBe("DELETE");
    expect(calls[0]?.url.pathname).toBe("/v1/sanctions/a%2Fb/trade.lock");
    expect(calls[0]?.body).toBe("");
  });

  it("sends the actor in the body and the write headers", async () => {
    const { junjo, calls } = makeClient(() => new Response(null, { status: 204 }));
    await junjo.sanctions.remove(U, "mute", {
      actorUserId: "mc:mod" as UserId,
      ifMatch: 5,
      idempotencyKey: "lift-1",
    });
    expect(JSON.parse(calls[0]?.body ?? "")).toEqual({ actorUserId: "mc:mod" });
    expect(calls[0]?.headers.get("if-match")).toBe('"5"');
    expect(calls[0]?.headers.get("idempotency-key")).toBe("lift-1");
  });

  it("surfaces nothing-to-lift as a not_active not_found", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse(
        { code: "not_found", status: 404, message: "none", details: { reason: "not_active" } },
        404,
      ),
    );
    const err = await junjo.sanctions.remove(U, "mute").catch((e: unknown) => e);
    expect(isNotActive(err)).toBe(true);
  });
});

describe("sanctions.list", () => {
  it("GETs /v1/sanctions with no query by default", async () => {
    const { junjo, calls } = makeClient(() =>
      jsonResponse({ items: [wireSanction], nextCursor: null }),
    );
    const page = await junjo.sanctions.list();
    expect(calls[0]?.url.pathname).toBe("/v1/sanctions");
    expect(calls[0]?.url.search).toBe("");
    expect(page.items[0]?.startedAt).toBeInstanceOf(Date);
    expect(page.nextCursor).toBeNull();
  });

  it("passes type, limit and cursor", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse({ items: [], nextCursor: null }));
    await junjo.sanctions.list({ type: "mute", limit: 10, cursor: "c1" });
    const q = calls[0]?.url.searchParams;
    expect(q?.get("type")).toBe("mute");
    expect(q?.get("limit")).toBe("10");
    expect(q?.get("cursor")).toBe("c1");
  });

  it("listAll walks every page, carrying the filter", async () => {
    const { junjo, calls } = makeClient((req) =>
      req.url.searchParams.get("cursor") === null
        ? jsonResponse({ items: [wireSanction], nextCursor: "c2" })
        : jsonResponse({ items: [{ ...wireSanction, id: "san_2" }], nextCursor: null }),
    );
    const ids: string[] = [];
    for await (const s of junjo.sanctions.listAll({ type: "mute" })) ids.push(s.id);
    expect(ids).toEqual(["san_1", "san_2"]);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.searchParams.get("cursor")).toBe("c2");
    expect(calls[1]?.url.searchParams.get("type")).toBe("mute");
  });
});

describe("sanctions.forUser", () => {
  it("GETs the person's active sanctions", async () => {
    const { junjo, calls } = makeClient(() => jsonResponse({ items: [wireSanction] }));
    const items = await junjo.sanctions.forUser(U);
    expect(calls[0]?.url.pathname).toBe("/v1/users/mc%3Aalice/sanctions");
    expect(items).toHaveLength(1);
    expect(items[0]?.type).toBe("mute");
  });

  it("returns an empty list for a person never seen", async () => {
    const { junjo } = makeClient(() => jsonResponse({ items: [] }));
    expect(await junjo.sanctions.forUser("mc:new" as UserId)).toEqual([]);
  });
});

describe("sanctions.history", () => {
  it("GETs the history route and decodes entries", async () => {
    const { junjo, calls } = makeClient(() =>
      jsonResponse({ items: [wireHistory], nextCursor: null }),
    );
    const page = await junjo.sanctions.history(U, { type: "mute", limit: 5 });
    expect(calls[0]?.url.pathname).toBe("/v1/users/mc%3Aalice/sanctions/history");
    expect(calls[0]?.url.searchParams.get("type")).toBe("mute");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("5");
    expect(page.items[0]).toEqual({
      id: "sh_1",
      gameId: "game_1",
      userId: U,
      type: "mute",
      kind: "lifted",
      reason: null,
      expiresAt: null,
      eventAt: new Date("2026-11-09T12:30:00.000Z"),
      actorUserId: "mc:mod",
      issuer: null,
    });
  });

  it("decodes a set entry with an expiry and issuer", async () => {
    const { junjo } = makeClient(() =>
      jsonResponse({
        items: [
          {
            ...wireHistory,
            kind: "set",
            reason: "spam",
            expiresAt: "2026-11-09T13:00:00.000Z",
            actorUserId: null,
            issuer: "Console",
          },
        ],
        nextCursor: null,
      }),
    );
    const page = await junjo.sanctions.history(U);
    expect(page.items[0]?.kind).toBe("set");
    expect(page.items[0]?.expiresAt).toEqual(new Date("2026-11-09T13:00:00.000Z"));
    expect(page.items[0]?.actorUserId).toBeNull();
    expect(page.items[0]?.issuer).toBe("Console");
  });

  it("historyAll walks every page", async () => {
    const { junjo } = makeClient((req) =>
      req.url.searchParams.get("cursor") === null
        ? jsonResponse({ items: [wireHistory], nextCursor: "n" })
        : jsonResponse({ items: [{ ...wireHistory, id: "sh_2" }], nextCursor: null }),
    );
    const ids: string[] = [];
    for await (const e of junjo.sanctions.historyAll(U)) ids.push(e.id);
    expect(ids).toEqual(["sh_1", "sh_2"]);
  });
});
