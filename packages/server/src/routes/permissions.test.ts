import { type Group, PrismaClient, type Role } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { MAX_BATCH_CHECKS } from "./permissions.schema";

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

  // Same user in a second group. Reuses the existing ExternalIdentity
  // (one per game per external id) instead of minting a second one.
  async function seedActiveMemberIn(groupId: string, externalUserId: string) {
    const identity = await prisma.externalIdentity.findUnique({
      where: { gameId_externalUserId: { gameId, externalUserId } },
      select: { junjoUserId: true },
    });
    const junjoUserId = identity
      ? identity.junjoUserId
      : (await seedActiveMember(groupId, externalUserId)).user.id;
    const member = await prisma.groupMember.upsert({
      where: { groupId_junjoUserId: { groupId, junjoUserId } },
      create: { groupId, junjoUserId, status: "active" },
      update: { status: "active" },
    });
    return { junjoUserId, member };
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
    params: { userId: string; groupId: string; permission: string; inherit?: string },
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

  describe("inherit=true", () => {
    async function seedChild(parentGroupId: string, name: string): Promise<Group> {
      return prisma.group.create({
        data: {
          gameId,
          kind: "party",
          name,
          visibility: "invite-only",
          metadata: {},
          parentGroupId,
        },
      });
    }

    async function grantRole(groupId: string, externalUserId: string, permission: string) {
      const { member } = await seedActiveMember(groupId, externalUserId);
      const role = await seedRole(groupId, 10, `Granter-${groupId}`);
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionKey: permission },
      });
      await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
      return { member, role };
    }

    it("resolves a grant held on the parent group", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      const { role } = await grantRole(parent.id, "user_alice", "guild.kick");

      const direct = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
      });
      expect(await direct.json()).toEqual({ allowed: false, source: "none" });

      const inherited = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await inherited.json()).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: role.id,
        viaGroupId: parent.id,
      });
    });

    it("walks more than one level to the root", async () => {
      const root = await seedGroup();
      const mid = await seedChild(root.id, "Mid");
      const leaf = await seedChild(mid.id, "Leaf");
      await grantRole(root.id, "user_alice", "guild.kick");

      const res = await checkPermission({
        userId: "user_alice",
        groupId: leaf.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await res.json()).toMatchObject({
        allowed: true,
        source: "role",
        viaGroupId: root.id,
      });
    });

    it("reports viaGroupId as the queried group when the grant is direct", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      await grantRole(child.id, "user_alice", "guild.kick");

      const res = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await res.json()).toMatchObject({ allowed: true, viaGroupId: child.id });
    });

    it("lets the nearest group decide: a child deny is not undone by a parent grant", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      await grantRole(parent.id, "user_alice", "guild.kick");
      const { member } = await seedActiveMemberIn(child.id, "user_alice");
      await prisma.memberPermissionOverride.create({
        data: { groupMemberId: member.id, permissionKey: "guild.kick", grant: false },
      });

      const res = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await res.json()).toEqual({
        allowed: false,
        source: "override",
        viaGroupId: child.id,
      });
    });

    it("continues past a level where the member holds no grant", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      await grantRole(parent.id, "user_alice", "guild.kick");
      // Active in the child with no roles: `default`, which is
      // inconclusive rather than a stop.
      await seedActiveMemberIn(child.id, "user_alice");

      const res = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await res.json()).toMatchObject({ allowed: true, viaGroupId: parent.id });
    });

    it("returns the queried group's own result when nothing on the chain decides", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      await seedActiveMemberIn(child.id, "user_alice");

      const res = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      // `default`, not `none`: the distinction between "not a member"
      // and "member without the grant" survives the walk.
      expect(await res.json()).toEqual({ allowed: false, source: "default" });
    });

    it("does not read through a soft-deleted ancestor", async () => {
      const root = await seedGroup();
      const mid = await seedChild(root.id, "Mid");
      const leaf = await seedChild(mid.id, "Leaf");
      await grantRole(root.id, "user_alice", "guild.kick");
      await prisma.group.update({
        where: { id: mid.id },
        data: { softDeletedAt: new Date() },
      });

      const res = await checkPermission({
        userId: "user_alice",
        groupId: leaf.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await res.json()).toEqual({ allowed: false, source: "none" });
    });

    it("does not cross a game boundary through a parent", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const foreignParent = await prisma.group.create({
        data: {
          gameId: otherGame.id,
          kind: "guild",
          name: "Foreign",
          visibility: "invite-only",
          metadata: {},
        },
      });
      const child = await prisma.group.create({
        data: {
          gameId,
          kind: "party",
          name: "Child",
          visibility: "invite-only",
          metadata: {},
          parentGroupId: foreignParent.id,
        },
      });
      await grantRole(foreignParent.id, "user_alice", "guild.kick");

      const res = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await res.json()).toEqual({ allowed: false, source: "none" });
    });

    it("omits viaGroupId when inherit is not requested", async () => {
      const group = await seedGroup();
      await grantRole(group.id, "user_alice", "guild.kick");
      const res = await checkPermission({
        userId: "user_alice",
        groupId: group.id,
        permission: "guild.kick",
      });
      expect(await res.json()).not.toHaveProperty("viaGroupId");
    });

    it("rejects a non-boolean inherit value", async () => {
      const group = await seedGroup();
      const res = await checkPermission({
        userId: "user_alice",
        groupId: group.id,
        permission: "guild.kick",
        inherit: "yes",
      });
      expect(res.status).toBe(400);
    });

    it("caches inherited and direct answers separately", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      await grantRole(parent.id, "user_alice", "guild.kick");

      const inherited = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await inherited.json()).toMatchObject({ allowed: true });

      const direct = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
      });
      expect(await direct.json()).toEqual({ allowed: false, source: "none" });
    });

    it("drops a cached inherited answer when the group is reparented", async () => {
      const oldParent = await seedGroup();
      const newParent = await prisma.group.create({
        data: {
          gameId,
          kind: "guild",
          name: "Second Parent",
          visibility: "invite-only",
          metadata: {},
        },
      });
      const child = await seedChild(oldParent.id, "Child");
      await grantRole(oldParent.id, "user_alice", "guild.kick");

      const before = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await before.json()).toMatchObject({ allowed: true, viaGroupId: oldParent.id });

      const reparent = await app.request(`/v1/groups/${child.id}/parent`, {
        method: "PUT",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ parentGroupId: newParent.id }),
      });
      expect(reparent.status).toBe(200);

      // The old parent's grant is no longer on the chain, so the
      // cached "allowed" must not survive the move.
      const after = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await after.json()).toEqual({ allowed: false, source: "none" });
    });

    it("drops a cached inherited answer when the ancestor's grant is revoked", async () => {
      const parent = await seedGroup();
      const child = await seedChild(parent.id, "Child");
      const { role } = await grantRole(parent.id, "user_alice", "guild.kick");

      const before = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await before.json()).toMatchObject({ allowed: true });

      const revoke = await app.request(`/v1/roles/${role.id}/permissions/guild.kick`, {
        method: "DELETE",
        headers: { authorization: authHeader },
      });
      expect(revoke.status).toBe(200);

      const after = await checkPermission({
        userId: "user_alice",
        groupId: child.id,
        permission: "guild.kick",
        inherit: "true",
      });
      expect(await after.json()).toEqual({ allowed: false, source: "none" });
    });
  });

  describe("POST /v1/permissions/check-batch", () => {
    function checkBatch(body: unknown, header: string = authHeader) {
      return app.request("/v1/permissions/check-batch", {
        method: "POST",
        headers: { authorization: header, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("answers every entry positionally", async () => {
      const group = await seedGroup();
      const { member } = await seedActiveMember(group.id, "user_alice");
      const role = await seedRole(group.id, 10);
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionKey: "guild.kick" },
      });
      await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });

      const res = await checkBatch({
        checks: [
          { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
          { userId: "user_alice", groupId: group.id, permission: "guild.invite" },
          { userId: "user_bob", groupId: group.id, permission: "guild.kick" },
        ],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        results: [
          { allowed: true, source: "role", viaRoleId: role.id },
          { allowed: false, source: "default" },
          { allowed: false, source: "none" },
        ],
      });
    });

    it("matches the single-check route entry for entry", async () => {
      const group = await seedGroup();
      await seedActiveMember(group.id, "user_alice");

      const single = await checkPermission({
        userId: "user_alice",
        groupId: group.id,
        permission: "guild.kick",
      });
      const batch = await checkBatch({
        checks: [{ userId: "user_alice", groupId: group.id, permission: "guild.kick" }],
      });
      const batchBody = (await batch.json()) as { results: unknown[] };
      expect(batchBody.results[0]).toEqual(await single.json());
    });

    it("honors inherit for every entry", async () => {
      const parent = await seedGroup();
      const child = await prisma.group.create({
        data: {
          gameId,
          kind: "party",
          name: "Child",
          visibility: "invite-only",
          metadata: {},
          parentGroupId: parent.id,
        },
      });
      const { member } = await seedActiveMember(parent.id, "user_alice");
      const role = await seedRole(parent.id, 10);
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionKey: "guild.kick" },
      });
      await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });

      const res = await checkBatch({
        checks: [{ userId: "user_alice", groupId: child.id, permission: "guild.kick" }],
      });
      expect(((await res.json()) as { results: unknown[] }).results[0]).toEqual({
        allowed: false,
        source: "none",
      });

      const withInherit = await checkBatch({
        checks: [{ userId: "user_alice", groupId: child.id, permission: "guild.kick" }],
        inherit: true,
      });
      expect(((await withInherit.json()) as { results: unknown[] }).results[0]).toMatchObject({
        allowed: true,
        viaGroupId: parent.id,
      });
    });

    it("resolves a shared ancestor once for sibling groups", async () => {
      const parent = await seedGroup();
      const siblings = [];
      for (let i = 0; i < 5; i++) {
        siblings.push(
          await prisma.group.create({
            data: {
              gameId,
              kind: "shop",
              name: `Shop ${i}`,
              visibility: "invite-only",
              metadata: {},
              parentGroupId: parent.id,
            },
          }),
        );
      }
      const { member } = await seedActiveMember(parent.id, "user_alice");
      const role = await seedRole(parent.id, 10);
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionKey: "shop.view" },
      });
      await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });

      const res = await checkBatch({
        checks: siblings.map((g) => ({
          userId: "user_alice",
          groupId: g.id,
          permission: "shop.view",
        })),
        inherit: true,
      });
      const body = (await res.json()) as { results: Array<{ allowed: boolean }> };
      expect(body.results).toHaveLength(5);
      // Every sibling inherits the same grant from the shared parent,
      // which the walk resolves once per request rather than per entry.
      expect(body.results.every((r) => r.allowed)).toBe(true);
    });

    it("resolves repeated triples consistently", async () => {
      const group = await seedGroup();
      await seedActiveMember(group.id, "user_alice");
      const res = await checkBatch({
        checks: [
          { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
          { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
        ],
      });
      const body = (await res.json()) as { results: unknown[] };
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toEqual(body.results[1]);
    });

    it("404s the whole request when one groupId is unknown, naming its index", async () => {
      const group = await seedGroup();
      const res = await checkBatch({
        checks: [
          { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
          { userId: "user_alice", groupId: "grp_missing", permission: "guild.kick" },
        ],
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("not_found");
      expect(body.message).toContain("checks[1]");
    });

    it("404s when a groupId belongs to another game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const foreign = await prisma.group.create({
        data: {
          gameId: otherGame.id,
          kind: "guild",
          name: "Foreign",
          visibility: "invite-only",
          metadata: {},
        },
      });
      const res = await checkBatch({
        checks: [{ userId: "user_alice", groupId: foreign.id, permission: "guild.kick" }],
      });
      expect(res.status).toBe(404);
    });

    it("404s when a groupId is soft-deleted", async () => {
      const group = await seedGroup({ softDeletedAt: new Date() });
      const res = await checkBatch({
        checks: [{ userId: "user_alice", groupId: group.id, permission: "guild.kick" }],
      });
      expect(res.status).toBe(404);
    });

    it("rejects an empty checks array", async () => {
      const res = await checkBatch({ checks: [] });
      expect(res.status).toBe(400);
    });

    it("rejects a batch over the entry cap", async () => {
      const group = await seedGroup();
      const checks = Array.from({ length: MAX_BATCH_CHECKS + 1 }, () => ({
        userId: "user_alice",
        groupId: group.id,
        permission: "guild.kick",
      }));
      const res = await checkBatch({ checks });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { message: string };
      expect(body.message).toContain(String(MAX_BATCH_CHECKS));
    });

    it("accepts a batch exactly at the entry cap", async () => {
      const group = await seedGroup();
      const checks = Array.from({ length: MAX_BATCH_CHECKS }, () => ({
        userId: "user_alice",
        groupId: group.id,
        permission: "guild.kick",
      }));
      const res = await checkBatch({ checks });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { results: unknown[] }).results).toHaveLength(MAX_BATCH_CHECKS);
    });

    it("rejects unknown fields on an entry", async () => {
      const group = await seedGroup();
      const res = await checkBatch({
        checks: [
          {
            userId: "user_alice",
            groupId: group.id,
            permission: "guild.kick",
            extra: true,
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed body", async () => {
      const res = await checkBatch({ checks: "nope" });
      expect(res.status).toBe(400);
    });

    it("rejects requests without an API key", async () => {
      const group = await seedGroup();
      const res = await checkBatch(
        { checks: [{ userId: "user_alice", groupId: group.id, permission: "guild.kick" }] },
        "Bearer jk_nope.nope",
      );
      expect(res.status).toBe(401);
    });
  });
});
