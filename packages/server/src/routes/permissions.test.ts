import { type Group, PrismaClient, type Role } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "MemberRole", "RolePermission", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/permissions/check", () => {
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
    permissionCache.clear();
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {},
  ): Promise<Group> {
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

  async function seedActiveMember(groupId: string, externalUserId: string) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId, junjoUserId: user.id, status: "active" },
    });
    return { user, member };
  }

  async function seedRole(
    groupId: string,
    priority: number,
    name = `Role-${priority}`,
  ): Promise<Role> {
    return prisma.role.create({
      data: { groupId, name, priority },
    });
  }

  function checkPermission(
    params: { userId: string; groupId: string; permission: string },
    header: string = authHeader,
  ) {
    const qs = new URLSearchParams(params).toString();
    return app.request(`/v1/permissions/check?${qs}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns allowed=false source=none when the user has no ExternalIdentity", async () => {
    const group = await seedGroup();
    const res = await checkPermission({
      userId: "user_unknown",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, source: "none" });
  });

  it("returns allowed=false source=none when the user is not a member of the group", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, source: "none" });
  });

  it("returns allowed=false source=none when the member is not active (left)", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: user.id, status: "left" },
    });
    const role = await seedRole(group.id, 50);
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, source: "none" });
  });

  it("returns allowed=false source=default when active member has no roles or overrides", async () => {
    const group = await seedGroup();
    await seedActiveMember(group.id, "user_alice");

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, source: "default" });
  });

  it("returns allowed=true source=role with viaRoleId when a role grants the permission", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const role = await seedRole(group.id, 50, "Officer");
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      allowed: true,
      source: "role",
      viaRoleId: role.id,
    });
  });

  it("picks the highest-priority role when multiple roles grant the permission", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const lowRole = await seedRole(group.id, 10, "Member");
    const highRole = await seedRole(group.id, 90, "Captain");
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: lowRole.id } });
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: highRole.id } });
    await prisma.rolePermission.create({
      data: { roleId: lowRole.id, permissionKey: "guild.kick" },
    });
    await prisma.rolePermission.create({
      data: { roleId: highRole.id, permissionKey: "guild.kick" },
    });

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    const body = (await res.json()) as { viaRoleId: string };
    expect(body.viaRoleId).toBe(highRole.id);
  });

  it("returns source=default when the member's roles do not grant this permission", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const role = await seedRole(group.id, 50);
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionKey: "guild.invite_member" },
    });

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await res.json()).toEqual({ allowed: false, source: "default" });
  });

  it("override grant beats role-derived absence (allowed=true source=override)", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "guild.kick", grant: true },
    });

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await res.json()).toEqual({ allowed: true, source: "override" });
  });

  it("override revoke beats role-derived grant (allowed=false source=override)", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const role = await seedRole(group.id, 90);
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "guild.kick", grant: false },
    });

    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await res.json()).toEqual({ allowed: false, source: "override" });
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await checkPermission({
      userId: "user_alice",
      groupId: "ckxxxxxxxxxxxxxxxxxxxxxxxx",
      permission: "guild.kick",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await seedGroup({ gameId: otherGame.id });
    const res = await checkPermission({
      userId: "user_alice",
      groupId: otherGroup.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(404);
  });

  it("rejects requests missing required query parameters", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/permissions/check?groupId=${group.id}`, {
      method: "GET",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty permission value", async () => {
    const group = await seedGroup();
    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a permission value over the length cap", async () => {
    const group = await seedGroup();
    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "a".repeat(129),
    });
    expect(res.status).toBe(400);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const qs = new URLSearchParams({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    }).toString();
    const res = await app.request(`/v1/permissions/check?${qs}`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("caches the result so a second call does not hit the database", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const role = await seedRole(group.id, 50);
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });

    const first = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    const firstBody = (await first.json()) as { source: string };
    expect(firstBody.source).toBe("role");

    // Invalidate the underlying permission row directly (no cache invalidation
    // hook); the cache should still serve the stale "allowed" answer.
    await prisma.rolePermission.delete({
      where: { roleId_permissionKey: { roleId: role.id, permissionKey: "guild.kick" } },
    });

    const second = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    const secondBody = (await second.json()) as { source: string };
    expect(secondBody.source).toBe("role");
  });

  it("invalidates the cache when a role is assigned via the route", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const role = await seedRole(group.id, 50);
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });

    const before = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await before.json()).toEqual({ allowed: false, source: "default" });

    const assign = await app.request(`/v1/groups/${group.id}/members/user_alice/roles/${role.id}`, {
      method: "POST",
      headers: { authorization: authHeader },
    });
    expect(assign.status).toBe(200);

    const after = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    const body = (await after.json()) as { allowed: boolean; source: string; viaRoleId: string };
    expect(body.allowed).toBe(true);
    expect(body.source).toBe("role");
    expect(body.viaRoleId).toBe(role.id);
    expect(member.id).toBeTruthy();
  });

  it("invalidates the cache when a role permission is revoked via the route", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    const role = await seedRole(group.id, 50);
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });

    const before = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    const beforeBody = (await before.json()) as { source: string };
    expect(beforeBody.source).toBe("role");

    const revoke = await app.request(`/v1/roles/${role.id}/permissions/guild.kick`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(revoke.status).toBe(200);

    const after = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await after.json()).toEqual({ allowed: false, source: "default" });
  });

  it("invalidates the cache when a member-level override is set via the route", async () => {
    const group = await seedGroup();
    await seedActiveMember(group.id, "user_alice");

    const before = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await before.json()).toEqual({ allowed: false, source: "default" });

    const set = await app.request(
      `/v1/groups/${group.id}/members/user_alice/permissions/guild.kick`,
      {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ grant: true }),
      },
    );
    expect(set.status).toBe(200);

    const after = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await after.json()).toEqual({ allowed: true, source: "override" });
  });

  it("invalidates the cache when an override is cleared via the route", async () => {
    const group = await seedGroup();
    const { member } = await seedActiveMember(group.id, "user_alice");
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "guild.kick", grant: true },
    });

    const before = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await before.json()).toEqual({ allowed: true, source: "override" });

    const clear = await app.request(
      `/v1/groups/${group.id}/members/user_alice/permissions/guild.kick`,
      { method: "DELETE", headers: { authorization: authHeader } },
    );
    expect(clear.status).toBe(204);

    const after = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await after.json()).toEqual({ allowed: false, source: "default" });
  });
});
