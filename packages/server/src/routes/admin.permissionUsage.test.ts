import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminPermissionUsage` from `routes/admin.ts`.
type WireAdminPermissionUsageItem = {
  permission: string;
  roleGrants: number;
  memberOverrides: number;
  total: number;
};
type WireAdminPermissionUsage = {
  totalCount: number;
  uniqueKeys: number;
  items: WireAdminPermissionUsageItem[];
  otherCount: number;
};

const TRUNCATE =
  'TRUNCATE TABLE "RolePermission", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)(
  "GET /v1/admin/games/:gameId/analytics/permission-usage (Phase 12.5a)",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(TRUNCATE);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function getUsage(gameId: string, header = `Bearer ${ADMIN_TOKEN}`) {
      return app.request(`/v1/admin/games/${gameId}/analytics/permission-usage`, {
        method: "GET",
        headers: { authorization: header },
      });
    }

    async function seedGroup(
      gameId: string,
      name: string,
      overrides: { softDeleted?: boolean } = {},
    ) {
      return prisma.group.create({
        data: {
          gameId,
          kind: "guild",
          name,
          visibility: "invite-only",
          softDeletedAt: overrides.softDeleted ? new Date() : null,
        },
      });
    }

    async function seedRole(groupId: string, name: string, priority = 0) {
      return prisma.role.create({ data: { groupId, name, priority } });
    }

    async function seedMember(
      gameId: string,
      groupId: string,
      externalUserId: string,
      status: "active" | "left" | "kicked" | "invited" = "active",
    ) {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId },
      });
      return prisma.groupMember.create({
        data: { groupId, junjoUserId: user.id, status },
      });
    }

    it("returns the empty shape on a game with no roles or overrides", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getUsage(game.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body).toEqual({
        totalCount: 0,
        uniqueKeys: 0,
        items: [],
        otherCount: 0,
      });
    });

    it("counts RolePermission rows scoped to the game's non-soft-deleted groups", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const officer = await seedRole(group.id, "Officer", 100);
      const member = await seedRole(group.id, "Member", 0);
      await prisma.rolePermission.createMany({
        data: [
          { roleId: officer.id, permissionKey: "guild.invite_member" },
          { roleId: officer.id, permissionKey: "guild.kick_member" },
          { roleId: member.id, permissionKey: "guild.invite_member" },
        ],
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.totalCount).toBe(3);
      expect(body.uniqueKeys).toBe(2);
      expect(body.items).toEqual([
        { permission: "guild.invite_member", roleGrants: 2, memberOverrides: 0, total: 2 },
        { permission: "guild.kick_member", roleGrants: 1, memberOverrides: 0, total: 1 },
      ]);
      expect(body.otherCount).toBe(0);
    });

    it("counts MemberPermissionOverride rows scoped to the game's non-soft-deleted groups", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const m1 = await seedMember(game.id, group.id, "u1");
      const m2 = await seedMember(game.id, group.id, "u2");
      await prisma.memberPermissionOverride.createMany({
        data: [
          { groupMemberId: m1.id, permissionKey: "guild.kick_member", grant: true },
          { groupMemberId: m2.id, permissionKey: "guild.kick_member", grant: false },
        ],
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.totalCount).toBe(2);
      expect(body.uniqueKeys).toBe(1);
      expect(body.items).toEqual([
        { permission: "guild.kick_member", roleGrants: 0, memberOverrides: 2, total: 2 },
      ]);
    });

    it("merges roleGrants + memberOverrides under the same key with combined total", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const officer = await seedRole(group.id, "Officer", 100);
      await prisma.rolePermission.create({
        data: { roleId: officer.id, permissionKey: "guild.invite_member" },
      });
      const m1 = await seedMember(game.id, group.id, "u1");
      const m2 = await seedMember(game.id, group.id, "u2");
      await prisma.memberPermissionOverride.createMany({
        data: [
          { groupMemberId: m1.id, permissionKey: "guild.invite_member", grant: true },
          { groupMemberId: m2.id, permissionKey: "guild.invite_member", grant: false },
        ],
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.items).toEqual([
        { permission: "guild.invite_member", roleGrants: 1, memberOverrides: 2, total: 3 },
      ]);
      expect(body.totalCount).toBe(3);
    });

    it("counts overrides on inactive members (left/kicked/invited) regardless of status", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const active = await seedMember(game.id, group.id, "u1", "active");
      const left = await seedMember(game.id, group.id, "u2", "left");
      const kicked = await seedMember(game.id, group.id, "u3", "kicked");
      await prisma.memberPermissionOverride.createMany({
        data: [
          { groupMemberId: active.id, permissionKey: "guild.kick_member", grant: true },
          { groupMemberId: left.id, permissionKey: "guild.kick_member", grant: true },
          { groupMemberId: kicked.id, permissionKey: "guild.kick_member", grant: false },
        ],
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      // All three overrides count; status doesn't filter them out.
      expect(body.items[0]?.memberOverrides).toBe(3);
      expect(body.totalCount).toBe(3);
    });

    it("excludes soft-deleted groups", async () => {
      const game = await createGame("Alpha", prisma);
      const live = await seedGroup(game.id, "live");
      const dead = await seedGroup(game.id, "dead", { softDeleted: true });
      const liveRole = await seedRole(live.id, "Officer", 100);
      const deadRole = await seedRole(dead.id, "Officer", 100);
      await prisma.rolePermission.createMany({
        data: [
          { roleId: liveRole.id, permissionKey: "guild.invite_member" },
          { roleId: deadRole.id, permissionKey: "guild.invite_member" },
          { roleId: deadRole.id, permissionKey: "guild.kick_member" },
        ],
      });
      const liveMember = await seedMember(game.id, live.id, "u1");
      const deadMember = await seedMember(game.id, dead.id, "u2");
      await prisma.memberPermissionOverride.createMany({
        data: [
          { groupMemberId: liveMember.id, permissionKey: "guild.invite_member", grant: true },
          { groupMemberId: deadMember.id, permissionKey: "guild.kick_member", grant: false },
        ],
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.items).toEqual([
        { permission: "guild.invite_member", roleGrants: 1, memberOverrides: 1, total: 2 },
      ]);
      expect(body.totalCount).toBe(2);
      expect(body.uniqueKeys).toBe(1);
    });

    it("scopes counts to the requested game (cross-game exclusion)", async () => {
      const a = await createGame("Alpha", prisma);
      const b = await createGame("Beta", prisma);
      const aGroup = await seedGroup(a.id, "ga");
      const bGroup = await seedGroup(b.id, "gb");
      const aRole = await seedRole(aGroup.id, "Officer", 100);
      const bRole = await seedRole(bGroup.id, "Officer", 100);
      await prisma.rolePermission.createMany({
        data: [
          { roleId: aRole.id, permissionKey: "guild.invite_member" },
          { roleId: bRole.id, permissionKey: "guild.kick_member" },
        ],
      });

      const res = await getUsage(a.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.items).toEqual([
        { permission: "guild.invite_member", roleGrants: 1, memberOverrides: 0, total: 1 },
      ]);
    });

    it("sorts by total desc with permission asc as the deterministic tiebreaker", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const role = await seedRole(group.id, "Officer", 100);
      // Three keys at totals 5, 3, 3, 2 (the 3-tie expects alphabetical order)
      await prisma.rolePermission.createMany({
        data: [
          { roleId: role.id, permissionKey: "alpha" },
          { roleId: role.id, permissionKey: "beta" },
          { roleId: role.id, permissionKey: "gamma" },
        ],
      });
      // Boost alpha to total=5 via overrides
      const m = await seedMember(game.id, group.id, "u1");
      const m2 = await seedMember(game.id, group.id, "u2");
      const m3 = await seedMember(game.id, group.id, "u3");
      const m4 = await seedMember(game.id, group.id, "u4");
      const m5 = await seedMember(game.id, group.id, "u5");
      const m6 = await seedMember(game.id, group.id, "u6");
      await prisma.memberPermissionOverride.createMany({
        data: [
          { groupMemberId: m.id, permissionKey: "alpha", grant: true },
          { groupMemberId: m2.id, permissionKey: "alpha", grant: true },
          { groupMemberId: m3.id, permissionKey: "alpha", grant: true },
          { groupMemberId: m4.id, permissionKey: "alpha", grant: true },
          // Bring beta up to total=3 (1 grant + 2 overrides)
          { groupMemberId: m5.id, permissionKey: "beta", grant: true },
          { groupMemberId: m6.id, permissionKey: "beta", grant: true },
          // gamma stays at total=1 (1 grant)
        ],
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.items.map((i) => i.permission)).toEqual(["alpha", "beta", "gamma"]);
      expect(body.items.map((i) => i.total)).toEqual([5, 3, 1]);
    });

    it("caps `items` at 15 and aggregates the remainder into `otherCount`", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const role = await seedRole(group.id, "Officer", 100);
      // Seed 18 distinct keys with descending counts: P00 grants of count 18,
      // P01 of count 17, ..., P17 of count 1. We simulate this by creating a
      // single role with one RolePermission per key and adding overrides to
      // boost. To keep it simple: each key gets a distinct number of role
      // grants by using 18 roles per key... too expensive. Instead, use
      // RolePermission once per key + N overrides per key.
      const members: string[] = [];
      for (let i = 0; i < 18; i += 1) {
        const m = await seedMember(game.id, group.id, `boost_${i}`);
        members.push(m.id);
      }
      for (let i = 0; i < 18; i += 1) {
        const key = `P${String(i).padStart(2, "0")}`;
        const grantCount = 18 - i; // P00 -> 18, P17 -> 1
        // First grant via RolePermission
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionKey: key } });
        // Remaining (grantCount - 1) come from overrides on members 0..N-2
        for (let j = 0; j < grantCount - 1; j += 1) {
          const memberId = members[j];
          if (!memberId) continue;
          await prisma.memberPermissionOverride.create({
            data: { groupMemberId: memberId, permissionKey: key, grant: true },
          });
        }
      }

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.uniqueKeys).toBe(18);
      expect(body.items.length).toBe(15);
      // Top 15 keys are P00..P14
      expect(body.items.map((i) => i.permission)).toEqual(
        Array.from({ length: 15 }, (_, i) => `P${String(i).padStart(2, "0")}`),
      );
      expect(body.items[0]?.total).toBe(18);
      expect(body.items[14]?.total).toBe(4);
      // P15 (total=3) + P16 (2) + P17 (1) = 6
      expect(body.otherCount).toBe(6);
      // totalCount = 18 + 17 + ... + 1 = 171
      expect(body.totalCount).toBe(171);
    });

    it("excludes permission keys with zero rows (filtered before sort)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const role = await seedRole(group.id, "Officer", 100);
      // Create one role grant and one PermissionDef row for an unrelated key.
      await prisma.rolePermission.create({
        data: { roleId: role.id, permissionKey: "used_key" },
      });
      // Even if the catalog has the key registered (a future endpoint might
      // create empty PermissionDef rows), this query only counts rows in
      // RolePermission + MemberPermissionOverride.
      await prisma.permissionDef.create({
        data: { gameId: game.id, key: "registered_but_unused" },
      });

      const res = await getUsage(game.id);
      const body = (await res.json()) as WireAdminPermissionUsage;
      expect(body.items.map((i) => i.permission)).toEqual(["used_key"]);
      expect(body.uniqueKeys).toBe(1);
    });

    it("returns 404 when the game does not exist", async () => {
      const res = await getUsage("game_does_not_exist");
      expect(res.status).toBe(404);
    });

    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getUsage(game.id, "");
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getUsage(game.id, "Bearer wrong-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
      const noTokenApp = createApp({ prisma });
      const game = await createGame("Alpha", prisma);
      const res = await noTokenApp.request(
        `/v1/admin/games/${game.id}/analytics/permission-usage`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      );
      expect(res.status).toBe(401);
    });

    it("URL-decodes the gameId path parameter", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getUsage(encodeURIComponent(game.id));
      expect(res.status).toBe(200);
    });
  },
);
