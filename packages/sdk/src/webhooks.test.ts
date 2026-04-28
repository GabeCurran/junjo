import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";
import { WEBHOOK_SIGNATURE_SCHEME, signWebhookBody, verifyWebhook } from "./webhooks.js";

const SECRET = "topsecret-1234";

const sampleEvent = {
  id: "evt_1",
  type: "group.updated",
  gameId: "game_1",
  groupId: "grp_1",
  occurredAt: "2026-04-28T05:00:00.000Z",
  group: {
    id: "grp_1",
    gameId: "game_1",
    kind: "guild",
    name: "Crimson Wolves",
    visibility: "invite-only",
    metadata: {},
    defaultRoleId: null,
    parentGroupId: null,
    memberCount: 0,
    createdAt: "2026-04-28T05:00:00.000Z",
    updatedAt: "2026-04-28T05:01:00.000Z",
    softDeletedAt: null,
  },
};

interface SignedDelivery {
  body: string;
  headers: Record<string, string>;
  timestamp: string;
}

async function buildSignedDelivery(
  payload: unknown,
  secret: string,
  timestampOverride?: string,
): Promise<SignedDelivery> {
  const body = JSON.stringify(payload);
  const timestamp = timestampOverride ?? "2026-04-28T05:00:30.000Z";
  const signature = await signWebhookBody(secret, body, timestamp);
  return {
    body,
    timestamp,
    headers: {
      "x-junjo-signature": signature,
      "x-junjo-timestamp": timestamp,
      "x-junjo-event": "group.updated",
      "x-junjo-event-id": "evt_1",
      "x-junjo-delivery-id": "del_1",
    },
  };
}

const FROZEN_NOW = () => new Date("2026-04-28T05:00:30.000Z");

describe("signWebhookBody", () => {
  it("produces the v1=<hex> scheme prefix for HMAC-SHA256 over <timestamp>.<body>", async () => {
    const out = await signWebhookBody("secret", "hello", "2026-04-28T05:00:00.000Z");
    expect(out).toMatch(new RegExp(`^${WEBHOOK_SIGNATURE_SCHEME}=[0-9a-f]{64}$`));
  });

  it("differs across different secrets (same body + timestamp)", async () => {
    const a = await signWebhookBody("a", "x", "ts");
    const b = await signWebhookBody("b", "x", "ts");
    expect(a).not.toBe(b);
  });

  it("differs across different bodies (same secret + timestamp)", async () => {
    const a = await signWebhookBody("k", "x", "ts");
    const b = await signWebhookBody("k", "y", "ts");
    expect(a).not.toBe(b);
  });

  it("differs across different timestamps (same secret + body)", async () => {
    const a = await signWebhookBody("k", "x", "ts1");
    const b = await signWebhookBody("k", "x", "ts2");
    expect(a).not.toBe(b);
  });

  it("is deterministic for matching inputs", async () => {
    const a = await signWebhookBody("k", "x", "ts");
    const b = await signWebhookBody("k", "x", "ts");
    expect(a).toBe(b);
  });
});

