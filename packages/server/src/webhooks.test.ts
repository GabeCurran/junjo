import type {
  GameId,
  GroupId,
  GroupUpdatedEvent,
  MemberJoinedEvent,
  RoleId,
  UserId,
} from "@junjo/shared";
import { type Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newEventId } from "./events.js";
import { createApiKey, createGame } from "./seed.js";
import { enqueueWebhookDeliveries, serializeEventForStorage } from "./webhooks.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

function makeGroupUpdatedEvent(
  gameId: string,
  groupId: string,
  occurredAt = new Date("2026-04-28T12:00:00.000Z"),
): GroupUpdatedEvent {
  return {
    id: newEventId(),
    type: "group.updated",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    occurredAt,
    group: {
      id: groupId as GroupId,
      gameId: gameId as GameId,
      kind: "guild",
      name: "Crimson Wolves",
      visibility: "invite-only",
      metadata: {},
      defaultRoleId: null,
      parentGroupId: null,
      memberCount: 3,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: occurredAt,
      softDeletedAt: null,
    },
  };
}

function makeMemberJoinedEvent(gameId: string, groupId: string): MemberJoinedEvent {
  return {
    id: newEventId(),
    type: "member.joined",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    occurredAt: new Date("2026-04-28T12:00:00.000Z"),
    userId: "user_alice" as UserId,
    member: {
      id: "mem_1" as never,
      groupId: groupId as GroupId,
      userId: "user_alice" as UserId,
      status: "active",
      roles: ["role_1" as RoleId],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
      joinedAt: new Date("2026-04-28T12:00:00.000Z"),
      bannedUntil: null,
    },
  };
}

describe("serializeEventForStorage", () => {
  it("turns Date fields into ISO 8601 strings", () => {
    const event = makeGroupUpdatedEvent("game_1", "grp_1");
    const stored = serializeEventForStorage(event) as Record<string, unknown>;

    expect(stored.occurredAt).toBe("2026-04-28T12:00:00.000Z");
    const group = stored.group as Record<string, unknown>;
    expect(group.createdAt).toBe("2026-04-01T00:00:00.000Z");
    expect(group.updatedAt).toBe("2026-04-28T12:00:00.000Z");
    expect(group.softDeletedAt).toBeNull();
  });

  it("preserves the event id and type verbatim", () => {
    const event = makeGroupUpdatedEvent("game_1", "grp_1");
    const stored = serializeEventForStorage(event) as Record<string, unknown>;

    expect(stored.id).toBe(event.id);
    expect(stored.type).toBe("group.updated");
    expect(stored.gameId).toBe("game_1");
    expect(stored.groupId).toBe("grp_1");
  });

  it("preserves nested arrays and primitives without alteration", () => {
    const event = makeMemberJoinedEvent("game_1", "grp_1");
    const stored = serializeEventForStorage(event) as Record<string, unknown>;

    const member = stored.member as Record<string, unknown>;
    expect(member.roles).toEqual(["role_1"]);
    expect(member.status).toBe("active");
    expect(member.metadata).toEqual({});
  });
});

