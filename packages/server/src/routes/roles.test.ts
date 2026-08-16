import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "MemberRole", "RolePermission", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/roles", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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

  describe("paged=true", () => {
    function listRolesPaged(groupId: string, value = "true", header = authHeader) {
      return app.request(`/v1/groups/${groupId}/roles?paged=${value}`, {
        method: "GET",
        headers: { authorization: header },
      });
    }

    it("wraps the roles in a page envelope", async () => {
      const group = await seedGroup();
      await prisma.role.create({ data: { groupId: group.id, name: "Officer", priority: 80 } });

      const res = await listRolesPaged(group.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{ name: string }>;
        nextCursor: string | null;
      };
      expect(body.items.map((r) => r.name)).toEqual(["Officer"]);
      // The route returns every role; it does not paginate.
      expect(body.nextCursor).toBeNull();
    });

    it("returns an empty page when the group has no roles", async () => {
      const group = await seedGroup();
      const res = await listRolesPaged(group.id);
      expect(await res.json()).toEqual({ items: [], nextCursor: null });
    });

    it("carries the same items in the same order as the bare array", async () => {
      const group = await seedGroup();
      await prisma.role.create({ data: { groupId: group.id, name: "Officer", priority: 80 } });
      await prisma.role.create({ data: { groupId: group.id, name: "Member", priority: 10 } });

      const bare = (await (await listRoles(group.id)).json()) as unknown[];
      const paged = (await (await listRolesPaged(group.id)).json()) as { items: unknown[] };
      expect(paged.items).toEqual(bare);
    });

    it("keeps the bare array as the default so published clients are unaffected", async () => {
      const group = await seedGroup();
      await prisma.role.create({ data: { groupId: group.id, name: "Officer", priority: 80 } });

      expect(Array.isArray(await (await listRoles(group.id)).json())).toBe(true);
      expect(Array.isArray(await (await listRolesPaged(group.id, "false")).json())).toBe(true);
    });

    it("rejects a non-boolean paged value", async () => {
      const group = await seedGroup();
      const res = await listRolesPaged(group.id, "yes");
      expect(res.status).toBe(400);
    });

    it("still 404s an unknown group", async () => {
      const res = await listRolesPaged("grp_missing");
      expect(res.status).toBe(404);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/roles/:id", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/roles/:id/permissions", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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
      data: { groupId: group.id, name: "Officer", priority: 80 },
    });
    return { group, role };
  }

  function grant(id: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/roles/${id}/permissions`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a RolePermission row and returns the role with the permission attached", async () => {
    const { role } = await seedRoleInGame();
    const res = await grant(role.id, { permission: "invite_member" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; permissions: string[] };
    expect(body.id).toBe(role.id);
    expect(body.permissions).toEqual(["invite_member"]);

    const stored = await prisma.rolePermission.findUnique({
      where: {
        roleId_permissionKey: { roleId: role.id, permissionKey: "invite_member" },
      },
    });
    expect(stored).not.toBeNull();
  });

  it("auto-registers the permission key into PermissionDef on first sight per game", async () => {
    const { role } = await seedRoleInGame();
    const before = await prisma.permissionDef.findMany({ where: { gameId } });
    expect(before).toHaveLength(0);

    await grant(role.id, { permission: "invite_member" });

    const after = await prisma.permissionDef.findMany({ where: { gameId } });
    expect(after).toHaveLength(1);
    expect(after[0]?.key).toBe("invite_member");
  });

  it("does not duplicate the PermissionDef row across multiple grants of the same key", async () => {
    const { role } = await seedRoleInGame();
    const second = await prisma.role.create({
      data: { groupId: role.groupId, name: "Captain", priority: 50 },
    });

    await grant(role.id, { permission: "invite_member" });
    await grant(second.id, { permission: "invite_member" });

    const defs = await prisma.permissionDef.findMany({ where: { gameId } });
    expect(defs).toHaveLength(1);
  });

  it("writes a permission.granted audit entry per call", async () => {
    const { group, role } = await seedRoleInGame();
    await grant(role.id, { permission: "kick_member" });

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "permission.granted" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(role.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({ roleId: role.id, permission: "kick_member" });
  });

  it("is idempotent on already-granted permission (no second audit entry, no extra rows)", async () => {
    const { role } = await seedRoleInGame();

    const first = await grant(role.id, { permission: "invite_member" });
    expect(first.status).toBe(200);
    const second = await grant(role.id, { permission: "invite_member" });
    expect(second.status).toBe(200);

    const body = (await second.json()) as { permissions: string[] };
    expect(body.permissions).toEqual(["invite_member"]);

    const rows = await prisma.rolePermission.findMany({ where: { roleId: role.id } });
    expect(rows).toHaveLength(1);

    const entries = await prisma.auditEntry.findMany({
      where: { action: "permission.granted" },
    });
    expect(entries).toHaveLength(1);
  });

  it("returns the full permissions list (multiple distinct keys)", async () => {
    const { role } = await seedRoleInGame();
    await grant(role.id, { permission: "invite_member" });
    const res = await grant(role.id, { permission: "kick_member" });
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions.sort()).toEqual(["invite_member", "kick_member"]);
  });

  it("rejects an empty permission key", async () => {
    const { role } = await seedRoleInGame();
    const res = await grant(role.id, { permission: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a permission key over the length cap", async () => {
    const { role } = await seedRoleInGame();
    const res = await grant(role.id, { permission: "x".repeat(129) });
    expect(res.status).toBe(400);
  });

  it("rejects a missing permission field", async () => {
    const { role } = await seedRoleInGame();
    const res = await grant(role.id, {});
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const { role } = await seedRoleInGame();
    const res = await grant(role.id, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the role does not exist", async () => {
    const res = await grant("ckxxxxxxxxxxxxxxxxxxxxxxxx", { permission: "invite_member" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role's group is soft-deleted", async () => {
    const { role } = await seedRoleInGame(gameId, new Date());
    const res = await grant(role.id, { permission: "invite_member" });
    expect(res.status).toBe(404);
    const stored = await prisma.rolePermission.findUnique({
      where: {
        roleId_permissionKey: { roleId: role.id, permissionKey: "invite_member" },
      },
    });
    expect(stored).toBeNull();
  });

  it("returns 404 when the role belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const { role } = await seedRoleInGame(otherGame.id);
    const res = await grant(role.id, { permission: "invite_member" });
    expect(res.status).toBe(404);

    const defs = await prisma.permissionDef.findMany({ where: { gameId: otherGame.id } });
    expect(defs).toHaveLength(0);
  });

  it("rejects requests without an API key", async () => {
    const { role } = await seedRoleInGame();
    const res = await app.request(`/v1/roles/${role.id}/permissions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ permission: "invite_member" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/roles/:id/permissions/:permission", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedRoleWithPermissions(
    keys: string[] = [],
    targetGameId: string = gameId,
    softDeletedAt: Date | null = null,
  ) {
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
      data: { groupId: group.id, name: "Officer", priority: 80 },
    });
    if (keys.length > 0) {
      await prisma.rolePermission.createMany({
        data: keys.map((k) => ({ roleId: role.id, permissionKey: k })),
      });
      await prisma.permissionDef.createMany({
        data: keys.map((k) => ({ gameId: targetGameId, key: k })),
      });
    }
    return { group, role };
  }

  function revoke(id: string, permission: string, header = authHeader) {
    return app.request(`/v1/roles/${id}/permissions/${encodeURIComponent(permission)}`, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  it("deletes the RolePermission row and returns the role with the permission removed", async () => {
    const { role } = await seedRoleWithPermissions(["invite_member", "kick_member"]);
    const res = await revoke(role.id, "invite_member");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toEqual(["kick_member"]);

    const stored = await prisma.rolePermission.findUnique({
      where: {
        roleId_permissionKey: { roleId: role.id, permissionKey: "invite_member" },
      },
    });
    expect(stored).toBeNull();
  });

  it("writes a permission.revoked audit entry per call", async () => {
    const { group, role } = await seedRoleWithPermissions(["kick_member"]);
    await revoke(role.id, "kick_member");

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "permission.revoked" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(role.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({ roleId: role.id, permission: "kick_member" });
  });

  it("preserves PermissionDef when revoking", async () => {
    const { role } = await seedRoleWithPermissions(["invite_member"]);
    await revoke(role.id, "invite_member");
    const defs = await prisma.permissionDef.findMany({ where: { gameId } });
    expect(defs).toHaveLength(1);
    expect(defs[0]?.key).toBe("invite_member");
  });

  it("is a no-op when the role does not have the permission (no audit entry)", async () => {
    const { role } = await seedRoleWithPermissions(["kick_member"]);
    const res = await revoke(role.id, "invite_member");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toEqual(["kick_member"]);

    const entries = await prisma.auditEntry.findMany({
      where: { action: "permission.revoked" },
    });
    expect(entries).toHaveLength(0);
  });

  it("is a no-op when the permission key is not registered at all", async () => {
    const { role } = await seedRoleWithPermissions([]);
    const res = await revoke(role.id, "never_seen");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toEqual([]);

    const entries = await prisma.auditEntry.findMany({
      where: { action: "permission.revoked" },
    });
    expect(entries).toHaveLength(0);
  });

  it("returns 404 when the role does not exist", async () => {
    const res = await revoke("ckxxxxxxxxxxxxxxxxxxxxxxxx", "invite_member");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the role's group is soft-deleted", async () => {
    const { role } = await seedRoleWithPermissions(["invite_member"], gameId, new Date());
    const res = await revoke(role.id, "invite_member");
    expect(res.status).toBe(404);
    const stored = await prisma.rolePermission.findUnique({
      where: {
        roleId_permissionKey: { roleId: role.id, permissionKey: "invite_member" },
      },
    });
    expect(stored).not.toBeNull();
  });

  it("returns 404 when the role belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const { role } = await seedRoleWithPermissions(["invite_member"], otherGame.id);
    const res = await revoke(role.id, "invite_member");
    expect(res.status).toBe(404);
    const stored = await prisma.rolePermission.findUnique({
      where: {
        roleId_permissionKey: { roleId: role.id, permissionKey: "invite_member" },
      },
    });
    expect(stored).not.toBeNull();
  });

  it("URL-decodes the permission path parameter", async () => {
    const { role } = await seedRoleWithPermissions(["scope/with-slash"]);
    const res = await app.request(
      `/v1/roles/${role.id}/permissions/${encodeURIComponent("scope/with-slash")}`,
      { method: "DELETE", headers: { authorization: authHeader } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { permissions: string[] };
    expect(body.permissions).toEqual([]);
  });

  it("rejects requests without an API key", async () => {
    const { role } = await seedRoleWithPermissions(["invite_member"]);
    const res = await app.request(`/v1/roles/${role.id}/permissions/invite_member`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
