import type { GameId, GroupId, MemberId, MemberJoinedEvent, UserId } from "@junjo-io/shared";
import { type Prisma, PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface ParsedSSEEvent {
  id?: string;
  event?: string;
  data?: string;
}

// Read from the SSE response body for `timeoutMs` ms, splitting on the
// double-newline event terminator. Returns every fully-formed event +
// every comment line (e.g. ":heartbeat") seen during the window. The
// reader is cancelled at the end so the server-side stream callback
// observes onAbort and unsubscribes.
async function readSSE(
  res: Response,
  timeoutMs: number,
): Promise<{ events: ParsedSSEEvent[]; comments: string[]; raw: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  let buffer = "";
  const events: ParsedSSEEvent[] = [];
  const comments: string[] = [];

  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), remaining),
        ),
      ]);
      if (chunk.done) break;
      if (chunk.value) buffer += decoder.decode(chunk.value, { stream: true });

      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.startsWith(":")) {
          comments.push(block);
        } else if (block.length > 0) {
          const parsed: ParsedSSEEvent = {};
          for (const line of block.split("\n")) {
            if (line.startsWith("id: ")) parsed.id = line.slice(4);
            else if (line.startsWith("event: ")) parsed.event = line.slice(7);
            else if (line.startsWith("data: "))
              parsed.data =
                parsed.data === undefined ? line.slice(6) : `${parsed.data}\n${line.slice(6)}`;
          }
          events.push(parsed);
        }
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return { events, comments, raw: buffer };
}

async function waitForSubscriber(hub: EventHub, groupId: GroupId, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.subscriberCount(groupId) > 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`subscriber for ${groupId} never registered within ${timeoutMs}ms`);
}

async function waitForUnsubscribe(
  hub: EventHub,
  groupId: GroupId,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.subscriberCount(groupId) === 0) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`subscriber for ${groupId} never released within ${timeoutMs}ms`);
}

function memberJoinedEvent(groupId: string, gameId: string, id = "evt_1"): MemberJoinedEvent {
  return {
    id,
    type: "member.joined",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    occurredAt: new Date("2026-04-28T00:00:00.000Z"),
    userId: "user_alice" as UserId,
    member: {
      id: "mem_1" as MemberId,
      groupId: groupId as GroupId,
      userId: "user_alice" as UserId,
      status: "active",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
      joinedAt: new Date("2026-04-28T00:00:00.000Z"),
      bannedUntil: null,
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/events/:groupId", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;
  let hub: EventHub;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
    hub = new EventHub();
    app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
  });

  afterEach(() => {
    hub.clear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createGroup(name = "Crimson Wolves") {
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

  function openStream(groupId: string, header = authHeader) {
    return app.request(`/v1/events/${encodeURIComponent(groupId)}`, {
      method: "GET",
      headers: { authorization: header, accept: "text/event-stream" },
    });
  }

  it("opens an SSE stream and delivers a published event", async () => {
    const group = await createGroup();
    const res = await openStream(group.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");

    await waitForSubscriber(hub, group.id as GroupId);
    const event = memberJoinedEvent(group.id, gameId);
    hub.publish(event);

    const { events } = await readSSE(res, 250);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const [first] = events;
    expect(first?.id).toBe("evt_1");
    expect(first?.event).toBe("member.joined");
    const decoded = JSON.parse(first?.data ?? "{}");
    expect(decoded).toMatchObject({
      id: "evt_1",
      type: "member.joined",
      gameId,
      groupId: group.id,
      userId: "user_alice",
    });
    expect(decoded.occurredAt).toBe("2026-04-28T00:00:00.000Z");
  });

  it("delivers multiple events in order", async () => {
    const group = await createGroup();
    const res = await openStream(group.id);
    await waitForSubscriber(hub, group.id as GroupId);

    hub.publish(memberJoinedEvent(group.id, gameId, "evt_a"));
    hub.publish(memberJoinedEvent(group.id, gameId, "evt_b"));
    hub.publish(memberJoinedEvent(group.id, gameId, "evt_c"));

    const { events } = await readSSE(res, 250);
    expect(events.map((e) => e.id)).toEqual(["evt_a", "evt_b", "evt_c"]);
  });

  it("does not deliver events for other groups on the same stream", async () => {
    const subscribed = await createGroup("Subscribed");
    const other = await createGroup("Other");
    const res = await openStream(subscribed.id);
    await waitForSubscriber(hub, subscribed.id as GroupId);

    hub.publish(memberJoinedEvent(other.id, gameId, "evt_other"));
    hub.publish(memberJoinedEvent(subscribed.id, gameId, "evt_mine"));

    const { events } = await readSSE(res, 250);
    expect(events.map((e) => e.id)).toEqual(["evt_mine"]);
  });

  it("emits a heartbeat comment at the configured interval", async () => {
    const fastApp = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30 } });
    const group = await createGroup();
    const res = await fastApp.request(`/v1/events/${group.id}`, {
      headers: { authorization: authHeader },
    });
    await waitForSubscriber(hub, group.id as GroupId);
    const { comments } = await readSSE(res, 200);
    expect(comments.length).toBeGreaterThanOrEqual(1);
    expect(comments[0]).toBe(":heartbeat");
  });

  it("releases the subscription when the client disconnects", async () => {
    const group = await createGroup();
    const res = await openStream(group.id);
    await waitForSubscriber(hub, group.id as GroupId);
    expect(hub.subscriberCount(group.id as GroupId)).toBe(1);
    await res.body?.cancel();
    await waitForUnsubscribe(hub, group.id as GroupId);
    expect(hub.subscriberCount(group.id as GroupId)).toBe(0);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await openStream("grp_does_not_exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await prisma.group.create({
      data: {
        gameId: otherGame.id,
        kind: "guild",
        name: "Outsider",
        visibility: "invite-only",
        metadata: {} as Prisma.InputJsonValue,
      },
    });
    const res = await openStream(otherGroup.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await createGroup();
    await prisma.group.update({
      where: { id: group.id },
      data: { softDeletedAt: new Date() },
    });
    const res = await openStream(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await createGroup();
    const res = await app.request(`/v1/events/${group.id}`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
