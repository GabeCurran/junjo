import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Regression suite for check-then-insert races. Before the
// isUniqueViolation/guarded-update work, the loser of each of these
// races surfaced a P2002/P2025 as a generic 500 (or, worse, both
// writers succeeded: a single-use invitation could admit two users).
// Each test fires the two racing requests together and accepts either
// interleaving: the loser may hit the friendly sequential check or the
// constraint-violation path, but the status codes and final row counts
// must come out the same either way.
describe.skipIf(!TEST_DATABASE_URL)("concurrent write races", () => {
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
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "BanHistory", "GameBan", "UserRelationship", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Race Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function jsonRequest(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        authorization: authHeader,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function makePublicGroup(name = "Open Guild") {
    return prisma.group.create({
      data: { gameId, kind: "guild", name, visibility: "public", metadata: {} },
    });
  }

  it("concurrent public joins produce one member and one already_member", async () => {
    const group = await makePublicGroup();

    // Looped: a single shot can serialize and pass through the
    // friendly sequential check without ever exercising the
    // constraint-violation path this test exists to protect.
    for (let i = 0; i < 5; i++) {
      const userId = `racer-join-${i}`;
      const [a, b] = await Promise.all([
        jsonRequest("POST", `/v1/groups/${group.id}/join`, { userId }),
        jsonRequest("POST", `/v1/groups/${group.id}/join`, { userId }),
      ]);

      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([201, 409]);
      const loser = a.status === 409 ? a : b;
      const loserBody = (await loser.json()) as { code: string };
      expect(loserBody.code).toBe("already_member");
    }

    const members = await prisma.groupMember.findMany({ where: { groupId: group.id } });
    expect(members).toHaveLength(5);
    expect(members.every((m) => m.status === "active")).toBe(true);
  });

  it("a single-use invitation admits exactly one of two concurrent redeemers", async () => {
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Invite Guild",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const invitation = await prisma.invitation.create({
      data: { groupId: group.id, code: "aaaabbbbccccdddd" },
    });

    const [a, b] = await Promise.all([
      jsonRequest("POST", `/v1/invitations/${invitation.code}/accept`, { userId: "redeemer-1" }),
      jsonRequest("POST", `/v1/invitations/${invitation.code}/accept`, { userId: "redeemer-2" }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 410]);

    const members = await prisma.groupMember.findMany({ where: { groupId: group.id } });
    expect(members).toHaveLength(1);
    const used = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(used.usedAt).not.toBeNull();
  });

  it("concurrent same-user invitation accepts admit once", async () => {
    const group = await makePublicGroup("Invite Guild 2");
    const first = await prisma.invitation.create({
      data: { groupId: group.id, code: "1111222233334444" },
    });
    const second = await prisma.invitation.create({
      data: { groupId: group.id, code: "5555666677778888" },
    });

    const [a, b] = await Promise.all([
      jsonRequest("POST", `/v1/invitations/${first.code}/accept`, { userId: "racer-2" }),
      jsonRequest("POST", `/v1/invitations/${second.code}/accept`, { userId: "racer-2" }),
    ]);

    // One accept lands; the other loses the membership race (409) after
    // its own invitation consume rolls back.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const members = await prisma.groupMember.findMany({ where: { groupId: group.id } });
    expect(members).toHaveLength(1);
    // Exactly one invitation was consumed; the loser's rollback restored
    // its usedAt to null.
    const consumedCount = await prisma.invitation.count({
      where: { groupId: group.id, usedAt: { not: null } },
    });
    expect(consumedCount).toBe(1);
  });

  it("concurrent game bans of an unseen user upsert a single ban row", async () => {
    for (let i = 0; i < 5; i++) {
      const userId = `cheater-${i}`;
      const [a, b] = await Promise.all([
        jsonRequest("POST", "/v1/bans", { userId, reason: "aimbot" }),
        jsonRequest("POST", "/v1/bans", { userId, reason: "aimbot" }),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    }
    expect(await prisma.gameBan.count()).toBe(5);
  });

  it("an invitation racing accept against decline resolves one way, cleanly", async () => {
    const group = await makePublicGroup("Race Invite Guild");
    const invitation = await prisma.invitation.create({
      data: { groupId: group.id, code: "9999aaaabbbbcccc" },
    });

    const [accept, decline] = await Promise.all([
      jsonRequest("POST", `/v1/invitations/${invitation.code}/accept`, { userId: "decider-1" }),
      jsonRequest("POST", `/v1/invitations/${invitation.code}/decline`, { userId: "decider-1" }),
    ]);

    // One side consumes the code; the loser sees invitation_used. A
    // decline must never clobber a successful accept's redemption
    // record (or vice versa).
    const outcomes = [accept.status, decline.status].sort();
    expect([[201, 410].join(","), [204, 410].join(",")]).toContain(outcomes.join(","));

    const members = await prisma.groupMember.count({ where: { groupId: group.id } });
    if (accept.status === 201) {
      expect(members).toBe(1);
    } else {
      expect(members).toBe(0);
    }
    const used = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
    expect(used.usedAt).not.toBeNull();
  });

  it("concurrent group bans of an unseen user upsert a single member row", async () => {
    const group = await makePublicGroup("Ban Guild");

    const [a, b] = await Promise.all([
      jsonRequest("POST", `/v1/groups/${group.id}/members/griefer-1/ban`, { reason: "griefing" }),
      jsonRequest("POST", `/v1/groups/${group.id}/members/griefer-1/ban`, { reason: "griefing" }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const members = await prisma.groupMember.findMany({ where: { groupId: group.id } });
    expect(members).toHaveLength(1);
    expect(members[0]?.status).toBe("banned");
  });

  it("concurrent duplicate friend requests create one pending row", async () => {
    const [a, b] = await Promise.all([
      jsonRequest("POST", "/v1/users/sender-1/friend-requests", {
        targetJunjoUserId: "receiver-1",
      }),
      jsonRequest("POST", "/v1/users/sender-1/friend-requests", {
        targetJunjoUserId: "receiver-1",
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 400]);
    expect(await prisma.userRelationship.count({ where: { type: "request" } })).toBe(1);
  });

  it("concurrent reciprocal parent-sets cannot close a hierarchy cycle", async () => {
    // The cycle walk runs inside a SERIALIZABLE transaction with the
    // write; under READ COMMITTED both walks would see an acyclic
    // graph and commit a permanent 2-cycle.
    const a = await makePublicGroup("Alliance A");
    const b = await makePublicGroup("Alliance B");

    const [ra, rb] = await Promise.all([
      jsonRequest("PUT", `/v1/groups/${a.id}/parent`, { parentGroupId: b.id }),
      jsonRequest("PUT", `/v1/groups/${b.id}/parent`, { parentGroupId: a.id }),
    ]);

    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([200, 400]);

    const rows = await prisma.group.findMany({
      where: { id: { in: [a.id, b.id] } },
      select: { id: true, parentGroupId: true },
    });
    const parentOf = new Map(rows.map((r) => [r.id, r.parentGroupId]));
    // Exactly one edge landed, and it must not be reciprocal.
    const edges = rows.filter((r) => r.parentGroupId !== null);
    expect(edges).toHaveLength(1);
    expect(parentOf.get(a.id) === b.id && parentOf.get(b.id) === a.id).toBe(false);
  });

  it("a rolled-back race loser leaves no staged webhook deliveries behind", async () => {
    // Deliveries are staged inside the mutation transaction (outbox
    // shape), so the losing join's rollback must take its staged
    // member.joined delivery with it. One winner, one delivery.
    await prisma.webhookEndpoint.create({
      data: {
        gameId,
        url: "https://all.example/hook",
        secret: "race-outbox-secret-12345678",
        events: [],
      },
    });
    const group = await makePublicGroup("Outbox Guild");

    const [a, b] = await Promise.all([
      jsonRequest("POST", `/v1/groups/${group.id}/join`, { userId: "outbox-racer" }),
      jsonRequest("POST", `/v1/groups/${group.id}/join`, { userId: "outbox-racer" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);

    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    const payload = deliveries[0]?.payload as { type: string };
    expect(payload.type).toBe("member.joined");
  });

  it("a friend request racing accept against decline resolves one way, cleanly", async () => {
    const send = await jsonRequest("POST", "/v1/users/sender-2/friend-requests", {
      targetJunjoUserId: "receiver-2",
    });
    expect(send.status).toBe(201);
    const sent = (await send.json()) as { request: { id: string } };
    const requestId = sent.request.id;

    const [accept, decline] = await Promise.all([
      jsonRequest("POST", `/v1/friend-requests/${requestId}/accept`),
      jsonRequest("POST", `/v1/friend-requests/${requestId}/decline`),
    ]);

    // Exactly one side wins; the loser 404s like a sequential second
    // caller. The final state matches whichever won: two friend rows on
    // accept, zero relationship rows on decline. A mixed end state
    // (deleted friendship, dangling mirror row) must never happen.
    const outcomes = [accept.status, decline.status].sort();
    expect([[200, 404].join(","), [204, 404].join(",")]).toContain(outcomes.join(","));

    const friendRows = await prisma.userRelationship.count({ where: { type: "friend" } });
    const requestRows = await prisma.userRelationship.count({ where: { type: "request" } });
    expect(requestRows).toBe(0);
    if (accept.status === 200) {
      expect(friendRows).toBe(2);
    } else {
      expect(friendRows).toBe(0);
    }
  });
});
