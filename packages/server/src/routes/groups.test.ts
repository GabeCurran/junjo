import { type Prisma, PrismaClient } from "@prisma/client";
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

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups", () => {
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

  function listGroups(query = "", header: string = authHeader) {
    const path = query ? `/v1/groups?${query}` : "/v1/groups";
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  async function seedGroup(opts: {
    gameId?: string;
    name: string;
    createdAt?: Date;
    softDeletedAt?: Date | null;
  }) {
    return prisma.group.create({
      data: {
        gameId: opts.gameId ?? gameId,
        kind: "guild",
        name: opts.name,
        visibility: "invite-only",
        metadata: {},
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.softDeletedAt !== undefined ? { softDeletedAt: opts.softDeletedAt } : {}),
      },
    });
  }

  it("returns an empty page when no groups exist", async () => {
    const res = await listGroups();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns groups in createdAt desc order with memberCount", async () => {
    await seedGroup({ name: "oldest", createdAt: new Date("2026-04-01T00:00:00Z") });
    const middle = await seedGroup({ name: "middle", createdAt: new Date("2026-04-02T00:00:00Z") });
    await seedGroup({ name: "newest", createdAt: new Date("2026-04-03T00:00:00Z") });

    const userA = await prisma.junjoUser.create({ data: {} });
    const userB = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.createMany({
      data: [
        { groupId: middle.id, junjoUserId: userA.id, status: "active" },
        { groupId: middle.id, junjoUserId: userB.id, status: "left" },
      ],
    });

    const res = await listGroups();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; memberCount: number }>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.name)).toEqual(["newest", "middle", "oldest"]);
    expect(body.items.map((i) => i.memberCount)).toEqual([0, 1, 0]);
    expect(body.nextCursor).toBeNull();
  });

  it("excludes soft-deleted groups and groups in other games", async () => {
    await seedGroup({ name: "visible" });
    await seedGroup({ name: "trashed", softDeletedAt: new Date() });
    const otherGame = await createGame("Other Game", prisma);
    await seedGroup({ gameId: otherGame.id, name: "elsewhere" });

    const res = await listGroups();
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["visible"]);
  });

  it("paginates via cursor and limit", async () => {
    for (let i = 0; i < 5; i++) {
      await seedGroup({
        name: `g${i}`,
        createdAt: new Date(`2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      });
    }

    const page1 = await listGroups("limit=2");
    const body1 = (await page1.json()) as {
      items: Array<{ id: string; name: string }>;
      nextCursor: string | null;
    };
    expect(body1.items.map((i) => i.name)).toEqual(["g4", "g3"]);
    expect(body1.nextCursor).toBe(body1.items[1]?.id);

    const page2 = await listGroups(`limit=2&cursor=${body1.nextCursor}`);
    const body2 = (await page2.json()) as {
      items: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(body2.items.map((i) => i.name)).toEqual(["g2", "g1"]);
    expect(body2.nextCursor).not.toBeNull();

    const page3 = await listGroups(`limit=2&cursor=${body2.nextCursor}`);
    const body3 = (await page3.json()) as {
      items: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(body3.items.map((i) => i.name)).toEqual(["g0"]);
    expect(body3.nextCursor).toBeNull();
  });

  it("defaults limit to 50 when not provided", async () => {
    for (let i = 0; i < 51; i++) {
      await seedGroup({
        name: `g${i}`,
        createdAt: new Date(2026, 3, 1, 0, 0, i),
      });
    }
    const res = await listGroups();
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it("rejects an out-of-range limit", async () => {
    const res = await listGroups("limit=101");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a non-integer limit", async () => {
    const res = await listGroups("limit=abc");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown cursor", async () => {
    const res = await listGroups("cursor=ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("invalid cursor");
  });

  it("rejects a cursor pointing at a group in a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const stranger = await seedGroup({ gameId: otherGame.id, name: "elsewhere" });
    const res = await listGroups(`cursor=${stranger.id}`);
    expect(res.status).toBe(400);
  });

  it("accepts a gameId that matches the calling game", async () => {
    await seedGroup({ name: "mine" });
    const res = await listGroups(`gameId=${gameId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["mine"]);
  });

  it("rejects a gameId that does not match the calling game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const res = await listGroups(`gameId=${otherGame.id}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("gameId must match the calling game");
  });

  it("preserves pagination across a soft-deleted cursor row", async () => {
    const a = await seedGroup({ name: "a", createdAt: new Date("2026-04-03T00:00:00Z") });
    await seedGroup({ name: "b", createdAt: new Date("2026-04-02T00:00:00Z") });
    await seedGroup({ name: "c", createdAt: new Date("2026-04-01T00:00:00Z") });
    await prisma.group.update({ where: { id: a.id }, data: { softDeletedAt: new Date() } });

    const res = await listGroups(`cursor=${a.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["b", "c"]);
  });

  it("rejects requests without an API key", async () => {
    const res = await app.request("/v1/groups", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PATCH /v1/groups/:id", () => {
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

  function patchGroup(id: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${id}`, {
      method: "PATCH",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function seedGroup(
    overrides: Partial<{
      gameId: string;
      name: string;
      visibility: string;
      metadata: Record<string, unknown>;
      defaultRoleId: string | null;
      softDeletedAt: Date;
    }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: overrides.name ?? "Test Group",
        visibility: overrides.visibility ?? "invite-only",
        metadata: (overrides.metadata ?? {}) as Prisma.InputJsonValue,
        defaultRoleId: overrides.defaultRoleId ?? null,
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("updates a single field and returns the updated group", async () => {
    const group = await seedGroup({ name: "Old Name" });
    const res = await patchGroup(group.id, { name: "New Name" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(group.id);
    expect(body.name).toBe("New Name");
    expect(body.visibility).toBe("invite-only");

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.name).toBe("New Name");
  });

  it("updates multiple fields in one call", async () => {
    const group = await seedGroup({
      name: "Old Name",
      visibility: "invite-only",
      metadata: { motto: "Old" },
      defaultRoleId: "role_old",
    });
    const res = await patchGroup(group.id, {
      name: "New Name",
      visibility: "public",
      metadata: { motto: "New" },
      defaultRoleId: "role_new",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "New Name",
      visibility: "public",
      metadata: { motto: "New" },
      defaultRoleId: "role_new",
    });
  });

  it("clears defaultRoleId when set to null", async () => {
    const group = await seedGroup({ defaultRoleId: "role_keep" });
    const res = await patchGroup(group.id, { defaultRoleId: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultRoleId: string | null };
    expect(body.defaultRoleId).toBeNull();
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.defaultRoleId).toBeNull();
  });

  it("replaces metadata wholesale rather than merging", async () => {
    const group = await seedGroup({ metadata: { motto: "old", banner: "url" } });
    const res = await patchGroup(group.id, { metadata: { tagline: "new" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ tagline: "new" });
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.metadata).toEqual({ tagline: "new" });
  });

  it("writes a group.updated audit entry whose payload contains only changed fields", async () => {
    const group = await seedGroup({
      name: "Before",
      visibility: "invite-only",
      defaultRoleId: "role_keep",
    });
    const res = await patchGroup(group.id, {
      name: "After",
      visibility: "invite-only",
      defaultRoleId: "role_keep",
    });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.updated" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(group.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      before: { name: "Before" },
      after: { name: "After" },
    });
  });

  it("writes no audit entry when the patch is a no-op", async () => {
    const group = await seedGroup({ name: "Same", visibility: "invite-only" });
    const beforeUpdatedAt = group.updatedAt.toISOString();
    const res = await patchGroup(group.id, { name: "Same", visibility: "invite-only" });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.updated" },
    });
    expect(entries).toHaveLength(0);
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.updatedAt.toISOString()).toBe(beforeUpdatedAt);
  });

  it("returns the active member count in the response", async () => {
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

    const res = await patchGroup(group.id, { name: "Renamed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberCount: number };
    expect(body.memberCount).toBe(2);
  });

  it("rejects an empty body with 400", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/at least one field/);
  });

  it("rejects an invalid visibility value", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, { visibility: "open" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, { name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await patchGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx", { name: "x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await patchGroup(group.id, { name: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await patchGroup(group.id, { name: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/groups/:id", () => {
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

  function deleteGroup(id: string, query = "", header: string = authHeader) {
    const path = query ? `/v1/groups/${id}?${query}` : `/v1/groups/${id}`;
    return app.request(path, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Doomed",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("soft-deletes a live group and writes a group.deleted audit entry", async () => {
    const group = await seedGroup();
    const res = await deleteGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(group.id);
    expect(typeof body.softDeletedAt).toBe("string");

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt).toBeInstanceOf(Date);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.deleted" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(group.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({ kind: "soft", retentionDays: 7 });
  });

  it("is idempotent on an already soft-deleted group (no second audit entry)", async () => {
    const group = await seedGroup({ softDeletedAt: new Date("2026-04-27T00:00:00Z") });
    const res = await deleteGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { softDeletedAt: string };
    expect(body.softDeletedAt).toBe("2026-04-27T00:00:00.000Z");

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt?.toISOString()).toBe("2026-04-27T00:00:00.000Z");

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.deleted" },
    });
    expect(entries).toHaveLength(0);
  });

  it("hard-deletes when ?hard=true is set, including the group's audit history", async () => {
    const group = await seedGroup();
    await prisma.auditEntry.create({
      data: {
        groupId: group.id,
        action: "group.created",
        targetId: group.id,
        payload: {},
      },
    });

    const res = await deleteGroup(group.id, "hard=true");
    expect(res.status).toBe(204);

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored).toBeNull();

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(0);
  });

  it("hard-deletes a group that was already soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date("2026-04-20T00:00:00Z") });
    const res = await deleteGroup(group.id, "hard=true");
    expect(res.status).toBe(204);
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored).toBeNull();
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await deleteGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await deleteGroup(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/restore", () => {
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

  function restoreGroup(id: string, header: string = authHeader) {
    return app.request(`/v1/groups/${id}/restore`, {
      method: "POST",
      headers: { authorization: header },
    });
  }

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Phoenix",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("restores a soft-deleted group within the 7-day window", async () => {
    const softDeletedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const group = await seedGroup({ softDeletedAt });
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; softDeletedAt: string | null };
    expect(body.id).toBe(group.id);
    expect(body.softDeletedAt).toBeNull();

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt).toBeNull();

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.restored" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(group.id);
    expect(entry.payload).toMatchObject({ previousSoftDeletedAt: softDeletedAt.toISOString() });
  });

  it("is idempotent on a non-deleted group (no audit entry)", async () => {
    const group = await seedGroup();
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { softDeletedAt: string | null };
    expect(body.softDeletedAt).toBeNull();

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.restored" },
    });
    expect(entries).toHaveLength(0);
  });

  it("rejects restore on a group whose soft-delete is older than 7 days", async () => {
    const softDeletedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const group = await seedGroup({ softDeletedAt });
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("restore_window_expired");
    expect(body.message).toMatch(/7 days/);

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt).toEqual(softDeletedAt);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await restoreGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id, softDeletedAt: new Date() });
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await app.request(`/v1/groups/${group.id}/restore`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/invitations", () => {
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
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function postInvite(groupId: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${groupId}/invitations`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
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

  it("creates a direct-user invitation with a generated code", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { targetUserId: "user_alice" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      groupId: group.id,
      targetUserId: "user_alice",
      roleId: null,
      createdBy: null,
      usedAt: null,
      usedBy: null,
      expiresAt: null,
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.code).toBe("string");
    expect(body.code as string).toMatch(/^[a-f0-9]{16}$/);
    expect(typeof body.createdAt).toBe("string");

    const stored = await prisma.invitation.findUnique({ where: { id: body.id as string } });
    expect(stored?.groupId).toBe(group.id);
    expect(stored?.targetUserId).toBe("user_alice");
    expect(stored?.createdByUserId).toBeNull();
    expect(stored?.code).toBe(body.code);
  });

  it("forwards an optional roleId verbatim", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, {
      targetUserId: "user_bob",
      roleId: "role_officer",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roleId: string | null };
    expect(body.roleId).toBe("role_officer");

    const stored = await prisma.invitation.findFirst({ where: { groupId: group.id } });
    expect(stored?.roleId).toBe("role_officer");
  });

  it("writes a member.invited audit entry per call", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, {
      targetUserId: "user_carol",
      roleId: "role_x",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; code: string };

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "member.invited" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe("user_carol");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({
      invitationId: body.id,
      code: body.code,
      targetUserId: "user_carol",
      roleId: "role_x",
    });
  });

  it("generates a unique code per call", async () => {
    const group = await seedGroup();
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await postInvite(group.id, { targetUserId: `user_${i}` });
      const body = (await res.json()) as { code: string };
      codes.add(body.code);
    }
    expect(codes.size).toBe(5);
  });

  it("creates an open-code invitation when targetUserId is omitted", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      groupId: group.id,
      targetUserId: null,
      roleId: null,
      createdBy: null,
      usedAt: null,
      usedBy: null,
      expiresAt: null,
    });
    expect(body.code as string).toMatch(/^[a-f0-9]{16}$/);

    const stored = await prisma.invitation.findUnique({ where: { id: body.id as string } });
    expect(stored?.targetUserId).toBeNull();
    expect(stored?.expiresAt).toBeNull();
  });

  it("creates an open-code invitation with a roleId", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { roleId: "role_recruit" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roleId: string | null; targetUserId: string | null };
    expect(body.roleId).toBe("role_recruit");
    expect(body.targetUserId).toBeNull();
  });

  it("computes expiresAt from a duration string", async () => {
    const group = await seedGroup();
    const before = Date.now();
    const res = await postInvite(group.id, { expiresIn: "7d" });
    const after = Date.now();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expiresAt: string | null; id: string };
    expect(body.expiresAt).not.toBeNull();
    const expiresMs = new Date(body.expiresAt as string).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs);

    const stored = await prisma.invitation.findUnique({ where: { id: body.id } });
    expect(stored?.expiresAt).not.toBeNull();
    expect(stored?.expiresAt?.getTime()).toBe(expiresMs);
  });

  it("supports s, m, h, and d duration units", async () => {
    const group = await seedGroup();
    const cases: Array<{ input: string; ms: number }> = [
      { input: "30s", ms: 30 * 1000 },
      { input: "5m", ms: 5 * 60 * 1000 },
      { input: "2h", ms: 2 * 60 * 60 * 1000 },
      { input: "1d", ms: 24 * 60 * 60 * 1000 },
    ];
    for (const { input, ms } of cases) {
      const before = Date.now();
      const res = await postInvite(group.id, { expiresIn: input });
      const after = Date.now();
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresAt: string | null };
      const t = new Date(body.expiresAt as string).getTime();
      expect(t).toBeGreaterThanOrEqual(before + ms);
      expect(t).toBeLessThanOrEqual(after + ms);
    }
  });

  it("audits an open-code invitation with targetId null and expiresAt in payload", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { roleId: "role_recruit", expiresIn: "1h" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; code: string; expiresAt: string };

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "member.invited" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBeNull();
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({
      invitationId: body.id,
      code: body.code,
      targetUserId: null,
      roleId: "role_recruit",
      expiresAt: body.expiresAt,
    });
  });

  it("rejects an empty targetUserId", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { targetUserId: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed expiresIn string", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { expiresIn: "soon" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a non-positive expiresIn", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { expiresIn: "0d" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/positive/);
  });

  it("rejects a malformed JSON body", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postInvite("ckxxxxxxxxxxxxxxxxxxxxxxxx", { targetUserId: "user_x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await postInvite(group.id, { targetUserId: "user_x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postInvite(group.id, { targetUserId: "user_x" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUserId: "user_x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/invitations", () => {
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
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
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

  async function seedInvite(
    groupId: string,
    overrides: Partial<{
      code: string;
      targetUserId: string | null;
      roleId: string | null;
      expiresAt: Date | null;
      usedAt: Date | null;
      usedByUserId: string | null;
      createdAt: Date;
    }> = {},
  ) {
    return prisma.invitation.create({
      data: {
        groupId,
        code: overrides.code ?? Math.random().toString(36).slice(2, 18).padEnd(16, "0"),
        targetUserId: overrides.targetUserId ?? null,
        roleId: overrides.roleId ?? null,
        expiresAt: overrides.expiresAt ?? null,
        usedAt: overrides.usedAt ?? null,
        usedByUserId: overrides.usedByUserId ?? null,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  function listInvites(groupId: string, query = "", header: string = authHeader) {
    const path = query
      ? `/v1/groups/${groupId}/invitations?${query}`
      : `/v1/groups/${groupId}/invitations`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  it("returns an empty page when no invitations exist", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns invitations in createdAt desc order, default-excluding used and expired", async () => {
    const group = await seedGroup();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await seedInvite(group.id, { code: "valid_b__________", createdAt: t1 });
    await seedInvite(group.id, { code: "valid_a__________", createdAt: t2 });
    await seedInvite(group.id, {
      code: "expired__________",
      createdAt: t0,
      expiresAt: past,
    });
    await seedInvite(group.id, {
      code: "used_____________",
      createdAt: t0,
      usedAt: new Date(),
      usedByUserId: "user_alice",
    });
    await seedInvite(group.id, {
      code: "future_expiry____",
      createdAt: t0,
      expiresAt: future,
    });

    const res = await listInvites(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ code: string; createdAt: string }>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.code)).toEqual([
      "valid_a__________",
      "valid_b__________",
      "future_expiry____",
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("includes expired rows when includeExpired=true", async () => {
    const group = await seedGroup();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await seedInvite(group.id, { code: "expired__________", expiresAt: past });
    await seedInvite(group.id, { code: "live_____________" });

    const res = await listInvites(group.id, "includeExpired=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ code: string }> };
    const codes = body.items.map((i) => i.code).sort();
    expect(codes).toEqual(["expired__________", "live_____________"]);
  });

  it("includes used rows when includeUsed=true", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, {
      code: "used_____________",
      usedAt: new Date(),
      usedByUserId: "user_alice",
    });
    await seedInvite(group.id, { code: "live_____________" });

    const res = await listInvites(group.id, "includeUsed=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ code: string }> };
    const codes = body.items.map((i) => i.code).sort();
    expect(codes).toEqual(["live_____________", "used_____________"]);
  });

  it("paginates via cursor and limit", async () => {
    const group = await seedGroup();
    for (let i = 0; i < 5; i++) {
      await seedInvite(group.id, {
        code: `code_${i}__________`.slice(0, 16).padEnd(16, "0"),
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const first = await listInvites(group.id, "limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ id: string; createdAt: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(firstBody.items[1]?.id);

    const second = await listInvites(group.id, `limit=2&cursor=${firstBody.nextCursor as string}`);
    const secondBody = (await second.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.nextCursor).toBe(secondBody.items[1]?.id);
    expect(secondBody.items.map((i) => i.id)).not.toEqual(firstBody.items.map((i) => i.id));

    const third = await listInvites(group.id, `limit=2&cursor=${secondBody.nextCursor as string}`);
    const thirdBody = (await third.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(thirdBody.items).toHaveLength(1);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("rejects an out-of-range limit", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id, "limit=0");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects an unknown cursor", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id, "cursor=ckunknown");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a cursor pointing at an invitation in another group", async () => {
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    const invB = await seedInvite(groupB.id);
    const res = await listInvites(groupA.id, `cursor=${invB.id}`);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid includeExpired value", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id, "includeExpired=yes");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listInvites("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await listInvites(group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await listInvites(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/invitations`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/leave", () => {
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
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function postLeave(groupId: string, body: unknown, header = authHeader) {
    return app.request(`/v1/groups/${groupId}/leave`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("transitions an active member to left and writes a member.left audit entry", async () => {
    const group = await seedGroup();
    const { user, member } = await seedMember(group.id, "user_alice", "active");

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "left",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("left");
    expect(stored?.leftAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.action).toBe("member.left");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBe(user.id);
    expect(entry.payload).toMatchObject({ memberId: member.id, reason: "left" });
  });

  it("returns the member roles populated from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("is idempotent on an already-left member (no audit, leftAt unchanged)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "left");
    const originalLeftAt = new Date("2026-01-01T00:00:00Z");
    await prisma.groupMember.update({
      where: { id: member.id },
      data: { leftAt: originalLeftAt },
    });

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("left");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("left");
    expect(stored?.leftAt?.toISOString()).toBe(originalLeftAt.toISOString());
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("is idempotent on a kicked member (does not transition kicked to left)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "kicked");

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("kicked");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("kicked");
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await postLeave(group.id, { userId: "user_unknown" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postLeave("ckxxxxxxxxxxxxxxxxxxxxxxxx", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice", "active");
    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("rejects a body missing userId", async () => {
    const group = await seedGroup();
    const res = await postLeave(group.id, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/leave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_alice" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/members/:userId/kick", () => {
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
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function postKick(
    groupId: string,
    userId: string,
    body: unknown = undefined,
    header = authHeader,
  ) {
    return app.request(`/v1/groups/${groupId}/members/${userId}/kick`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("transitions an active member to kicked and writes a member.kicked audit entry with reason", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");

    const res = await postKick(group.id, "user_alice", { reason: "trolling" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "kicked",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("kicked");
    expect(stored?.leftAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.action).toBe("member.kicked");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({ memberId: member.id, reason: "trolling" });
  });

  it("stores reason as null when the body is omitted", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");

    const res = await postKick(group.id, "user_alice");
    expect(res.status).toBe(200);

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.payload).toMatchObject({ reason: null });
  });

  it("returns the member roles populated from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await postKick(group.id, "user_alice", { reason: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("is idempotent on an already-kicked member (no audit, leftAt unchanged)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "kicked");
    const originalLeftAt = new Date("2026-01-01T00:00:00Z");
    await prisma.groupMember.update({
      where: { id: member.id },
      data: { leftAt: originalLeftAt },
    });

    const res = await postKick(group.id, "user_alice", { reason: "again" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("kicked");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("kicked");
    expect(stored?.leftAt?.toISOString()).toBe(originalLeftAt.toISOString());
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("is idempotent on a left member (does not transition left to kicked)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "left");

    const res = await postKick(group.id, "user_alice", { reason: "late" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("left");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("left");
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await postKick(group.id, "user_alice", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await postKick(group.id, "user_unknown", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postKick("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice", "active");
    const res = await postKick(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postKick(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("rejects a reason longer than 500 characters", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");
    const res = await postKick(group.id, "user_alice", { reason: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice/kick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "weird/user", "active");

    const res = await postKick(group.id, "weird%2Fuser", { reason: "ok" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; status: string };
    expect(body.userId).toBe("weird/user");
    expect(body.status).toBe("kicked");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/members/:userId", () => {
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
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function getMember(groupId: string, userId: string, header = authHeader) {
    return app.request(`/v1/groups/${groupId}/members/${userId}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the active member with the dev's external user id", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");

    const res = await getMember(group.id, "user_alice");
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

  it("returns members in any status (left / kicked / invited)", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "left");
    const aliceRes = await getMember(group.id, "user_alice");
    expect(aliceRes.status).toBe(200);
    expect(((await aliceRes.json()) as { status: string }).status).toBe("left");

    await seedMember(group.id, "user_bob", "kicked");
    const bobRes = await getMember(group.id, "user_bob");
    expect(bobRes.status).toBe(200);
    expect(((await bobRes.json()) as { status: string }).status).toBe("kicked");
  });

  it("populates roles from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await getMember(group.id, "user_alice");
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await getMember(group.id, "user_unknown");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await getMember("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice", "active");
    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "weird/user", "active");
    const res = await getMember(group.id, "weird%2Fuser");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe("weird/user");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/members", () => {
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
    overrides: Partial<{
      status: "active" | "left" | "kicked" | "invited";
      joinedAt: Date;
    }> = {},
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: {
        groupId: groupIdValue,
        junjoUserId: user.id,
        status: overrides.status ?? "active",
        ...(overrides.joinedAt !== undefined ? { joinedAt: overrides.joinedAt } : {}),
      },
    });
    return { user, member };
  }

  function listMembers(groupId: string, query = "", header = authHeader) {
    return app.request(`/v1/groups/${groupId}/members${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty page for a group with no members", async () => {
    const group = await seedGroup();
    const res = await listMembers(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns members ordered by joinedAt desc with the dev's external user ids", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_old", {
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_mid", {
      joinedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_new", {
      joinedAt: new Date("2026-03-01T00:00:00Z"),
    });

    const res = await listMembers(group.id);
    const body = (await res.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(body.items.map((m) => m.userId)).toEqual(["user_new", "user_mid", "user_old"]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns members regardless of status (active, left, kicked)", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_active", {
      status: "active",
      joinedAt: new Date("2026-03-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_left", {
      status: "left",
      joinedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_kicked", {
      status: "kicked",
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await listMembers(group.id);
    const body = (await res.json()) as { items: Array<{ userId: string; status: string }> };
    expect(body.items).toHaveLength(3);
    expect(body.items.map((m) => m.status)).toEqual(["active", "left", "kicked"]);
  });

  it("populates roles via batched MemberRole lookup", async () => {
    const group = await seedGroup();
    const { member: alice } = await seedMember(group.id, "user_alice");
    const { member: bob } = await seedMember(group.id, "user_bob");
    const officer = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    const recruit = await prisma.role.create({
      data: { groupId: group.id, name: "recruit", priority: 10 },
    });
    await prisma.memberRole.createMany({
      data: [
        { groupMemberId: alice.id, roleId: officer.id },
        { groupMemberId: alice.id, roleId: recruit.id },
        { groupMemberId: bob.id, roleId: recruit.id },
      ],
    });

    const res = await listMembers(group.id);
    const body = (await res.json()) as { items: Array<{ id: string; roles: string[] }> };
    const aliceItem = body.items.find((i) => i.id === alice.id);
    const bobItem = body.items.find((i) => i.id === bob.id);
    if (!aliceItem || !bobItem) throw new Error("expected both items");
    expect(aliceItem.roles.sort()).toEqual([officer.id, recruit.id].sort());
    expect(bobItem.roles).toEqual([recruit.id]);
  });

  it("paginates with limit + cursor across pages", async () => {
    const group = await seedGroup();
    for (let i = 0; i < 5; i++) {
      await seedMember(group.id, `user_${i}`, {
        joinedAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }

    const first = await listMembers(group.id, "?limit=2");
    const fb = (await first.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(fb.items.map((m) => m.userId)).toEqual(["user_4", "user_3"]);
    expect(fb.nextCursor).not.toBeNull();

    const second = await listMembers(group.id, `?limit=2&cursor=${fb.nextCursor}`);
    const sb = (await second.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(sb.items.map((m) => m.userId)).toEqual(["user_2", "user_1"]);
    expect(sb.nextCursor).not.toBeNull();

    const third = await listMembers(group.id, `?limit=2&cursor=${sb.nextCursor}`);
    const tb = (await third.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(tb.items.map((m) => m.userId)).toEqual(["user_0"]);
    expect(tb.nextCursor).toBeNull();
  });

  it("rejects out-of-range limit", async () => {
    const group = await seedGroup();
    const tooHigh = await listMembers(group.id, "?limit=101");
    expect(tooHigh.status).toBe(400);
    const tooLow = await listMembers(group.id, "?limit=0");
    expect(tooLow.status).toBe(400);
  });

  it("rejects an unknown cursor", async () => {
    const group = await seedGroup();
    const res = await listMembers(group.id, "?cursor=ckunknownxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(400);
  });

  it("rejects a cursor pointing at a member of a different group", async () => {
    const group = await seedGroup();
    const other = await seedGroup();
    const { member: otherMember } = await seedMember(other.id, "user_x");
    const res = await listMembers(group.id, `?cursor=${otherMember.id}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listMembers("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await listMembers(group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await listMembers(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/members`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
