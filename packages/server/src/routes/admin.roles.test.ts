import type { GroupId, RoleId } from "@junjo/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminRole` from `routes/admin.ts` (the admin
// route returns the same shape; the dashboard's `lib/admin.ts` will mirror
// it byte-for-byte in 11.6b). Tests assert against this shape so a drift on
// the route side surfaces as a typed test failure.
type WireAdminRole = {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  createdAt: string;
};

async function seedGroup(
  prisma: PrismaClient,
  gameName: string,
  groupName: string,
  options: { softDeletedGroup?: boolean } = {},
) {
  const game = await createGame(gameName, prisma);
  const group = await prisma.group.create({
    data: {
      gameId: game.id,
      kind: "guild",
      name: groupName,
      visibility: "invite-only",
      softDeletedAt: options.softDeletedGroup ? new Date() : null,
    },
  });
  return { gameId: game.id, groupId: group.id };
}

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/groups/:groupId/roles", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "RolePermission", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function listFetch(gameId: string, groupId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/roles`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty array when the group has no roles", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await listFetch(seed.gameId, seed.groupId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminRole[];
    expect(body).toEqual([]);
  });

  it("returns roles sorted by priority desc, id desc with permissions populated", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const officer = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100, color: "#aabbcc" },
    });
    const member = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Member", priority: 0 },
    });
    const veteran = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Veteran", priority: 50 },
    });
    await prisma.rolePermission.createMany({
      data: [
        { roleId: officer.id, permissionKey: "guild.invite_member" },
        { roleId: officer.id, permissionKey: "guild.kick_member" },
        { roleId: veteran.id, permissionKey: "guild.invite_member" },
      ],
    });
    const res = await listFetch(seed.gameId, seed.groupId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminRole[];
    expect(body.map((r) => r.name)).toEqual(["Officer", "Veteran", "Member"]);
    expect(body[0]?.permissions).toEqual(["guild.invite_member", "guild.kick_member"]);
    expect(body[1]?.permissions).toEqual(["guild.invite_member"]);
    expect(body[2]?.permissions).toEqual([]);
    expect(body[0]?.id).toBe(officer.id);
    expect(body[0]?.color).toBe("#aabbcc");
    expect(body[2]?.color).toBeNull();
    expect(body[0]?.isDefault).toBe(false);
    expect(typeof body[0]?.createdAt).toBe("string");
  });

  it("returns 404 for an unknown group", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "grp_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a soft-deleted group", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1", { softDeletedGroup: true });
    const res = await listFetch(seed.gameId, seed.groupId);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a cross-game group", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const otherGame = await createGame("Beta", prisma);
    const res = await listFetch(otherGame.id, seed.groupId);
    expect(res.status).toBe(404);
  });

  it("returns 401 without an Authorization header", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await app.request(`/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/roles`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong admin token", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await listFetch(seed.gameId, seed.groupId, "Bearer wrong");
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/admin/games/:gameId/groups/:groupId/roles", () => {
  let prisma: PrismaClient;
  let hub: EventHub;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    hub = new EventHub();
    app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
  });

  beforeEach(async () => {
    hub.clear();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "RolePermission", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function createFetch(
    gameId: string,
    groupId: string,
    body: unknown,
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    const init: RequestInit & { headers: Record<string, string> } = {
      method: "POST",
      headers: { authorization: header },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/roles`, init);
  }

  it("creates a role, returns 201, and writes a role.created audit entry", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, {
      name: "Officer",
      priority: 100,
      color: "#aabbcc",
      isDefault: false,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireAdminRole;
    expect(body.groupId).toBe(seed.groupId);
    expect(body.name).toBe("Officer");
    expect(body.priority).toBe(100);
    expect(body.color).toBe("#aabbcc");
    expect(body.isDefault).toBe(false);
    expect(body.permissions).toEqual([]);
    expect(typeof body.id).toBe("string");

    const stored = await prisma.role.findUnique({ where: { id: body.id } });
    expect(stored).not.toBeNull();
    expect(stored?.name).toBe("Officer");
    expect(stored?.priority).toBe(100);
    expect(stored?.color).toBe("#aabbcc");

    const audit = await prisma.auditEntry.findFirst({
      where: { groupId: seed.groupId, action: "role.created" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.targetId).toBe(body.id);
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.payload).toEqual({
      name: "Officer",
      priority: 100,
      color: "#aabbcc",
      isDefault: false,
    });
  });

  it("defaults color to null and isDefault to false when omitted", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, {
      name: "Member",
      priority: 0,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireAdminRole;
    expect(body.color).toBeNull();
    expect(body.isDefault).toBe(false);
  });

  it("dispatches a role.created JunjoEvent", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const events: unknown[] = [];
    const unsubscribe = hub.subscribe(seed.groupId as GroupId, (e) => events.push(e));
    try {
      await createFetch(seed.gameId, seed.groupId, { name: "Officer", priority: 100 });
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; gameId: string; groupId: string };
    expect(event.type).toBe("role.created");
    expect(event.gameId).toBe(seed.gameId);
    expect(event.groupId).toBe(seed.groupId);
  });

  it("rejects a duplicate name within the same group with 409 role_name_taken", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await createFetch(seed.gameId, seed.groupId, { name: "Officer", priority: 50 });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("role_name_taken");
    const count = await prisma.role.count({ where: { groupId: seed.groupId } });
    expect(count).toBe(1);
  });

  it("allows the same name across different groups", async () => {
    const game = await createGame("Alpha", prisma);
    const groupA = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const groupB = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g2", visibility: "invite-only" },
    });
    await prisma.role.create({
      data: { groupId: groupA.id, name: "Officer", priority: 100 },
    });
    const res = await createFetch(game.id, groupB.id, { name: "Officer", priority: 100 });
    expect(res.status).toBe(201);
  });

  it("rejects a missing name with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, { priority: 100 });
    expect(res.status).toBe(400);
  });

  it("rejects an empty name with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, { name: "", priority: 100 });
    expect(res.status).toBe(400);
  });

  it("rejects a non-int priority with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, { name: "X", priority: 1.5 });
    expect(res.status).toBe(400);
  });

  it("rejects an invalid hex color with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, {
      name: "X",
      priority: 0,
      color: "red",
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await createFetch(seed.gameId, seed.groupId, "{not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown group with no row created", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await createFetch(game.id, "grp_missing", { name: "X", priority: 0 });
    expect(res.status).toBe(404);
    const count = await prisma.role.count();
    expect(count).toBe(0);
  });

  it("returns 404 for a soft-deleted group with no row created", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1", { softDeletedGroup: true });
    const res = await createFetch(seed.gameId, seed.groupId, { name: "X", priority: 0 });
    expect(res.status).toBe(404);
    const count = await prisma.role.count();
    expect(count).toBe(0);
  });

  it("returns 404 for a cross-game group with no row created", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const otherGame = await createGame("Beta", prisma);
    const res = await createFetch(otherGame.id, seed.groupId, { name: "X", priority: 0 });
    expect(res.status).toBe(404);
    const count = await prisma.role.count();
    expect(count).toBe(0);
  });

  it("returns 401 without an Authorization header", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const res = await app.request(`/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "X", priority: 0 }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PATCH /v1/admin/games/:gameId/roles/:roleId", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "RolePermission", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function patchFetch(
    gameId: string,
    roleId: string,
    body: unknown,
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    const init: RequestInit & { headers: Record<string, string> } = {
      method: "PATCH",
      headers: { authorization: header },
    };
    if (body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    return app.request(`/v1/admin/games/${gameId}/roles/${roleId}`, init);
  }

  it("updates a single field, returns the role, and writes role.updated audit", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await patchFetch(seed.gameId, role.id, { priority: 200 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminRole;
    expect(body.priority).toBe(200);
    expect(body.name).toBe("Officer");

    const audit = await prisma.auditEntry.findFirst({
      where: { groupId: seed.groupId, action: "role.updated" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.targetId).toBe(role.id);
    expect(audit?.payload).toEqual({
      before: { priority: 100 },
      after: { priority: 200 },
    });
  });

  it("clears color when null is sent", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100, color: "#aabbcc" },
    });
    const res = await patchFetch(seed.gameId, role.id, { color: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminRole;
    expect(body.color).toBeNull();
    const audit = await prisma.auditEntry.findFirst({
      where: { groupId: seed.groupId, action: "role.updated" },
    });
    expect(audit?.payload).toEqual({
      before: { color: "#aabbcc" },
      after: { color: null },
    });
  });

  it("audits only the changed fields when multiple supplied", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100, color: "#aabbcc" },
    });
    const res = await patchFetch(seed.gameId, role.id, {
      name: "Officer",
      priority: 200,
      color: "#aabbcc",
      isDefault: true,
    });
    expect(res.status).toBe(200);
    const audit = await prisma.auditEntry.findFirst({
      where: { groupId: seed.groupId, action: "role.updated" },
    });
    expect(audit?.payload).toEqual({
      before: { priority: 100, isDefault: false },
      after: { priority: 200, isDefault: true },
    });
  });

  it("writes no audit and does not bump on a fully no-op PATCH", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100, color: "#aabbcc" },
    });
    const res = await patchFetch(seed.gameId, role.id, {
      name: "Officer",
      priority: 100,
      color: "#aabbcc",
      isDefault: false,
    });
    expect(res.status).toBe(200);
    const audits = await prisma.auditEntry.findMany({
      where: { groupId: seed.groupId, action: "role.updated" },
    });
    expect(audits).toHaveLength(0);
  });

  it("rejects rename collision with 409 role_name_taken and rolls back", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const member = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Member", priority: 0 },
    });
    const res = await patchFetch(seed.gameId, member.id, { name: "Officer" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("role_name_taken");
    const stored = await prisma.role.findUnique({ where: { id: member.id } });
    expect(stored?.name).toBe("Member");
  });

  it("rejects empty body with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await patchFetch(seed.gameId, role.id, {});
    expect(res.status).toBe(400);
  });

  it("rejects an invalid hex color with 400", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await patchFetch(seed.gameId, role.id, { color: "red" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown role", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await patchFetch(game.id, "role_missing", { priority: 1 });
    expect(res.status).toBe(404);
  });

  it("returns 404 for a cross-game role", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const otherGame = await createGame("Beta", prisma);
    const res = await patchFetch(otherGame.id, role.id, { priority: 200 });
    expect(res.status).toBe(404);
    const stored = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stored?.priority).toBe(100);
  });

  it("returns 404 for a role whose group is soft-deleted", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1", { softDeletedGroup: true });
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await patchFetch(seed.gameId, role.id, { priority: 200 });
    expect(res.status).toBe(404);
  });

  it("populates permissions on the response", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionKey: "guild.invite_member" },
    });
    const res = await patchFetch(seed.gameId, role.id, { priority: 200 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminRole;
    expect(body.permissions).toEqual(["guild.invite_member"]);
  });

  it("returns 401 without an Authorization header", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await app.request(`/v1/admin/games/${seed.gameId}/roles/${role.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ priority: 1 }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/admin/games/:gameId/roles/:roleId", () => {
  let prisma: PrismaClient;
  let hub: EventHub;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    hub = new EventHub();
    app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
  });

  beforeEach(async () => {
    hub.clear();
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "RolePermission", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function deleteFetch(gameId: string, roleId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/roles/${roleId}`, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  it("hard-deletes the role, returns 204, and writes role.deleted audit", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: {
        groupId: seed.groupId,
        name: "Officer",
        priority: 100,
        color: "#aabbcc",
        isDefault: true,
      },
    });
    const res = await deleteFetch(seed.gameId, role.id);
    expect(res.status).toBe(204);

    const stored = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stored).toBeNull();

    const audit = await prisma.auditEntry.findFirst({
      where: { groupId: seed.groupId, action: "role.deleted" },
    });
    expect(audit).not.toBeNull();
    expect(audit?.targetId).toBe(role.id);
    expect(audit?.payload).toEqual({
      name: "Officer",
      priority: 100,
      color: "#aabbcc",
      isDefault: true,
    });
  });

  it("dispatches a role.deleted JunjoEvent", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const events: unknown[] = [];
    const unsubscribe = hub.subscribe(seed.groupId as GroupId, (e) => events.push(e));
    try {
      await deleteFetch(seed.gameId, role.id);
    } finally {
      unsubscribe();
    }
    expect(events).toHaveLength(1);
    const event = events[0] as { type: string; gameId: string; groupId: string; roleId: string };
    expect(event.type).toBe("role.deleted");
    expect(event.gameId).toBe(seed.gameId);
    expect(event.groupId).toBe(seed.groupId);
    expect(event.roleId).toBe(role.id as RoleId);
  });

  it("rejects with 409 role_has_members when the role has assignments", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const user = await prisma.junjoUser.create({ data: {} });
    const member = await prisma.groupMember.create({
      data: { groupId: seed.groupId, junjoUserId: user.id, status: "active" },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });
    const res = await deleteFetch(seed.gameId, role.id);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("role_has_members");
    const stored = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stored).not.toBeNull();
  });

  it("returns 404 for an unknown role", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await deleteFetch(game.id, "role_missing");
    expect(res.status).toBe(404);
  });

  it("returns 404 for a cross-game role with the row preserved", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const otherGame = await createGame("Beta", prisma);
    const res = await deleteFetch(otherGame.id, role.id);
    expect(res.status).toBe(404);
    const stored = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stored).not.toBeNull();
  });

  it("returns 404 for a role whose group is soft-deleted", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1", { softDeletedGroup: true });
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await deleteFetch(seed.gameId, role.id);
    expect(res.status).toBe(404);
  });

  it("returns 401 without an Authorization header", async () => {
    const seed = await seedGroup(prisma, "Alpha", "g1");
    const role = await prisma.role.create({
      data: { groupId: seed.groupId, name: "Officer", priority: 100 },
    });
    const res = await app.request(`/v1/admin/games/${seed.gameId}/roles/${role.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });
});