describe("verifyWebhook", () => {
  it("returns the parsed JunjoEvent on a valid signature", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const event = await verifyWebhook(body, headers, SECRET, { now: FROZEN_NOW });
    expect(event.type).toBe("group.updated");
    expect(event.id).toBe("evt_1");
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.occurredAt.toISOString()).toBe("2026-04-28T05:00:00.000Z");
    if (event.type === "group.updated") {
      expect(event.group.name).toBe("Crimson Wolves");
      expect(event.group.createdAt).toBeInstanceOf(Date);
    }
  });

  it("accepts a Uint8Array body", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const bytes = new TextEncoder().encode(body);
    const event = await verifyWebhook(bytes, headers, SECRET, { now: FROZEN_NOW });
    expect(event.type).toBe("group.updated");
  });

  it("looks up headers case-insensitively", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const upperHeaders: Record<string, string> = {
      "X-Junjo-Signature": headers["x-junjo-signature"] as string,
      "X-Junjo-Timestamp": headers["x-junjo-timestamp"] as string,
    };
    const event = await verifyWebhook(body, upperHeaders, SECRET, { now: FROZEN_NOW });
    expect(event.type).toBe("group.updated");
  });

  it("accepts string-array header values (Express IncomingHttpHeaders shape)", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const arrayHeaders: Record<string, string[] | string | undefined> = {
      "x-junjo-signature": [headers["x-junjo-signature"] as string],
      "x-junjo-timestamp": [headers["x-junjo-timestamp"] as string],
    };
    const event = await verifyWebhook(body, arrayHeaders, SECRET, { now: FROZEN_NOW });
    expect(event.type).toBe("group.updated");
  });

  it("throws webhook_signature_missing when the signature header is absent", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const { "x-junjo-signature": _omit, ...stripped } = headers;
    await expect(verifyWebhook(body, stripped, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_signature_missing",
      status: 400,
    });
  });

  it("throws webhook_timestamp_missing when the timestamp header is absent", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const { "x-junjo-timestamp": _omit, ...stripped } = headers;
    await expect(verifyWebhook(body, stripped, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_timestamp_missing",
      status: 400,
    });
  });

  it("throws webhook_timestamp_invalid on a malformed timestamp", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const tampered = { ...headers, "x-junjo-timestamp": "not-a-date" };
    await expect(verifyWebhook(body, tampered, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_timestamp_invalid",
      status: 400,
    });
  });

  it("throws webhook_timestamp_out_of_tolerance on a stale (replay) timestamp", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const sixMinAfter = () => new Date("2026-04-28T05:06:31.000Z");
    await expect(verifyWebhook(body, headers, SECRET, { now: sixMinAfter })).rejects.toMatchObject({
      code: "webhook_timestamp_out_of_tolerance",
      status: 400,
    });
  });

  it("throws webhook_timestamp_out_of_tolerance on a future-dated timestamp", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const wayBefore = () => new Date("2026-04-27T05:00:30.000Z");
    await expect(verifyWebhook(body, headers, SECRET, { now: wayBefore })).rejects.toMatchObject({
      code: "webhook_timestamp_out_of_tolerance",
      status: 400,
    });
  });

  it("respects a custom tolerance value", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const fiveMinThirtySecAfter = () => new Date("2026-04-28T05:06:00.000Z");
    await expect(
      verifyWebhook(body, headers, SECRET, {
        now: fiveMinThirtySecAfter,
        tolerance: 10 * 60_000,
      }),
    ).resolves.toMatchObject({ type: "group.updated" });
  });

  it("throws webhook_invalid_signature when the body is tampered", async () => {
    const { headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const tamperedBody = JSON.stringify({
      ...sampleEvent,
      group: { ...sampleEvent.group, name: "Hacked" },
    });
    await expect(
      verifyWebhook(tamperedBody, headers, SECRET, { now: FROZEN_NOW }),
    ).rejects.toMatchObject({ code: "webhook_invalid_signature", status: 400 });
  });

  it("throws webhook_invalid_signature when the secret does not match the signing secret", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    await expect(
      verifyWebhook(body, headers, "wrong-secret", { now: FROZEN_NOW }),
    ).rejects.toMatchObject({ code: "webhook_invalid_signature", status: 400 });
  });

  it("throws webhook_invalid_signature when the signature header is malformed", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const tampered = { ...headers, "x-junjo-signature": "v1=garbage" };
    await expect(verifyWebhook(body, tampered, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_invalid_signature",
      status: 400,
    });
  });

  it("throws webhook_invalid_body when the body is not valid JSON", async () => {
    const garbage = "not json at all";
    const ts = "2026-04-28T05:00:30.000Z";
    const sig = await signWebhookBody(SECRET, garbage, ts);
    const headers = {
      "x-junjo-signature": sig,
      "x-junjo-timestamp": ts,
    };
    await expect(
      verifyWebhook(garbage, headers, SECRET, { now: FROZEN_NOW }),
    ).rejects.toMatchObject({
      code: "webhook_invalid_body",
      status: 400,
    });
  });

  it("uses Date.now() by default when no `now` option is supplied", async () => {
    const nowReal = new Date();
    const ts = nowReal.toISOString();
    const body = JSON.stringify({ ...sampleEvent, occurredAt: ts });
    const sig = await signWebhookBody(SECRET, body, ts);
    const headers = { "x-junjo-signature": sig, "x-junjo-timestamp": ts };
    await expect(verifyWebhook(body, headers, SECRET)).resolves.toMatchObject({
      type: "group.updated",
    });
  });

  it("rehydrates Date fields nested inside the event payload", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const event = await verifyWebhook(body, headers, SECRET, { now: FROZEN_NOW });
    if (event.type !== "group.updated") throw new Error("expected group.updated");
    expect(event.group.createdAt).toBeInstanceOf(Date);
    expect(event.group.updatedAt).toBeInstanceOf(Date);
    expect(event.group.softDeletedAt).toBeNull();
  });
});

describe("Junjo.webhooks", () => {
  it("is wired on the Junjo instance and verify resolves on a valid signature", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const event = await junjo.webhooks.verify(body, headers, SECRET, { now: FROZEN_NOW });
    expect(event.type).toBe("group.updated");
  });

  it("propagates JunjoError for tampered bodies via the instance method", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { headers } = await buildSignedDelivery(sampleEvent, SECRET);
    await expect(
      junjo.webhooks.verify('{"tampered": true}', headers, SECRET, { now: FROZEN_NOW }),
    ).rejects.toBeInstanceOf(JunjoError);
  });
});