describe.skipIf(!TEST_DATABASE_URL)("enqueueWebhookDeliveries", () => {
  let prisma: PrismaClient;
  let gameId: string;
  let otherGameId: string;
  let groupId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    await createApiKey(game.id, prisma);
    const other = await createGame("Other Game", prisma);
    otherGameId = other.id;
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {} as Prisma.InputJsonValue,
      },
    });
    groupId = group.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeEndpoint(
    overrides: Partial<{ url: string; events: string[]; disabledAt: Date | null; gameId: string }>,
  ) {
    return prisma.webhookEndpoint.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        url: overrides.url ?? "https://example.com/hook",
        secret: "deadbeef",
        events: overrides.events ?? [],
        disabledAt: overrides.disabledAt ?? null,
      },
    });
  }

  it("returns an empty array when no endpoints are configured for the game", async () => {
    const event = makeGroupUpdatedEvent(gameId, groupId);
    const ids = await enqueueWebhookDeliveries(prisma, event);
    expect(ids).toEqual([]);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("creates one pending delivery per matching endpoint", async () => {
    const a = await makeEndpoint({ url: "https://a.example/hook" });
    const b = await makeEndpoint({ url: "https://b.example/hook" });
    const event = makeGroupUpdatedEvent(gameId, groupId);

    const ids = await enqueueWebhookDeliveries(prisma, event);

    expect(ids).toHaveLength(2);
    const deliveries = await prisma.webhookDelivery.findMany({
      orderBy: { webhookEndpointId: "asc" },
    });
    expect(deliveries).toHaveLength(2);
    const endpointIds = new Set(deliveries.map((d) => d.webhookEndpointId));
    expect(endpointIds).toEqual(new Set([a.id, b.id]));
    for (const d of deliveries) {
      expect(d.status).toBe("pending");
      expect(d.attemptCount).toBe(0);
      expect(d.eventId).toBe(event.id);
      expect(d.responseStatus).toBeNull();
      expect(d.lastAttemptAt).toBeNull();
      expect(d.nextAttemptAt).toBeInstanceOf(Date);
    }
  });

  it("stores the event payload with Date fields rendered as ISO 8601", async () => {
    await makeEndpoint({});
    const event = makeGroupUpdatedEvent(gameId, groupId);

    await enqueueWebhookDeliveries(prisma, event);

    const delivery = await prisma.webhookDelivery.findFirst();
    expect(delivery).not.toBeNull();
    const payload = delivery?.payload as Record<string, unknown>;
    expect(payload.id).toBe(event.id);
    expect(payload.type).toBe("group.updated");
    expect(payload.occurredAt).toBe("2026-04-28T12:00:00.000Z");
    const group = payload.group as Record<string, unknown>;
    expect(group.id).toBe(groupId);
    expect(group.createdAt).toBe("2026-04-01T00:00:00.000Z");
  });

  it("skips disabled endpoints", async () => {
    await makeEndpoint({ url: "https://live.example/hook" });
    await makeEndpoint({ url: "https://off.example/hook", disabledAt: new Date() });
    const event = makeGroupUpdatedEvent(gameId, groupId);

    const ids = await enqueueWebhookDeliveries(prisma, event);

    expect(ids).toHaveLength(1);
    const deliveries = await prisma.webhookDelivery.findMany({
      include: { endpoint: true },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.endpoint.url).toBe("https://live.example/hook");
  });

  it("matches when the endpoint's events filter contains the event type", async () => {
    await makeEndpoint({ events: ["group.updated", "member.joined"] });
    const event = makeGroupUpdatedEvent(gameId, groupId);

    const ids = await enqueueWebhookDeliveries(prisma, event);

    expect(ids).toHaveLength(1);
  });

  it("skips endpoints whose events filter excludes the event type", async () => {
    await makeEndpoint({ events: ["member.joined", "member.left"] });
    const event = makeGroupUpdatedEvent(gameId, groupId);

    const ids = await enqueueWebhookDeliveries(prisma, event);

    expect(ids).toEqual([]);
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it("treats an empty events filter as match-all", async () => {
    await makeEndpoint({ events: [] });
    const event = makeMemberJoinedEvent(gameId, groupId);

    const ids = await enqueueWebhookDeliveries(prisma, event);

    expect(ids).toHaveLength(1);
  });

  it("scopes endpoints to the event's game (no cross-game leakage)", async () => {
    await makeEndpoint({ url: "https://same-game.example/hook" });
    await makeEndpoint({ url: "https://other-game.example/hook", gameId: otherGameId });
    const event = makeGroupUpdatedEvent(gameId, groupId);

    const ids = await enqueueWebhookDeliveries(prisma, event);

    expect(ids).toHaveLength(1);
    const deliveries = await prisma.webhookDelivery.findMany({ include: { endpoint: true } });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.endpoint.url).toBe("https://same-game.example/hook");
  });

  it("creates each delivery atomically (transaction commits all rows together)", async () => {
    await makeEndpoint({ url: "https://a.example/hook" });
    await makeEndpoint({ url: "https://b.example/hook" });
    await makeEndpoint({ url: "https://c.example/hook" });
    const event = makeGroupUpdatedEvent(gameId, groupId);

    await enqueueWebhookDeliveries(prisma, event);

    const count = await prisma.webhookDelivery.count();
    expect(count).toBe(3);
  });

  it("can be invoked twice for the same event id (callers are idempotent at the route layer)", async () => {
    await makeEndpoint({});
    const event = makeGroupUpdatedEvent(gameId, groupId);

    await enqueueWebhookDeliveries(prisma, event);
    await enqueueWebhookDeliveries(prisma, event);

    expect(await prisma.webhookDelivery.count()).toBe(2);
  });
});
