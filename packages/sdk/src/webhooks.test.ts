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
