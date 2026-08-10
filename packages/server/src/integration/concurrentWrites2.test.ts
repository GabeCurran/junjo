import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Second regression suite for check-then-write races (see
// concurrentWrites.test.ts for the first batch). Each test fires two
// racing requests together and accepts either interleaving: the loser
// may hit the friendly sequential pre-check or the constraint-violation
// / guarded-delete path, but the status codes and final row counts must
// come out the same either way.
describe.skipIf(!TEST_DATABASE_URL)("concurrent write races, batch two", () => {
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
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "BanHistory", "GameBan", "UserRelationshipTag", "FriendTag", "UserRelationship", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Race Game 2", prisma);
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

  // Creates a JunjoUser plus an ExternalIdentity whose external id
  // equals the internal cuid, so the same value works as a path param
  // and in direct DB assertions (same trick as friends.test.ts).
  async function makeUser(): Promise<string> {
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, externalUserId: u.id, junjoUserId: u.id },
    });
    return u.id;
  }

  async function makeFriends(a: string, b: string) {
    const now = new Date();
    await prisma.userRelationship.create({
      data: {
        gameId,
        actorJunjoUserId: a,
        targetJunjoUserId: b,
        type: "friend",
        respondedAt: now,
      },
    });
    await prisma.userRelationship.create({
      data: {
        gameId,
        actorJunjoUserId: b,
        targetJunjoUserId: a,
        type: "friend",
        respondedAt: now,
      },
    });
  }

  it("concurrent duplicate blocks create one row; the loser gets the idempotent response", async () => {
    const [a, b] = await Promise.all([
      jsonRequest("POST", "/v1/users/blocker-1/blocks", { targetJunjoUserId: "blockee-1" }),
      jsonRequest("POST", "/v1/users/blocker-1/blocks", { targetJunjoUserId: "blockee-1" }),
    ]);

    // Winner 201s with the created row; the loser answers like a
    // sequential duplicate block: 200 with the winner's row.
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 201]);
    const bodyA = (await a.json()) as { id: string };
    const bodyB = (await b.json()) as { id: string };
    expect(bodyA.id).toBe(bodyB.id);

    const blocks = await prisma.userRelationship.findMany({ where: { type: "blocked" } });
    expect(blocks).toHaveLength(1);
  });

  it("concurrent unblocks delete once; the loser 404s like a sequential second caller", async () => {
    const created = await jsonRequest("POST", "/v1/users/blocker-2/blocks", {
      targetJunjoUserId: "blockee-2",
    });
    expect(created.status).toBe(201);

    const [a, b] = await Promise.all([
      jsonRequest("DELETE", "/v1/users/blocker-2/blocks/blockee-2"),
      jsonRequest("DELETE", "/v1/users/blocker-2/blocks/blockee-2"),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([204, 404]);
    expect(await prisma.userRelationship.count({ where: { type: "blocked" } })).toBe(0);
  });

  it("concurrent unfriends remove the pair once and publish one friend.removed", async () => {
    await prisma.webhookEndpoint.create({
      data: {
        gameId,
        url: "https://all.example/hook",
        secret: "race-outbox-secret-12345678",
        events: [],
      },
    });
    const a = await makeUser();
    const b = await makeUser();
    await makeFriends(a, b);

    // Both racers unfriend from the same side so their deletes hit the
    // two rows in the same order (opposite-side racers would be a
    // lock-ordering test, not a duplicate-event test).
    const [ra, rb] = await Promise.all([
      jsonRequest("DELETE", `/v1/users/${a}/friends/${b}`),
      jsonRequest("DELETE", `/v1/users/${a}/friends/${b}`),
    ]);

    // The loser deletes zero rows and 404s like an unfriend of a
    // non-friend; only the winner stages a friend.removed event.
    const statuses = [ra.status, rb.status].sort();
    expect(statuses).toEqual([204, 404]);
    expect(await prisma.userRelationship.count({ where: { type: "friend" } })).toBe(0);

    const deliveries = await prisma.webhookDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    const payload = deliveries[0]?.payload as { type: string };
    expect(payload.type).toBe("friend.removed");
  });

  it("concurrent game unbans delete once; the loser 404s like a sequential second caller", async () => {
    const banned = await jsonRequest("POST", "/v1/bans", { userId: "cheater-2", reason: "aimbot" });
    expect(banned.status).toBe(201);

    const [a, b] = await Promise.all([
      jsonRequest("DELETE", "/v1/bans/cheater-2"),
      jsonRequest("DELETE", "/v1/bans/cheater-2"),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([204, 404]);
    expect(await prisma.gameBan.count()).toBe(0);
    // Exactly one "lifted" history row: the loser's rollback dropped its
    // audit/history writes with it.
    expect(await prisma.banHistory.count({ where: { kind: "lifted" } })).toBe(1);
  });

  it("concurrent duplicate role assigns land one MemberRole row and both 200", async () => {
    const group = await makePublicGroup("Role Guild");
    const userId = await makeUser();
    await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: userId, status: "active" },
    });
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "Officer", priority: 1 },
    });

    const [a, b] = await Promise.all([
      jsonRequest("POST", `/v1/groups/${group.id}/members/${userId}/roles/${role.id}`, {}),
      jsonRequest("POST", `/v1/groups/${group.id}/members/${userId}/roles/${role.id}`, {}),
    ]);

    // The loser answers like a sequential duplicate assign: idempotent
    // member snapshot, no second event.
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await prisma.memberRole.count()).toBe(1);
  });

  it("concurrent same-name role creates land one Role and one role_name_taken", async () => {
    const group = await makePublicGroup("Role Name Guild");

    const [a, b] = await Promise.all([
      jsonRequest("POST", `/v1/groups/${group.id}/roles`, { name: "Captain", priority: 5 }),
      jsonRequest("POST", `/v1/groups/${group.id}/roles`, { name: "Captain", priority: 5 }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    const loserBody = (await loser.json()) as { code: string };
    expect(loserBody.code).toBe("role_name_taken");
    expect(await prisma.role.count({ where: { groupId: group.id } })).toBe(1);
  });

  it("concurrent relationship clears both 204 and clear the row once", async () => {
    const ga = await makePublicGroup("Alliance A");
    const gb = await makePublicGroup("Alliance B");
    await prisma.groupRelationship.create({
      data: { groupAId: ga.id, groupBId: gb.id, type: "ally", setByUserId: null },
    });

    const [a, b] = await Promise.all([
      jsonRequest("DELETE", `/v1/groups/${ga.id}/relationships/${gb.id}`),
      jsonRequest("DELETE", `/v1/groups/${ga.id}/relationships/${gb.id}`),
    ]);

    // Clear is idempotent (204 even when nothing was deleted), so both
    // callers 204; the loser must skip the audit/event instead of
    // crashing on the missing record.
    expect(a.status).toBe(204);
    expect(b.status).toBe(204);
    expect(await prisma.groupRelationship.count()).toBe(0);
    expect(await prisma.auditEntry.count({ where: { action: "group.relationship.cleared" } })).toBe(
      1,
    );
  });

  it("concurrent setFriendTags calls settle on one caller's tag set", async () => {
    const a = await makeUser();
    const b = await makeUser();
    await makeFriends(a, b);
    const tagOne = await prisma.friendTag.create({
      data: { gameId, junjoUserId: a, name: "guildmates" },
    });
    const tagTwo = await prisma.friendTag.create({
      data: { gameId, junjoUserId: a, name: "irl" },
    });

    // Overlapping sets: when the interleaving makes the loser's create
    // of the shared tag collide with the winner's committed row, the
    // old code surfaced the P2002 as a 500. The retry reruns the
    // delete-then-create, which is last-writer-wins.
    const setOne = [tagOne.id];
    const setTwo = [tagOne.id, tagTwo.id];
    const [ra, rb] = await Promise.all([
      jsonRequest("PUT", `/v1/users/${a}/friends/${b}/tags`, { tagIds: setOne }),
      jsonRequest("PUT", `/v1/users/${a}/friends/${b}/tags`, { tagIds: setTwo }),
    ]);

    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const joins = await prisma.userRelationshipTag.findMany();
    const finalTagIds = joins.map((j) => j.friendTagId).sort();
    expect([setOne.slice().sort().join(","), setTwo.slice().sort().join(",")]).toContain(
      finalTagIds.join(","),
    );
  });
});