interface FakeRes {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  send(body?: unknown): void;
  sendStatus(code: number): void;
}

function fakeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body?: unknown) {
      this.body = body;
    },
    sendStatus(code: number) {
      this.statusCode = code;
    },
  };
  return res;
}

describe("WebhooksApi.middleware", () => {
  it("verifies, attaches the parsed event to req.body, and calls next() with no args", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const mw = junjo.webhooks.middleware(SECRET, { now: FROZEN_NOW });

    const req = { headers, body: new TextEncoder().encode(body), rawBody: undefined };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(res.statusCode).toBe(200);
    const event = req.body as unknown as { type: string };
    expect(event.type).toBe("group.updated");
  });

  it("uses req.rawBody when present (express.json bodyparser ahead of the middleware)", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const mw = junjo.webhooks.middleware(SECRET, { now: FROZEN_NOW });

    const req = {
      headers,
      body: { alreadyParsed: true },
      rawBody: new TextEncoder().encode(body),
    };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect((req.body as unknown as { type: string }).type).toBe("group.updated");
  });

  it("responds 400 with a message and does NOT call next() on signature mismatch", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const mw = junjo.webhooks.middleware(SECRET, { now: FROZEN_NOW });

    const req = {
      headers,
      body: new TextEncoder().encode('{"tampered": true}'),
      rawBody: undefined,
    };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(typeof res.body).toBe("string");
    expect(res.body).toMatch(/signature does not match/);
  });

  it("responds 400 when the request has no parseable body (raw middleware not mounted)", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const mw = junjo.webhooks.middleware(SECRET, { now: FROZEN_NOW });

    const req = { headers: {}, body: { alreadyParsed: true }, rawBody: undefined };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/express\.raw/);
  });

  it("responds 400 with the timestamp-out-of-tolerance message on replay", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const replayLater = () => new Date("2026-04-28T05:06:31.000Z");
    const mw = junjo.webhooks.middleware(SECRET, { now: replayLater });

    const req = { headers, body: new TextEncoder().encode(body), rawBody: undefined };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/tolerance window/);
  });

  it("accepts a string body in req.body (legacy frameworks)", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const mw = junjo.webhooks.middleware(SECRET, { now: FROZEN_NOW });

    const req = { headers, body, rawBody: undefined };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect((req.body as unknown as { type: string }).type).toBe("group.updated");
  });
});

// =====================================================================
// junjo.webhooks.endpoints CRUD
// =====================================================================

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function endpointFetch(handler: (req: Request) => Response | Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof URL ? url.toString() : (url as string);
    const req = new Request(target, init);
    return handler(req);
  });
}

const wireEndpoint = {
  id: "whe_1",
  gameId: "game_1",
  url: "https://dev.example.com/hook",
  events: ["member.joined"],
  format: "junjo",
  createdAt: "2026-04-28T05:00:00.000Z",
  disabledAt: null,
};

const wireEndpointWithSecret = { ...wireEndpoint, secret: "generated-secret" };

