import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";
import {
  WEBHOOK_SIGNATURE_SCHEME,
  signWebhookBody,
  verifyWebhook,
  verifyWebhookWithMeta,
} from "./webhooks.js";

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
    hasPasscode: false,
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

  it("throws webhook_timestamp_invalid on a malformed but correctly signed timestamp", async () => {
    // The timestamp is only parsed after the MAC passes, so reaching
    // webhook_timestamp_invalid requires signing over the bad value.
    const { body } = await buildSignedDelivery(sampleEvent, SECRET);
    const sig = await signWebhookBody(SECRET, body, "not-a-date");
    const headers = { "x-junjo-signature": sig, "x-junjo-timestamp": "not-a-date" };
    await expect(verifyWebhook(body, headers, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_timestamp_invalid",
      status: 400,
    });
  });

  it("reports invalid_signature (not a timestamp error) when an unsigned timestamp is tampered", async () => {
    // Ordering guarantee: unauthenticated senders learn nothing about
    // the receiver's clock or tolerance settings.
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const tampered = { ...headers, "x-junjo-timestamp": "not-a-date" };
    await expect(verifyWebhook(body, tampered, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_invalid_signature",
      status: 400,
    });
  });

  it("reports invalid_signature before out-of-tolerance when both are wrong", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const tampered = { ...headers, "x-junjo-signature": "v1=deadbeef" };
    const sixMinAfter = () => new Date("2026-04-28T05:06:31.000Z");
    await expect(verifyWebhook(body, tampered, SECRET, { now: sixMinAfter })).rejects.toMatchObject(
      { code: "webhook_invalid_signature", status: 400 },
    );
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

  it("throws webhook_invalid_signature on a wrong scheme prefix with a correct MAC", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const v1Signature = headers["x-junjo-signature"] as string;
    const tampered = { ...headers, "x-junjo-signature": v1Signature.replace(/^v1=/, "v2=") };
    await expect(verifyWebhook(body, tampered, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "webhook_invalid_signature",
      status: 400,
    });
  });

  it("rejects an array signature header whose first element is invalid (only [0] is read)", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const valid = headers["x-junjo-signature"] as string;
    const arrayHeaders: Record<string, string[] | string | undefined> = {
      "x-junjo-signature": ["v1=deadbeef", valid],
      "x-junjo-timestamp": headers["x-junjo-timestamp"],
    };
    await expect(
      verifyWebhook(body, arrayHeaders, SECRET, { now: FROZEN_NOW }),
    ).rejects.toMatchObject({ code: "webhook_invalid_signature", status: 400 });
  });

  it("rejects an array signature header containing only invalid values", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const arrayHeaders: Record<string, string[] | string | undefined> = {
      "x-junjo-signature": ["v1=deadbeef", "v1=garbage"],
      "x-junjo-timestamp": headers["x-junjo-timestamp"],
    };
    await expect(
      verifyWebhook(body, arrayHeaders, SECRET, { now: FROZEN_NOW }),
    ).rejects.toMatchObject({ code: "webhook_invalid_signature", status: 400 });
  });

  it("throws unknown_event_type with status 400 on a correctly signed future event type", async () => {
    const futureEvent = {
      id: "evt_future",
      type: "member.promoted",
      gameId: "game_1",
      groupId: "grp_1",
      occurredAt: "2026-04-28T05:00:00.000Z",
    };
    const { body, headers } = await buildSignedDelivery(futureEvent, SECRET);
    await expect(verifyWebhook(body, headers, SECRET, { now: FROZEN_NOW })).rejects.toMatchObject({
      code: "unknown_event_type",
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

describe("verifyWebhookWithMeta", () => {
  it("returns the parsed event plus eventId and deliveryId from the headers", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const result = await verifyWebhookWithMeta(body, headers, SECRET, { now: FROZEN_NOW });
    expect(result.event.type).toBe("group.updated");
    expect(result.event.id).toBe("evt_1");
    expect(result.eventId).toBe("evt_1");
    expect(result.deliveryId).toBe("del_1");
  });

  it("reads the id headers case-insensitively", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const mixed: Record<string, string> = {
      "x-junjo-signature": headers["x-junjo-signature"] as string,
      "x-junjo-timestamp": headers["x-junjo-timestamp"] as string,
      "X-Junjo-Event-Id": "evt_1",
      "X-Junjo-Delivery-Id": "del_1",
    };
    const result = await verifyWebhookWithMeta(body, mixed, SECRET, { now: FROZEN_NOW });
    expect(result.eventId).toBe("evt_1");
    expect(result.deliveryId).toBe("del_1");
  });

  it("leaves eventId/deliveryId undefined when an intermediary stripped the headers", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const {
      "x-junjo-event-id": _omitEvent,
      "x-junjo-delivery-id": _omitDelivery,
      ...stripped
    } = headers;
    const result = await verifyWebhookWithMeta(body, stripped, SECRET, { now: FROZEN_NOW });
    expect(result.event.type).toBe("group.updated");
    expect(result.eventId).toBeUndefined();
    expect(result.deliveryId).toBeUndefined();
  });

  it("rejects with the same verification errors as verifyWebhook", async () => {
    const { headers } = await buildSignedDelivery(sampleEvent, SECRET);
    await expect(
      verifyWebhookWithMeta('{"tampered": true}', headers, SECRET, { now: FROZEN_NOW }),
    ).rejects.toMatchObject({ code: "webhook_invalid_signature", status: 400 });
  });

  it("is exposed as junjo.webhooks.verifyWithMeta", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const result = await junjo.webhooks.verifyWithMeta(body, headers, SECRET, { now: FROZEN_NOW });
    expect(result.eventId).toBe("evt_1");
    expect(result.deliveryId).toBe("del_1");
  });

  it("throws unknown_event_type on a future type by default", async () => {
    const futureEvent = {
      id: "evt_future",
      type: "member.promoted",
      gameId: "game_1",
      groupId: "grp_1",
      occurredAt: "2026-04-28T05:00:00.000Z",
    };
    const { body, headers } = await buildSignedDelivery(futureEvent, SECRET);
    await expect(
      verifyWebhookWithMeta(body, headers, SECRET, { now: FROZEN_NOW }),
    ).rejects.toMatchObject({ code: "unknown_event_type", status: 400 });
  });

  it("returns the raw payload for a future type under onUnknownType: 'raw'", async () => {
    const futureEvent = {
      id: "evt_future",
      type: "member.promoted",
      gameId: "game_1",
      groupId: "grp_1",
      occurredAt: "2026-04-28T05:00:00.000Z",
    };
    const { body, headers } = await buildSignedDelivery(futureEvent, SECRET);
    const result = await verifyWebhookWithMeta(body, headers, SECRET, {
      now: FROZEN_NOW,
      onUnknownType: "raw",
    });
    expect(result.event).toBeNull();
    if (result.event === null) {
      expect(result.eventType).toBe("member.promoted");
      expect(result.payload).toEqual(futureEvent);
    }
    expect(result.eventId).toBe("evt_1");
    expect(result.deliveryId).toBe("del_1");
  });

  it("still returns the typed event for known types under onUnknownType: 'raw'", async () => {
    const { body, headers } = await buildSignedDelivery(sampleEvent, SECRET);
    const result = await verifyWebhookWithMeta(body, headers, SECRET, {
      now: FROZEN_NOW,
      onUnknownType: "raw",
    });
    expect(result.event).not.toBeNull();
    if (result.event !== null) {
      expect(result.event.type).toBe("group.updated");
    }
  });

  it("leaves eventType undefined under 'raw' when the payload has no string type", async () => {
    const typeless = { id: "evt_x", gameId: "game_1", occurredAt: "2026-04-28T05:00:00.000Z" };
    const { body, headers } = await buildSignedDelivery(typeless, SECRET);
    const result = await verifyWebhookWithMeta(body, headers, SECRET, {
      now: FROZEN_NOW,
      onUnknownType: "raw",
    });
    expect(result.event).toBeNull();
    if (result.event === null) {
      expect(result.eventType).toBeUndefined();
      expect(result.payload).toEqual(typeless);
    }
  });

  it("does not swallow verification failures under onUnknownType: 'raw'", async () => {
    const { headers } = await buildSignedDelivery(sampleEvent, SECRET);
    await expect(
      verifyWebhookWithMeta('{"tampered": true}', headers, SECRET, {
        now: FROZEN_NOW,
        onUnknownType: "raw",
      }),
    ).rejects.toMatchObject({ code: "webhook_invalid_signature", status: 400 });
  });

  it("still rejects malformed known-type payloads under 'raw' (only unknown types are exempt)", async () => {
    const malformed = {
      id: "evt_bad",
      type: "group.updated",
      gameId: "game_1",
      groupId: "grp_1",
      occurredAt: "not-a-date",
      group: sampleEvent.group,
    };
    const { body, headers } = await buildSignedDelivery(malformed, SECRET);
    await expect(
      verifyWebhookWithMeta(body, headers, SECRET, { now: FROZEN_NOW, onUnknownType: "raw" }),
    ).rejects.toBeInstanceOf(JunjoError);
  });

  it("supports onUnknownType via junjo.webhooks.verifyWithMeta", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const futureEvent = {
      id: "evt_future",
      type: "member.promoted",
      gameId: "game_1",
      groupId: "grp_1",
      occurredAt: "2026-04-28T05:00:00.000Z",
    };
    const { body, headers } = await buildSignedDelivery(futureEvent, SECRET);
    const result = await junjo.webhooks.verifyWithMeta(body, headers, SECRET, {
      now: FROZEN_NOW,
      onUnknownType: "raw",
    });
    expect(result.event).toBeNull();
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
    expect(res.body).toMatch(/webhook_invalid_signature/);
    // The raw error message (and anything it embeds) must not reach the
    // sender; only the generic text plus the stable code does.
    expect(res.body).not.toMatch(/does not match/);
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

  it("responds 400 with the out-of-tolerance code (not the window value) on replay", async () => {
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
    expect(res.body).toMatch(/webhook_timestamp_out_of_tolerance/);
    // The configured tolerance must not be reflected to the sender.
    expect(res.body).not.toMatch(/\d+ms/);
  });

  it("responds 400 with the unknown_event_type code on a future event type", async () => {
    const junjo = new Junjo({ apiKey: "x", fetch: vi.fn() as unknown as typeof fetch });
    const futureEvent = {
      id: "evt_future",
      type: "member.promoted",
      gameId: "game_1",
      groupId: "grp_1",
      occurredAt: "2026-04-28T05:00:00.000Z",
    };
    const { body, headers } = await buildSignedDelivery(futureEvent, SECRET);
    const mw = junjo.webhooks.middleware(SECRET, { now: FROZEN_NOW });

    const req = { headers, body: new TextEncoder().encode(body), rawBody: undefined };
    const res = fakeRes();
    const next = vi.fn();

    await mw(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/unknown_event_type/);
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

  it("forwards the format field when set to slack", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      expect(body).toEqual({
        url: "https://hooks.slack.com/services/T0/B0/abc",
        format: "slack",
      });
      return jsonResponse({ ...wireEndpointWithSecret, format: "slack" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const created = await junjo.webhooks.endpoints.create({
      url: "https://hooks.slack.com/services/T0/B0/abc",
      format: "slack",
    });
    expect(created.format).toBe("slack");
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
  it("GETs /v1/webhooks with no query and returns a Page of deserialized endpoints (no secret on the wire)", async () => {
    const fetchMock = endpointFetch(async (req) => {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks");
      expect(url.search).toBe("");
      expect(req.headers.get("authorization")).toBe("Bearer test_key");
      return jsonResponse({ items: [wireEndpoint], nextCursor: null });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.webhooks.endpoints.list();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.id).toBe("whe_1");
    expect((page.items[0] as unknown as Record<string, unknown>).secret).toBeUndefined();
    expect(page.items[0]?.createdAt).toBeInstanceOf(Date);
    expect(page.nextCursor).toBeNull();
  });

  it("forwards limit and cursor as query parameters and passes nextCursor through", async () => {
    const fetchMock = endpointFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks");
      expect(url.searchParams.get("limit")).toBe("2");
      expect(url.searchParams.get("cursor")).toBe("whe_0");
      return jsonResponse({ items: [wireEndpoint], nextCursor: "whe_1" });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.webhooks.endpoints.list({ limit: 2, cursor: "whe_0" });
    expect(page.nextCursor).toBe("whe_1");
  });

  it("returns an empty page when the server returns no items", async () => {
    const fetchMock = endpointFetch(async () => jsonResponse({ items: [], nextCursor: null }));
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    const page = await junjo.webhooks.endpoints.list();
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
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

describe("WebhookEndpointsApi.listAll", () => {
  it("walks every page, feeding nextCursor back as cursor", async () => {
    const seenCursors: Array<string | null> = [];
    const fetchMock = endpointFetch(async (req) => {
      const url = new URL(req.url);
      expect(url.pathname).toBe("/v1/webhooks");
      expect(url.searchParams.get("limit")).toBe("2");
      seenCursors.push(url.searchParams.get("cursor"));
      if (seenCursors.length === 1) {
        return jsonResponse({
          items: [wireEndpoint, { ...wireEndpoint, id: "whe_2" }],
          nextCursor: "whe_2",
        });
      }
      return jsonResponse({
        items: [{ ...wireEndpoint, id: "whe_3" }],
        nextCursor: null,
      });
    });
    const junjo = new Junjo({
      apiKey: "test_key",
      baseUrl: "https://example.test",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const ids: string[] = [];
    for await (const endpoint of junjo.webhooks.endpoints.listAll({ limit: 2 })) {
      ids.push(endpoint.id);
      expect(endpoint.createdAt).toBeInstanceOf(Date);
    }

    expect(ids).toEqual(["whe_1", "whe_2", "whe_3"]);
    expect(seenCursors).toEqual([null, "whe_2"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
