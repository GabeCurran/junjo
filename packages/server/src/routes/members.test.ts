import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/members/:id", () => {
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
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {}) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    overrideGameId: string = gameId,
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId: overrideGameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function getMember(id: string, header = authHeader) {
    return app.request(`/v1/members/${id}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the member with the dev's external user id", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");

    const res = await getMember(member.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "active",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });
    expect(typeof body.joinedAt).toBe("string");
  });

  it("returns members in non-active status", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", gameId, "kicked");
    const res = await getMember(member.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("kicked");
  });

  it("populates roles from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await getMember(member.id);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("returns 404 when the member id does not exist", async () => {
    const res = await getMember("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the member's group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherKey = await createApiKey(otherGame.id, prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const { member } = await seedMember(group.id, "user_alice", otherGame.id);

    // Calling with our test game's API key cannot read a member of another game.
    const res = await getMember(member.id);
    expect(res.status).toBe(404);

    // The other game's key works.
    const ok = await getMember(member.id, `Bearer ${otherKey.raw.full}`);
    expect(ok.status).toBe(200);
  });

  it("returns 404 when the member's group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const { member } = await seedMember(group.id, "user_alice");
    const res = await getMember(member.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const res = await app.request(`/v1/members/${member.id}`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the id path parameter", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const encoded = encodeURIComponent(member.id);
    const res = await getMember(encoded);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(member.id);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/users/:userId/members", () => {
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
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {}) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  // Seeds a JunjoUser + ExternalIdentity once, then attaches GroupMember
  // rows for each (group, status, joinedAt) entry in `memberships`. Lets a
  // test put one external user across many groups deterministically.
  async function seedUserWithMemberships(
    externalUserId: string,
    memberships: Array<{
      groupId: string;
      status?: "active" | "left" | "kicked" | "invited";
      joinedAt?: Date;
    }>,
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const members = [];
    for (const m of memberships) {
      const member = await prisma.groupMember.create({
        data: {
          groupId: m.groupId,
          junjoUserId: user.id,
          status: m.status ?? "active",
          ...(m.joinedAt !== undefined ? { joinedAt: m.joinedAt } : {}),
        },
      });
      members.push(member);
    }
    return { user, members };
  }

  function listForUser(userId: string, query = "", header = authHeader) {
    return app.request(`/v1/users/${userId}/members${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the user's memberships across groups in this game", async () => {
    const guild = await seedGroup();
    const clan = await seedGroup();
    await seedUserWithMemberships("user_alice", [
      { groupId: guild.id, joinedAt: new Date("2026-01-01T00:00:00Z") },
      { groupId: clan.id, joinedAt: new Date("2026-02-01T00:00:00Z") },
    ]);

    const res = await listForUser("user_alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ userId: string; groupId: string }>;
    expect(body).toHaveLength(2);
    expect(body.every((m) => m.userId === "user_alice")).toBe(true);
    expect(body.map((m) => m.groupId).sort()).toEqual([guild.id, clan.id].sort());
  });

  it("orders memberships by joinedAt desc", async () => {
    const a = await seedGroup();
    const b = await seedGroup();
    const c = await seedGroup();
    await seedUserWithMemberships("user_alice", [
      { groupId: a.id, joinedAt: new Date("2026-01-01T00:00:00Z") },
      { groupId: c.id, joinedAt: new Date("2026-03-01T00:00:00Z") },
      { groupId: b.id, joinedAt: new Date("2026-02-01T00:00:00Z") },
    ]);

    const res = await listForUser("user_alice");
    const body = (await res.json()) as Array<{ groupId: string }>;
    expect(body.map((m) => m.groupId)).toEqual([c.id, b.id, a.id]);
  });

  it("excludes memberships in soft-deleted groups", async () => {
    const live = await seedGroup();
    const dead = await seedGroup({ softDeletedAt: new Date() });
    await seedUserWithMemberships("user_alice", [{ groupId: live.id }, { groupId: dead.id }]);

    const res = await listForUser("user_alice");
    const body = (await res.json()) as Array<{ groupId: string }>;
    expect(body.map((m) => m.groupId)).toEqual([live.id]);
  });

  it("includes memberships in any status (active, left, kicked, invited)", async () => {
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    const groupC = await seedGroup();
    await seedUserWithMemberships("user_alice", [
      { groupId: groupA.id, status: "active", joinedAt: new Date("2026-03-01T00:00:00Z") },
      { groupId: groupB.id, status: "kicked", joinedAt: new Date("2026-02-01T00:00:00Z") },
      { groupId: groupC.id, status: "left", joinedAt: new Date("2026-01-01T00:00:00Z") },
    ]);

    const res = await listForUser("user_alice");
    const body = (await res.json()) as Array<{ groupId: string; status: string }>;
    expect(body).toHaveLength(3);
    expect(body.map((m) => m.status)).toEqual(["active", "kicked", "left"]);
  });

  it("populates roles via batched MemberRole lookup", async () => {
    const group = await seedGroup();
    const { members } = await seedUserWithMemberships("user_alice", [{ groupId: group.id }]);
    const member = members[0];
    if (!member) throw new Error("expected member");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await listForUser("user_alice");
    const body = (await res.json()) as Array<{ roles: string[] }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.roles).toEqual([role.id]);
  });

  it("returns an empty array when the user has no ExternalIdentity in this game", async () => {
    const res = await listForUser("user_unknown");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("returns an empty array when the user has an identity but no memberships", async () => {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alone" },
    });
    const res = await listForUser("user_alone");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("scopes results to the calling game (cross-game memberships are hidden)", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const ourGroup = await seedGroup();
    const otherGroup = await prisma.group.create({
      data: {
        gameId: otherGame.id,
        kind: "guild",
        name: "Other Group",
        visibility: "invite-only",
        metadata: {},
      },
    });

    // Same external user id in two games but two distinct JunjoUsers.
    await seedUserWithMemberships("user_alice", [{ groupId: ourGroup.id }]);
    const otherUser = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId: otherGame.id, junjoUserId: otherUser.id, externalUserId: "user_alice" },
    });
    await prisma.groupMember.create({
      data: { groupId: otherGroup.id, junjoUserId: otherUser.id, status: "active" },
    });

    const res = await listForUser("user_alice");
    const body = (await res.json()) as Array<{ groupId: string }>;
    expect(body.map((m) => m.groupId)).toEqual([ourGroup.id]);
  });

  it("accepts ?gameId matching the calling game", async () => {
    const group = await seedGroup();
    await seedUserWithMemberships("user_alice", [{ groupId: group.id }]);

    const res = await listForUser("user_alice", `?gameId=${gameId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(1);
  });

  it("rejects ?gameId pointing at another game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const res = await listForUser("user_alice", `?gameId=${otherGame.id}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects requests without an API key", async () => {
    const res = await app.request("/v1/users/user_alice/members", { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    await seedUserWithMemberships("weird/user", [{ groupId: group.id }]);
    const res = await listForUser("weird%2Fuser");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ userId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.userId).toBe("weird/user");
  });
});
