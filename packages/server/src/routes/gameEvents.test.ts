import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type CreateAppOptions, createApp } from "../app";
import { EventHub } from "../eventHub";
import { readStreamPosition, recordEvents, sweepEventLog, withEventLog } from "../eventLog";
import { mintEvent, stageEvent } from "../events";
import { createApiKey, createGame } from "../seed";
import { waitFor } from "../testHelpers";
import { STREAM_POSITION_HEADER } from "./gameEvents";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

// Reads frames until `until` holds or the deadline passes, then cancels
// the reader so the server observes the abort. Never waits unbounded.
async function readFrames(
  res: Response,
  opts: { timeoutMs: number; until?: (frames: Frame[]) => boolean },
): Promise<{ frames: Frame[]; ended: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  let ended = false;
  const deadline = Date.now() + opts.timeoutMs;
  try {
    while (Date.now() < deadline && !(opts.until?.(frames) ?? false)) {
      const remaining = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (chunk === "timeout") break;
      if (chunk.done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame: Frame = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) frame.comment = line.slice(1);
          else if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data = line.slice(6);
        }
        if (block.length > 0) frames.push(frame);
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { frames, ended };
}

const events = (frames: Frame[]) => frames.filter((f) => f.event !== undefined);

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/events (game stream)", () => {
  let prisma: PrismaClient;
  let hub: EventHub;
  let app: Hono;
  let gameId: string;
  let key: string;
  let keyId: string;

  function makeApp(events: CreateAppOptions["events"] = {}) {
    return createApp({
      prisma,
      rateLimit: null,
      events: { hub, heartbeatIntervalMs: 30_000, pollIntervalMs: 0, ...events },
    });
  }

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "GameBan", "BanHistory", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Stream Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(gameId, prisma);
    key = `Bearer ${seeded.raw.full}`;
    keyId = seeded.apiKey.id;
    hub = new EventHub();
    app = makeApp();
  });

  afterEach(() => hub.clear());

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function api(
    path: string,
    init: { method?: string; body?: unknown; key?: string; app?: Hono } = {},
  ) {
    return (init.app ?? app).request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: init.key ?? key,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  function open(
    query = "",
    headers: Record<string, string> = {},
    target: Hono = app,
    auth: string = key,
  ) {
    return target.request(`/v1/events${query}`, {
      headers: { authorization: auth, ...headers },
    });
  }

  async function ban(userId: string, target: Hono = app) {
    const res = await api("/v1/bans", { method: "POST", body: { userId }, app: target });
    expect(res.status).toBeLessThan(300);
  }

  it("delivers committed game events with consecutive positions on the id line", async () => {
    const res = await open();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get(STREAM_POSITION_HEADER)).toBe("0");
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);

    await ban("u1");
    await ban("u2");
    const unban = await api("/v1/bans/u1", { method: "DELETE" });
    expect(unban.status).toBeLessThan(300);

    const { frames } = await readFrames(res, {
      timeoutMs: 3000,
      until: (f) => events(f).length >= 3,
    });
    const got = events(frames);
    expect(got.map((f) => f.event)).toEqual([
      "game.user.banned",
      "game.user.banned",
      "game.user.unbanned",
    ]);
    expect(got.map((f) => f.id)).toEqual(["1", "2", "3"]);
    const first = JSON.parse(got[0]?.data ?? "{}");
    expect(first).toMatchObject({ type: "game.user.banned", gameId, userId: "u1" });
    expect(typeof first.id).toBe("string");
    expect(first.id).not.toBe("1");
  });

  it("carries group events too (firehose) and honours a type filter", async () => {
    const created = await api("/v1/groups", {
      method: "POST",
      body: { kind: "party", name: "P", visibility: "invite-only" },
    });
    const group = (await created.json()) as { id: string };
    const all = await open();
    const filtered = await open("?types=game.user.banned");
    // No wait: a stream's start position is fixed before its response
    // returns, so later events reach it however late its loop starts.

    await api(`/v1/groups/${group.id}/members`, { method: "POST", body: { userId: "u1" } });
    await ban("u2");

    const [a, f] = await Promise.all([
      readFrames(all, { timeoutMs: 3000, until: (x) => events(x).length >= 2 }),
      readFrames(filtered, { timeoutMs: 3000, until: (x) => events(x).length >= 1 }),
    ]);
    expect(events(a.frames).map((x) => x.event)).toEqual(["member.joined", "game.user.banned"]);
    expect(events(f.frames).map((x) => [x.event, x.id])).toEqual([["game.user.banned", "2"]]);
  });

  it("rejects an unknown type in the filter before opening a stream", async () => {
    const res = await open("?types=game.user.banned,nope.never");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("bad_request");
  });

  it("resumes after Last-Event-ID with exactly the missed events", async () => {
    await ban("u1");
    await ban("u2");
    await ban("u3");
    const res = await open("", { "last-event-id": "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get(STREAM_POSITION_HEADER)).toBe("1");
    const { frames } = await readFrames(res, {
      timeoutMs: 3000,
      until: (f) => events(f).length >= 2,
    });
    expect(events(frames).map((f) => f.id)).toEqual(["2", "3"]);
  });

  it("answers 410 for positions it cannot serve and 400 for malformed ones", async () => {
    await ban("u1");
    await ban("u2");
    const ahead = await open("", { "last-event-id": "9" });
    expect(ahead.status).toBe(410);
    expect(((await ahead.json()) as { code: string }).code).toBe("stream_position_expired");

    await prisma.eventLog.deleteMany({ where: { gameId, seq: 1n } });
    const swept = await open("", { "last-event-id": "0" });
    expect(swept.status).toBe(410);
    const stillFine = await open("", { "last-event-id": "1" });
    expect(stillFine.status).toBe(200);
    await readFrames(stillFine, { timeoutMs: 1000, until: (f) => events(f).length >= 1 });

    const malformed = await open("", { "last-event-id": "abc" });
    expect(malformed.status).toBe(400);
  });

  it("stops at a hole in the log instead of skipping over it", async () => {
    await ban("u1");
    await ban("u2");
    await ban("u3");
    await prisma.eventLog.deleteMany({ where: { gameId, seq: 2n } });
    const res = await open("", { "last-event-id": "0" });
    expect(res.status).toBe(200);
    const { frames, ended } = await readFrames(res, { timeoutMs: 3000 });
    expect(events(frames).map((f) => f.id)).toEqual(["1"]);
    expect(ended).toBe(true);
    const resumed = await open("", { "last-event-id": "1" });
    expect(resumed.status).toBe(410);
  });

  it("never logs or delivers an event whose transaction rolled back", async () => {
    const res = await open();
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);
    const logged = withEventLog(prisma);
    await expect(
      logged.$transaction(async (tx) => {
        const event = mintEvent({
          type: "game.user.unbanned",
          gameId,
          junjoUserId: "x",
          userId: "x",
        } as never);
        await recordEvents(tx, [event as never]);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await readStreamPosition(prisma, gameId)).toBe(0n);
    await ban("u1");
    const { frames } = await readFrames(res, {
      timeoutMs: 3000,
      until: (f) => events(f).length >= 1,
    });
    expect(events(frames).map((f) => [f.event, f.id])).toEqual([["game.user.banned", "1"]]);
    expect(await prisma.eventLog.count({ where: { gameId } })).toBe(1);
  });

  it("shows no event to any stream until its transaction commits", async () => {
    const polling = makeApp({ pollIntervalMs: 20 });
    const during = await open("", {}, polling);
    const after = await open("", {}, polling);
    const logged = withEventLog(prisma);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let staged: ReturnType<typeof mintEvent> | null = null;
    const tx = logged.$transaction(async (t) => {
      staged = await stageEvent(t, {
        type: "game.user.unbanned",
        gameId,
        junjoUserId: "x",
        userId: "x",
      } as never);
      await gate;
    });
    // Polling and a reader on another connection both see nothing yet.
    const early = await readFrames(during, { timeoutMs: 300 });
    expect(events(early.frames)).toEqual([]);
    expect(await prisma.eventLog.count({ where: { gameId } })).toBe(0);
    release();
    await tx;
    if (staged) hub.publish(staged);
    const late = await readFrames(after, {
      timeoutMs: 3000,
      until: (f) => events(f).length >= 1,
    });
    expect(events(late.frames).map((f) => [f.event, f.id])).toEqual([["game.user.unbanned", "1"]]);
  });

  it("keeps positions gapless and unique under concurrent writes", async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => ban(`c${i}`)));
    const rows = await prisma.eventLog.findMany({ where: { gameId }, orderBy: { seq: "asc" } });
    expect(rows.map((r) => Number(r.seq))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await readStreamPosition(prisma, gameId)).toBe(12n);
  });

  it("sends heartbeats carrying the position past filtered-out events", async () => {
    const fast = makeApp({ heartbeatIntervalMs: 40 });
    const res = await open("?types=identity.linked", {}, fast);
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);
    await ban("u1");
    const { frames } = await readFrames(res, {
      timeoutMs: 3000,
      until: (f) => f.some((x) => x.comment === "heartbeat" && x.id === "1"),
    });
    expect(events(frames)).toEqual([]);
    expect(frames.some((x) => x.comment === "heartbeat" && x.id === "1")).toBe(true);
  });

  it("closes the stream after its key is revoked", async () => {
    const fast = makeApp({ heartbeatIntervalMs: 30 });
    const res = await open("", {}, fast);
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);
    await prisma.apiKey.update({ where: { id: keyId }, data: { revokedAt: new Date() } });
    const { ended } = await readFrames(res, { timeoutMs: 3000 });
    expect(ended).toBe(true);
    await waitFor(() => hub.gameSubscriberCount(gameId) === 0);
  });

  it("renders user ids with the opening key's namespace preference", async () => {
    const web = await createApiKey(gameId, prisma);
    await prisma.apiKey.update({
      where: { id: web.apiKey.id },
      data: { preferredNamespaces: ["web"] },
    });
    const issued = await api("/v1/users/mc:1/link-codes", { method: "POST" });
    const { code } = (await issued.json()) as { code: string };
    const redeemed = await api("/v1/link-codes/redeem", {
      method: "POST",
      body: { code, userId: "web:1" },
    });
    expect(redeemed.status).toBe(200);

    const plain = await open();
    const webStream = await open("", {}, app, `Bearer ${web.raw.full}`);
    // No wait: a stream's start position is fixed before its response
    // returns, so later events reach it however late its loop starts.
    await ban("mc:1");
    const [p, w] = await Promise.all([
      readFrames(plain, { timeoutMs: 3000, until: (f) => events(f).length >= 1 }),
      readFrames(webStream, { timeoutMs: 3000, until: (f) => events(f).length >= 1 }),
    ]);
    expect(JSON.parse(events(p.frames)[0]?.data ?? "{}").userId).toBe("mc:1");
    expect(JSON.parse(events(w.frames)[0]?.data ?? "{}").userId).toBe("web:1");
  });

  it("limits open streams per key and frees the slot on disconnect", async () => {
    const limited = makeApp({ maxStreamsPerKey: 1 });
    const first = await open("", {}, limited);
    expect(first.status).toBe(200);
    const second = await open("", {}, limited);
    expect(second.status).toBe(429);
    expect(((await second.json()) as { code: string }).code).toBe("too_many_streams");
    await first.body?.cancel();
    await waitFor(() => hub.gameSubscriberCount(gameId) === 0);
    const third = await open("", {}, limited);
    expect(third.status).toBe(200);
    await third.body?.cancel();
  });

  it("closes a stream whose client stops reading and frees its slot", async () => {
    const limited = makeApp({ maxStreamsPerKey: 1, writeTimeoutMs: 150 });
    const stalled = await open("", {}, limited);
    expect(stalled.status).toBe(200);
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);
    // Never read `stalled`: its frames back up until a write times out.
    for (let i = 0; i < 20; i++) await ban(`s${i}`);
    await waitFor(() => hub.gameSubscriberCount(gameId) === 0, 5000);
    const next = await open("", {}, limited);
    expect(next.status).toBe(200);
    await next.body?.cancel();
    await stalled.body?.cancel().catch(() => undefined);
  });

  it("does not deadlock writers that stage events mid-transaction in one group", async () => {
    const created = await api("/v1/groups", {
      method: "POST",
      body: { kind: "guild", name: "G", visibility: "invite-only" },
    });
    const group = (await created.json()) as { id: string };
    const role = await api(`/v1/groups/${group.id}/roles`, {
      method: "POST",
      body: { name: "vip", priority: 10 },
    });
    expect(role.status).toBe(201);
    const { id: roleId } = (await role.json()) as { id: string };
    const users = Array.from({ length: 8 }, (_, i) => `d${i}`);
    for (const u of users) {
      await api(`/v1/groups/${group.id}/members`, { method: "POST", body: { userId: u } });
    }
    const before = await readStreamPosition(prisma, gameId);
    const results = await Promise.all(
      users.flatMap((u) => [
        api(`/v1/groups/${group.id}/members/${u}/roles/${roleId}`, { method: "POST" }),
        api(`/v1/groups/${group.id}/members/${u}/permissions/fly`, {
          method: "POST",
          body: { grant: true },
        }),
        api(`/v1/groups/${group.id}/members/${u}`, {
          method: "PATCH",
          body: { metadata: { n: u } },
        }),
      ]),
    );
    expect(results.map((r) => r.status).filter((s) => s >= 300)).toEqual([]);
    const after = await readStreamPosition(prisma, gameId);
    expect(after - before).toBe(24n);
    const rows = await prisma.eventLog.findMany({
      where: { gameId, seq: { gt: before } },
      orderBy: { seq: "asc" },
    });
    expect(rows.map((r) => r.seq)).toEqual(
      Array.from({ length: 24 }, (_, i) => before + BigInt(i + 1)),
    );
  });

  it("delivers events written through another process by polling the log", async () => {
    const otherHub = new EventHub();
    const writer = createApp({ prisma, rateLimit: null, events: { hub: otherHub } });
    const reader = makeApp({ pollIntervalMs: 25 });
    const res = await open("", {}, reader);
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);
    await ban("u1", writer);
    const { frames } = await readFrames(res, {
      timeoutMs: 3000,
      until: (f) => events(f).length >= 1,
    });
    expect(events(frames).map((f) => [f.event, f.id])).toEqual([["game.user.banned", "1"]]);
  });

  it("exposes the position on its own endpoint and on snapshot reads", async () => {
    await ban("u1");
    const pos = await api("/v1/events/position");
    expect(pos.status).toBe(200);
    expect(await pos.json()).toEqual({ position: "1" });
    expect(pos.headers.get(STREAM_POSITION_HEADER)).toBe("1");
    const bans = await api("/v1/bans");
    expect(bans.headers.get(STREAM_POSITION_HEADER)).toBe("1");
  });

  it("emits member.updated on group and game streams for metadata and overrides", async () => {
    const created = await api("/v1/groups", {
      method: "POST",
      body: { kind: "guild", name: "G", visibility: "invite-only" },
    });
    const group = (await created.json()) as { id: string };
    await api(`/v1/groups/${group.id}/members`, { method: "POST", body: { userId: "u1" } });
    const groupStream = await app.request(`/v1/events/${group.id}`, {
      headers: { authorization: key },
    });
    const gameStream = await open();
    await waitFor(() => hub.subscriberCount(group.id as never) > 0);
    await waitFor(() => hub.gameSubscriberCount(gameId) > 0);

    const patched = await api(`/v1/groups/${group.id}/members/u1`, {
      method: "PATCH",
      body: { metadata: { prefix: "[VIP]" } },
    });
    expect(patched.status).toBe(200);
    const granted = await api(`/v1/groups/${group.id}/members/u1/permissions/fly`, {
      method: "POST",
      body: { grant: true },
    });
    expect(granted.status).toBeLessThan(300);

    const [g, s] = await Promise.all([
      readFrames(groupStream, { timeoutMs: 3000, until: (f) => events(f).length >= 2 }),
      readFrames(gameStream, { timeoutMs: 3000, until: (f) => events(f).length >= 2 }),
    ]);
    for (const frames of [g.frames, s.frames]) {
      const payloads = events(frames).map((f) => JSON.parse(f.data ?? "{}"));
      expect(payloads.map((p) => [p.type, p.userId, p.changed])).toEqual([
        ["member.updated", "u1", ["metadata"]],
        ["member.updated", "u1", ["overrides"]],
      ]);
    }
  });

  it("sweeps log rows older than the retention window", async () => {
    await ban("u1");
    await ban("u2");
    await prisma.$executeRaw`UPDATE "EventLog" SET "createdAt" = "createdAt" - interval '30 hours' WHERE "seq" = 1`;
    expect(await sweepEventLog(prisma, { retentionHours: 24 })).toBe(1);
    const left = await prisma.eventLog.findMany({ where: { gameId } });
    expect(left.map((r) => Number(r.seq))).toEqual([2]);
    expect(await readStreamPosition(prisma, gameId)).toBe(2n);
  });
});
