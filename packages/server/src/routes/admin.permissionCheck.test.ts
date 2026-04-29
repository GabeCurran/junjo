import { type Group, PrismaClient, type Role } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "MemberRole", "RolePermission", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/permissions/check", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
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

  async function seedActiveMember(groupId: string, externalUserId: string, scopedGameId = gameId) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId: scopedGameId, junjoUserId: user.id, externalUserId },
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
    return prisma.role.create({ data: { groupId, name, priority } });
  }

  function checkPermission(
    params: { userId: string; groupId: string; permission: string },
    options: { gameId?: string; header?: string } = {},
  ) {
    const targetGame = options.gameId ?? gameId;
    const header = options.header ?? `Bearer ${ADMIN_TOKEN}`;
    const qs = new URLSearchParams(params).toString();
    return app.request(`/v1/admin/games/${targetGame}/permissions/check?${qs}`, {
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

  it("returns 404 when the gameId does not exist", async () => {
    const group = await seedGroup();
    const res = await checkPermission(
      { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
      { gameId: "ckxxxxxxxxxxxxxxxxxxxxxxxx" },
    );
    expect(res.status).toBe(404);
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

  it("isolates ExternalIdentity scope to the path :gameId (cross-game user resolves to source=none)", async () => {
    // Same external user id registered in *another* game - the admin
    // route's :gameId scoping must NOT find it via the calling game.
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup();
    const otherGroup = await seedGroup({ gameId: otherGame.id });
    const { member } = await seedActiveMember(otherGroup.id, "user_alice", otherGame.id);
    const role = await seedRole(otherGroup.id, 90);
    await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: role.id } });
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: "guild.kick" } });

    // Calling game has no ExternalIdentity for "user_alice" -> source=none.
    const res = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: false, source: "none" });
  });

  it("rejects requests missing required query parameters", async () => {
    const group = await seedGroup();
    const res = await app.request(
      `/v1/admin/games/${gameId}/permissions/check?groupId=${group.id}`,
      { method: "GET", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
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

  it("rejects an empty userId", async () => {
    const group = await seedGroup();
    const res = await checkPermission({
      userId: "",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(res.status).toBe(400);
  });

  it("rejects an empty groupId", async () => {
    const res = await checkPermission({
      userId: "user_alice",
      groupId: "",
      permission: "guild.kick",
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 when no Authorization header is sent", async () => {
    const group = await seedGroup();
    const qs = new URLSearchParams({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    }).toString();
    const res = await app.request(`/v1/admin/games/${gameId}/permissions/check?${qs}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong admin token", async () => {
    const group = await seedGroup();
    const res = await checkPermission(
      { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
      { header: "Bearer not-the-real-token" },
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const localApp = createApp({ prisma });
    const group = await seedGroup();
    const qs = new URLSearchParams({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    }).toString();
    const res = await localApp.request(`/v1/admin/games/${gameId}/permissions/check?${qs}`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests where the per-game API key would otherwise authenticate", async () => {
    // The admin route lives BEFORE `apiKeyMiddleware` in `app.ts`, so a
    // per-game `junjo_pk_...` key cannot reach this endpoint - the
    // adminAuthMiddleware checks Bearer before the apiKey middleware
    // runs at all.
    const group = await seedGroup();
    const res = await checkPermission(
      { userId: "user_alice", groupId: group.id, permission: "guild.kick" },
      { header: "Bearer junjo_pk_some_per_game_key.aabbcc" },
    );
    expect(res.status).toBe(401);
  });

  it("URL-decodes the gameId path parameter", async () => {
    // gameId is a cuid in practice (no characters needing encoding), but
    // verify the route uses Hono's URL-decoded :gameId param.
    const group = await seedGroup();
    const encodedGameId = encodeURIComponent(gameId);
    const qs = new URLSearchParams({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    }).toString();
    const res = await app.request(`/v1/admin/games/${encodedGameId}/permissions/check?${qs}`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
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

    // Delete the underlying RolePermission directly (no cache invalidation
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

  it("shares the cache with the per-game route (mutation through the per-game admin path invalidates this read)", async () => {
    // Verifies the singleton `permissionCache` is the same object across
    // both surfaces. A mutation through the per-game admin override
    // endpoint (Phase 11.5c-i) invalidates the entry the admin check
    // route just populated.
    const group = await seedGroup();
    await seedActiveMember(group.id, "user_alice");

    const before = await checkPermission({
      userId: "user_alice",
      groupId: group.id,
      permission: "guild.kick",
    });
    expect(await before.json()).toEqual({ allowed: false, source: "default" });

    // Set an override via the admin row-action endpoint; the route
    // invalidates `permissionCache.invalidateGroup(group.id)` after
    // committing. Same singleton -> the next admin check call sees the
    // post-mutation answer.
    const set = await app.request(
      `/v1/admin/games/${gameId}/groups/${group.id}/members/user_alice/permissions/guild.kick`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ADMIN_TOKEN}`,
          "content-type": "application/json",
        },
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
});
