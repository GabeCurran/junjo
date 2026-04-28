import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups", () => {
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
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function postGroups(body: unknown, header: string = authHeader) {
    return app.request("/v1/groups", {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a group with the required fields and applies defaults", async () => {
    const res = await postGroups({ kind: "guild", name: "Crimson Wolves" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      gameId,
      kind: "guild",
      name: "Crimson Wolves",
      visibility: "invite-only",
      metadata: {},
      defaultRoleId: null,
      memberCount: 0,
      softDeletedAt: null,
    });
    expect(typeof body.id).toBe("string");
    expect(body.id).toMatch(/^c[a-z0-9]+/);
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
    expect(new Date(body.createdAt as string).toString()).not.toBe("Invalid Date");

    const stored = await prisma.group.findUnique({ where: { id: body.id as string } });
    expect(stored?.gameId).toBe(gameId);
    expect(stored?.visibility).toBe("invite-only");
  });

  it("preserves provided visibility, metadata, and defaultRoleId", async () => {
    const res = await postGroups({
      kind: "clan",
      name: "Iron Hand",
      visibility: "public",
      metadata: { motto: "Together" },
      defaultRoleId: "role_xyz",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.visibility).toBe("public");
    expect(body.metadata).toEqual({ motto: "Together" });
    expect(body.defaultRoleId).toBe("role_xyz");
  });

  it("writes a group.created audit entry per call", async () => {
    const res = await postGroups({ kind: "guild", name: "Audit Group" });
    const body = (await res.json()) as { id: string };
    const entries = await prisma.auditEntry.findMany({ where: { groupId: body.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("group.created");
    expect(entry.targetId).toBe(body.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({ name: "Audit Group", kind: "guild" });
  });

  it("rejects a body missing required fields", async () => {
    const res = await postGroups({ kind: "guild" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects an invalid visibility value", async () => {
    const res = await postGroups({ kind: "guild", name: "x", visibility: "open" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const res = await postGroups({ kind: "guild", name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await postGroups("not json");
    expect(res.status).toBe(400);
  });

  it("rejects requests without an API key", async () => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "guild", name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("scopes the new group to the calling game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherKey = await createApiKey(otherGame.id, prisma);

    const a = await postGroups({ kind: "guild", name: "From A" });
    const b = await postGroups({ kind: "guild", name: "From B" }, `Bearer ${otherKey.raw.full}`);
    const ja = (await a.json()) as { gameId: string };
    const jb = (await b.json()) as { gameId: string };
    expect(ja.gameId).toBe(gameId);
    expect(jb.gameId).toBe(otherGame.id);
    expect(ja.gameId).not.toBe(jb.gameId);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id", () => {
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
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function getGroup(id: string, header: string = authHeader) {
    return app.request(`/v1/groups/${id}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  async function seedGroup(overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {}) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Test Group",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("returns the group when it exists in the calling game", async () => {
    const group = await seedGroup();
    const res = await getGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: group.id,
      gameId,
      kind: "guild",
      name: "Test Group",
      visibility: "invite-only",
      metadata: {},
      defaultRoleId: null,
      memberCount: 0,
      softDeletedAt: null,
    });
    expect(typeof body.createdAt).toBe("string");
    expect(new Date(body.createdAt as string).toString()).not.toBe("Invalid Date");
  });

  it("counts only active members in memberCount", async () => {
    const group = await seedGroup();
    const userA = await prisma.junjoUser.create({ data: {} });
    const userB = await prisma.junjoUser.create({ data: {} });
    const userC = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.createMany({
      data: [
        { groupId: group.id, junjoUserId: userA.id, status: "active" },
        { groupId: group.id, junjoUserId: userB.id, status: "active" },
        { groupId: group.id, junjoUserId: userC.id, status: "left" },
      ],
    });

    const res = await getGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberCount: number };
    expect(body.memberCount).toBe(2);
  });

  it("returns 404 not_found when the group does not exist", async () => {
    const res = await getGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await getGroup(group.id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await getGroup(group.id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