describe("WebhookEndpointsApi.create", () => {
  it("POSTs /v1/webhooks with the auth header, body, and returns the deserialized endpoint with secret", async () => {
    const fetchMock = endpointFetch(async (req) => {
      expect(req.method).toBe("POST");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      expect(req.headers.get("content-type")).toBe("application/json");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ url: "https://dev.example.com/hook" });
      return jsonResponse(wireEndpointWithSecret);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const created = await junjo.webhooks.endpoints.create({
      url: "https://dev.example.com/hook",
    });
    expect(created.id).toBe("whe_1");
    expect(created.gameId).toBe("game_1");
    expect(created.url).toBe("https://dev.example.com/hook");
    expect(created.events).toEqual(["member.joined"]);
    expect(created.secret).toBe("generated-secret");
    expect(created.createdAt).toBeInstanceOf(Date);
    expect(created.createdAt.toISOString()).toBe("2026-04-28T05:00:00.000Z");
    expect(created.disabledAt).toBeNull();
  });

  it("forwards optional events and secret in the body", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({
        url: "https://dev.example.com/hook",
        events: ["group.deleted", "group.updated"],
        secret: "supplied-secret-1234",
      });
      return jsonResponse(wireEndpointWithSecret);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.webhooks.endpoints.create({
      url: "https://dev.example.com/hook",
      events: ["group.deleted", "group.updated"],
      secret: "supplied-secret-1234",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("forwards the format field when set to discord", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({
        url: "https://discord.com/api/webhooks/1/abc",
        format: "discord",
      });
      return jsonResponse({ ...wireEndpointWithSecret, format: "discord" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const created = await junjo.webhooks.endpoints.create({
      url: "https://discord.com/api/webhooks/1/abc",
      format: "discord",
    });
    expect(created.format).toBe("discord");
  });

  it("deserializes the format field from the wire response", async () => {
    const fetchMock = endpointFetch(async () =>
      jsonResponse({ ...wireEndpointWithSecret, format: "discord" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const created = await junjo.webhooks.endpoints.create({
      url: "https://dev.example.com/hook",
    });
    expect(created.format).toBe("discord");
  });

  it("propagates JunjoError on a 400 response", async () => {
    const fetchMock = endpointFetch(async () =>
      jsonResponse({ code: "bad_request", status: 400, message: "url is required" }, 400),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(junjo.webhooks.endpoints.create({ url: "" })).rejects.toMatchObject({
      code: "bad_request",
      status: 400,
    });
  });

  it("rehydrates disabledAt to a Date when set on the wire", async () => {
    const fetchMock = endpointFetch(async () =>
      jsonResponse({ ...wireEndpointWithSecret, disabledAt: "2026-04-28T06:00:00.000Z" }),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const created = await junjo.webhooks.endpoints.create({
      url: "https://dev.example.com/hook",
    });
    expect(created.disabledAt).toBeInstanceOf(Date);
    expect(created.disabledAt?.toISOString()).toBe("2026-04-28T06:00:00.000Z");
  });
});

describe("WebhookEndpointsApi.list", () => {
  it("GETs /v1/webhooks and returns deserialized endpoints (no secret on the wire)", async () => {
    const fetchMock = endpointFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [wireEndpoint] });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const items = await junjo.webhooks.endpoints.list();
    expect(items).toHaveLength(1);
    expect(items[0]?.id).toBe("whe_1");
    expect((items[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect(items[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("returns an empty array when the server returns no items", async () => {
    const fetchMock = endpointFetch(async () => jsonResponse({ items: [] }));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const items = await junjo.webhooks.endpoints.list();
    expect(items).toEqual([]);
  });

  it("propagates JunjoError on a non-2xx response", async () => {
    const fetchMock = endpointFetch(async () =>
      jsonResponse({ code: "invalid_api_key", status: 401, message: "invalid" }, 401),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(junjo.webhooks.endpoints.list()).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
  });
});

describe("WebhookEndpointsApi.update", () => {
  it("PATCHes /v1/webhooks/:id with the supplied fields and returns the post-state", async () => {
    const fetchMock = endpointFetch(async (req) => {
      expect(req.method).toBe("PATCH");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks/whe_1");
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({
        url: "https://renamed.example.com/hook",
        events: ["group.deleted"],
        disabled: true,
      });
      return jsonResponse({
        ...wireEndpoint,
        url: "https://renamed.example.com/hook",
        events: ["group.deleted"],
        disabledAt: "2026-04-28T07:00:00.000Z",
      });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const updated = await junjo.webhooks.endpoints.update("whe_1" as never, {
      url: "https://renamed.example.com/hook",
      events: ["group.deleted"],
      disabled: true,
    });
    expect(updated.url).toBe("https://renamed.example.com/hook");
    expect(updated.events).toEqual(["group.deleted"]);
    expect(updated.disabledAt).toBeInstanceOf(Date);
  });

  it("omits keys whose value is undefined from the PATCH body", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ disabled: false });
      return jsonResponse(wireEndpoint);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.webhooks.endpoints.update("whe_1" as never, { disabled: false });
  });

  it("forwards a sole format change in the PATCH body", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({ format: "discord" });
      return jsonResponse({ ...wireEndpoint, format: "discord" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const updated = await junjo.webhooks.endpoints.update("whe_1" as never, {
      format: "discord",
    });
    expect(updated.format).toBe("discord");
  });

  it("URL-encodes the endpoint id", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks/whe%2Fwith%20slash");
      return jsonResponse(wireEndpoint);
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.webhooks.endpoints.update("whe/with slash" as never, { disabled: true });
  });

  it("propagates JunjoError on a 404", async () => {
    const fetchMock = endpointFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(
      junjo.webhooks.endpoints.update("whe_missing" as never, { disabled: true }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });
});

describe("WebhookEndpointsApi.delete", () => {
  it("DELETEs /v1/webhooks/:id and resolves to undefined on 204", async () => {
    const fetchMock = endpointFetch(async (req) => {
      expect(req.method).toBe("DELETE");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks/whe_1");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const result = await junjo.webhooks.endpoints.delete("whe_1" as never);
    expect(result).toBeUndefined();
  });

  it("URL-encodes the endpoint id", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks/whe%2Fwith%20slash");
      return new Response(null, { status: 204 });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await junjo.webhooks.endpoints.delete("whe/with slash" as never);
  });

  it("propagates JunjoError on a 404", async () => {
    const fetchMock = endpointFetch(async () =>
      jsonResponse({ code: "not_found", status: 404, message: "not found" }, 404),
    );
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(junjo.webhooks.endpoints.delete("whe_missing" as never)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
  });
});
