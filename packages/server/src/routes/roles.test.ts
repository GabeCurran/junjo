import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "MemberRole", "RolePermission", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/roles", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
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

  function postRole(groupId: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${groupId}/roles`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a role with the required fields and applies defaults", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, { name: "Officer", priority: 80 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      groupId: group.id,
      name: "Officer",
      priority: 80,
      color: null,
      isDefault: false,
      permissions: [],
    });
    expect(typeof body.id).toBe("string");
    expect(body.id).toMatch(/^c[a-z0-9]+/);
    expect(typeof body.createdAt).toBe("string");
    const stored = await prisma.role.findUnique({ where: { id: body.id as string } });
    expect(stored?.groupId).toBe(group.id);
  });

  it("preserves provided color and isDefault", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, {
      name: "Member",
      priority: 10,
      color: "#ff5050",
      isDefault: true,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.color).toBe("#ff5050");
    expect(body.isDefault).toBe(true);
  });

  it("writes a role.created audit entry per call", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, {
      name: "Captain",
      priority: 50,
      color: "#00aabb",
      isDefault: true,
    });
    const body = (await res.json()) as { id: string };
    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("role.created");
    expect(entry.targetId).toBe(body.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      name: "Captain",
      priority: 50,
      color: "#00aabb",
      isDefault: true,
    });
  });

  it("returns 409 role_name_taken on duplicate name within the same group", async () => {
    const group = await seedGroup();
    const first = await postRole(group.id, { name: "Officer", priority: 80 });
    expect(first.status).toBe(201);
    const second = await postRole(group.id, { name: "Officer", priority: 50 });
    expect(second.status).toBe(409);
    const body = (await second.json()) as { code: string };
    expect(body.code).toBe("role_name_taken");
    const count = await prisma.role.count({ where: { groupId: group.id } });
    expect(count).toBe(1);
  });

  it("allows the same role name across different groups", async () => {
    const groupA = await seedGroup();
    const groupB = await prisma.group.create({
      data: { gameId, kind: "guild", name: "Iron Hand", visibility: "invite-only", metadata: {} },
    });
    const a = await postRole(groupA.id, { name: "Officer", priority: 80 });
    const b = await postRole(groupB.id, { name: "Officer", priority: 80 });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it("rejects a body missing required fields", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, { name: "Officer" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects an empty name", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, { name: "", priority: 10 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-integer priority", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, { name: "Member", priority: 1.5 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid color", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, { name: "Member", priority: 10, color: "red" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const group = await seedGroup();
    const res = await postRole(group.id, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postRole("ckxxxxxxxxxxxxxxxxxxxxxxxx", { name: "Officer", priority: 80 });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await postRole(group.id, { name: "Officer", priority: 80 });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await prisma.group.create({
      data: {
        gameId: otherGame.id,
        kind: "guild",
        name: "Outsider",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const res = await postRole(otherGroup.id, { name: "Officer", priority: 80 });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Officer", priority: 80 }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/roles", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup() {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
      },
    });
  }

  function listRoles(groupId: string, header = authHeader) {
    return app.request(`/v1/groups/${groupId}/roles`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty array when the group has no roles", async () => {
    const group = await seedGroup();
    const res = await listRoles(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("orders roles by priority desc with id desc tiebreaker", async () => {
    const group = await seedGroup();
    const high = await prisma.role.create({
      data: { groupId: group.id, name: "GM", priority: 100 },
    });
    const mid = await prisma.role.create({
      data: { groupId: group.id, name: "Officer", priority: 80 },
    });
    const low = await prisma.role.create({
      data: { groupId: group.id, name: "Recruit", priority: 10 },
    });

    const res = await listRoles(group.id);
    const body = (await res.json()) as Array<{ id: string }>;
    expect(body.map((r) => r.id)).toEqual([high.id, mid.id, low.id]);
  });

  it("populates permissions from RolePermission rows", async () => {
    const group = await seedGroup();
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "Officer", priority: 80 },
    });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionKey: "invite_member" },
        { roleId: role.id, permissionKey: "kick_member" },
      ],
    });

    const res = await listRoles(group.id);
    const body = (await res.json()) as Array<{ permissions: string[] }>;
    expect(body[0]?.permissions).toEqual(["invite_member", "kick_member"]);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listRoles("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Gone",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: new Date(),
      },
    });
    const res = await listRoles(group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await prisma.group.create({
      data: {
        gameId: otherGame.id,
        kind: "guild",
        name: "Outsider",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const res = await listRoles(otherGroup.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/roles`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/roles/:id", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRoleInGame(targetGameId: string = gameId, softDeletedAt: Date | null = null) {
    const group = await prisma.group.create({
      data: {
        gameId: targetGameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt,
      },
    });
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "Officer", priority: 80, color: "#ff5050" },
    });
    return { group, role };
  }

  function getRole(id: string, header = authHeader) {
    return app.request(`/v1/roles/${id}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the role when it exists in the calling game", async () => {
    const { group, role } = await seedRoleInGame();
    const res = await getRole(role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: role.id,
      groupId: group.id,
      name: "Officer",
      priority: 80,
      color: "#ff5050",
      isDefault: false,
      permissions: [],
    });
  });

  it("populates permissions from RolePermission rows", async () => {
    const { role } = await seedRoleInGame();
    await prisma.rolePermission.createMany({
      data: [
        { roleId: role.id, permissionKey: "kick_member" },
        { roleId: role.id, permissionKey: "invite_member" },
      ],
    });
    const res = await getRole(role.id);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toEqual(["invite_member", "kick_member"]);
  });

  it("returns 404 when the role does not exist", async () => {
    const res = await getRole("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role's group is soft-deleted", async () => {
    const { role } = await seedRoleInGame(gameId, new Date());
    const res = await getRole(role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const { role } = await seedRoleInGame(otherGame.id);
    const res = await getRole(role.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const { role } = await seedRoleInGame();
    const res = await app.request(`/v1/roles/${role.id}`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PATCH /v1/roles/:id", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRole() {
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "Officer", priority: 80, color: "#ff5050" },
    });
    return { group, role };
  }

  function patchRole(id: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/roles/${id}`, {
      method: "PATCH",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("updates the supplied fields and returns the new row", async () => {
    const { role } = await seedRole();
    const res = await patchRole(role.id, { name: "Captain", priority: 90 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Captain", priority: 90, color: "#ff5050" });
  });

  it("clears color when null is supplied", async () => {
    const { role } = await seedRole();
    const res = await patchRole(role.id, { color: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { color: string | null };
    expect(body.color).toBeNull();
  });

  it("writes a role.updated audit entry with only the changed fields", async () => {
    const { group, role } = await seedRole();
    await patchRole(role.id, { name: "Captain" });
    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "role.updated" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(role.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      before: { name: "Officer" },
      after: { name: "Captain" },
    });
  });

  it("writes no audit entry on a no-op PATCH", async () => {
    const { role } = await seedRole();
    const res = await patchRole(role.id, { name: "Officer", priority: 80 });
    expect(res.status).toBe(200);
    const entries = await prisma.auditEntry.findMany({
      where: { action: "role.updated" },
    });
    expect(entries).toHaveLength(0);
  });

  it("returns 409 role_name_taken when renaming to an existing name in the same group", async () => {
    const { group, role } = await seedRole();
    await prisma.role.create({
      data: { groupId: group.id, name: "Captain", priority: 60 },
    });
    const res = await patchRole(role.id, { name: "Captain" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("role_name_taken");
  });

  it("rejects an empty body", async () => {
    const { role } = await seedRole();
    const res = await patchRole(role.id, {});
    expect(res.status).toBe(400);
  });

  it("rejects an invalid color", async () => {
    const { role } = await seedRole();
    const res = await patchRole(role.id, { color: "red" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the role does not exist", async () => {
    const res = await patchRole("ckxxxxxxxxxxxxxxxxxxxxxxxx", { name: "X" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await prisma.group.create({
      data: {
        gameId: otherGame.id,
        kind: "guild",
        name: "Outsider",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const otherRole = await prisma.role.create({
      data: { groupId: otherGroup.id, name: "Officer", priority: 80 },
    });
    const res = await patchRole(otherRole.id, { name: "Captain" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const { role } = await seedRole();
    const res = await app.request(`/v1/roles/${role.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/roles/:id", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedRole() {
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "Officer", priority: 80 },
    });
    return { group, role };
  }

  function deleteRole(id: string, header = authHeader) {
    return app.request(`/v1/roles/${id}`, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  it("deletes the role and writes a role.deleted audit entry", async () => {
    const { group, role } = await seedRole();
    const res = await deleteRole(role.id);
    expect(res.status).toBe(204);
    const stored = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stored).toBeNull();

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "role.deleted" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(role.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      name: "Officer",
      priority: 80,
      color: null,
      isDefault: false,
    });
  });

  it("returns 409 role_has_members when the role has assignments", async () => {
    const { group, role } = await seedRole();
    const user = await prisma.junjoUser.create({ data: {} });
    const member = await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: user.id, status: "active" },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await deleteRole(role.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("role_has_members");
    const stored = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stored).not.toBeNull();
  });

  it("returns 404 when the role does not exist", async () => {
    const res = await deleteRole("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role's group is soft-deleted", async () => {
    const { group, role } = await seedRole();
    await prisma.group.update({
      where: { id: group.id },
      data: { softDeletedAt: new Date() },
    });
    const res = await deleteRole(role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await prisma.group.create({
      data: {
        gameId: otherGame.id,
        kind: "guild",
        name: "Outsider",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const otherRole = await prisma.role.create({
      data: { groupId: otherGroup.id, name: "Officer", priority: 80 },
    });
    const res = await deleteRole(otherRole.id);
    expect(res.status).toBe(404);
    const stored = await prisma.role.findUnique({ where: { id: otherRole.id } });
    expect(stored).not.toBeNull();
  });

  it("rejects requests without an API key", async () => {
    const { role } = await seedRole();
    const res = await app.request(`/v1/roles/${role.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});
