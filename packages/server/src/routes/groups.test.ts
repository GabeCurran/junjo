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
