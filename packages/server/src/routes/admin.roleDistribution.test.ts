import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminRoleDistribution` from `routes/admin.ts`.
type WireAdminRoleSlice = { name: string; count: number };
type WireAdminRoleDistribution = {
  totalAssignments: number;
  uniqueRoleNames: number;
  topRoles: WireAdminRoleSlice[];
  otherCount: number;
};

const TRUNCATE =
  'TRUNCATE TABLE "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)(
  "GET /v1/admin/games/:gameId/analytics/role-distribution",
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

    function getDistribution(gameId: string, header = `Bearer ${ADMIN_TOKEN}`) {
      return app.request(`/v1/admin/games/${gameId}/analytics/role-distribution`, {
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

    async function seedActiveMemberWithRoles(
      gameId: string,
      groupId: string,
      externalUserId: string,
      roleIds: string[],
      status: "active" | "left" | "kicked" | "invited" = "active",
    ) {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId },
      });
      const member = await prisma.groupMember.create({
        data: { groupId, junjoUserId: user.id, status },
      });
      if (roleIds.length > 0) {
        await prisma.memberRole.createMany({
          data: roleIds.map((roleId) => ({ groupMemberId: member.id, roleId })),
        });
      }
      return member;
    }

    it("returns the empty shape when the game has no roles or members", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getDistribution(game.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body).toEqual({
        totalAssignments: 0,
        uniqueRoleNames: 0,
        topRoles: [],
        otherCount: 0,
      });
    });

    it("returns the empty shape when roles exist but have no assignments", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      await prisma.role.create({ data: { groupId: group.id, name: "Officer", priority: 100 } });
      await prisma.role.create({ data: { groupId: group.id, name: "Member", priority: 0 } });
      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.totalAssignments).toBe(0);
      expect(body.uniqueRoleNames).toBe(0);
      expect(body.topRoles).toEqual([]);
      expect(body.otherCount).toBe(0);
    });

    it("aggregates role names across multiple groups (same name = same slice)", async () => {
      const game = await createGame("Alpha", prisma);
      const ga = await seedGroup(game.id, "ga");
      const gb = await seedGroup(game.id, "gb");
      // Both groups have an "Officer" role
      const officerA = await prisma.role.create({
        data: { groupId: ga.id, name: "Officer", priority: 100 },
      });
      const officerB = await prisma.role.create({
        data: { groupId: gb.id, name: "Officer", priority: 100 },
      });
      // ga: 2 active officers
      await seedActiveMemberWithRoles(game.id, ga.id, "u1", [officerA.id]);
      await seedActiveMemberWithRoles(game.id, ga.id, "u2", [officerA.id]);
      // gb: 3 active officers
      await seedActiveMemberWithRoles(game.id, gb.id, "u3", [officerB.id]);
      await seedActiveMemberWithRoles(game.id, gb.id, "u4", [officerB.id]);
      await seedActiveMemberWithRoles(game.id, gb.id, "u5", [officerB.id]);

      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.totalAssignments).toBe(5);
      expect(body.uniqueRoleNames).toBe(1);
      expect(body.topRoles).toEqual([{ name: "Officer", count: 5 }]);
      expect(body.otherCount).toBe(0);
    });

    it("excludes assignments from non-active members (left/kicked/invited)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const role = await prisma.role.create({
        data: { groupId: group.id, name: "Officer", priority: 100 },
      });
      await seedActiveMemberWithRoles(game.id, group.id, "u1", [role.id], "active");
      await seedActiveMemberWithRoles(game.id, group.id, "u2", [role.id], "left");
      await seedActiveMemberWithRoles(game.id, group.id, "u3", [role.id], "kicked");
      await seedActiveMemberWithRoles(game.id, group.id, "u4", [role.id], "invited");

      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.totalAssignments).toBe(1);
      expect(body.topRoles).toEqual([{ name: "Officer", count: 1 }]);
    });

    it("excludes roles in soft-deleted groups", async () => {
      const game = await createGame("Alpha", prisma);
      const live = await seedGroup(game.id, "live");
      const dead = await seedGroup(game.id, "dead", { softDeleted: true });
      const liveRole = await prisma.role.create({
        data: { groupId: live.id, name: "Officer", priority: 100 },
      });
      const deadRole = await prisma.role.create({
        data: { groupId: dead.id, name: "Officer", priority: 100 },
      });
      await seedActiveMemberWithRoles(game.id, live.id, "u1", [liveRole.id]);
      await seedActiveMemberWithRoles(game.id, dead.id, "u2", [deadRole.id]);

      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.totalAssignments).toBe(1);
      expect(body.topRoles).toEqual([{ name: "Officer", count: 1 }]);
    });

    it("scopes counts to the requested game (cross-game exclusion)", async () => {
      const a = await createGame("Alpha", prisma);
      const b = await createGame("Beta", prisma);
      const aGroup = await seedGroup(a.id, "ga");
      const bGroup = await seedGroup(b.id, "gb");
      const aRole = await prisma.role.create({
        data: { groupId: aGroup.id, name: "Officer", priority: 100 },
      });
      const bRole = await prisma.role.create({
        data: { groupId: bGroup.id, name: "Officer", priority: 100 },
      });
      await seedActiveMemberWithRoles(a.id, aGroup.id, "u1", [aRole.id]);
      await seedActiveMemberWithRoles(b.id, bGroup.id, "u2", [bRole.id]);
      await seedActiveMemberWithRoles(b.id, bGroup.id, "u3", [bRole.id]);

      const res = await getDistribution(a.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.totalAssignments).toBe(1);
      expect(body.topRoles).toEqual([{ name: "Officer", count: 1 }]);
    });

    it("sorts by count desc with name asc as the deterministic tiebreaker", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const officer = await prisma.role.create({
        data: { groupId: group.id, name: "Officer", priority: 100 },
      });
      const recruit = await prisma.role.create({
        data: { groupId: group.id, name: "Recruit", priority: 50 },
      });
      const member = await prisma.role.create({
        data: { groupId: group.id, name: "Member", priority: 0 },
      });
      // Officer = 3, Recruit = 2, Member = 2
      await seedActiveMemberWithRoles(game.id, group.id, "u1", [officer.id]);
      await seedActiveMemberWithRoles(game.id, group.id, "u2", [officer.id]);
      await seedActiveMemberWithRoles(game.id, group.id, "u3", [officer.id]);
      await seedActiveMemberWithRoles(game.id, group.id, "u4", [recruit.id]);
      await seedActiveMemberWithRoles(game.id, group.id, "u5", [recruit.id]);
      await seedActiveMemberWithRoles(game.id, group.id, "u6", [member.id]);
      await seedActiveMemberWithRoles(game.id, group.id, "u7", [member.id]);

      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      // Officer first (highest count), then Member before Recruit (alphabetical
      // tiebreak among equal-count entries).
      expect(body.topRoles).toEqual([
        { name: "Officer", count: 3 },
        { name: "Member", count: 2 },
        { name: "Recruit", count: 2 },
      ]);
    });

    it("caps `topRoles` at 10 and aggregates the remainder into `otherCount`", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // 12 roles each with one active member (counts 12, 11, ..., 1).
      const roles: Array<{ id: string; name: string; expected: number }> = [];
      for (let i = 0; i < 12; i += 1) {
        const count = 12 - i;
        const role = await prisma.role.create({
          data: { groupId: group.id, name: `R${String(i).padStart(2, "0")}`, priority: 0 },
        });
        for (let j = 0; j < count; j += 1) {
          await seedActiveMemberWithRoles(game.id, group.id, `u_${i}_${j}`, [role.id]);
        }
        roles.push({ id: role.id, name: role.name, expected: count });
      }

      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.uniqueRoleNames).toBe(12);
      expect(body.topRoles.length).toBe(10);
      // Top 10 are R00..R09 with counts 12..3
      expect(body.topRoles.map((r) => r.name)).toEqual([
        "R00",
        "R01",
        "R02",
        "R03",
        "R04",
        "R05",
        "R06",
        "R07",
        "R08",
        "R09",
      ]);
      expect(body.topRoles[0]?.count).toBe(12);
      expect(body.topRoles[9]?.count).toBe(3);
      // R10 (count 2) + R11 (count 1) overflow into otherCount = 3.
      expect(body.otherCount).toBe(3);
      // totalAssignments = 12 + 11 + ... + 1 = 78
      expect(body.totalAssignments).toBe(78);
    });

    it("counts a member with multiple roles as one assignment per role", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const officer = await prisma.role.create({
        data: { groupId: group.id, name: "Officer", priority: 100 },
      });
      const veteran = await prisma.role.create({
        data: { groupId: group.id, name: "Veteran", priority: 50 },
      });
      // One member, two roles -> two assignments (Officer=1, Veteran=1)
      await seedActiveMemberWithRoles(game.id, group.id, "u1", [officer.id, veteran.id]);

      const res = await getDistribution(game.id);
      const body = (await res.json()) as WireAdminRoleDistribution;
      expect(body.totalAssignments).toBe(2);
      expect(body.topRoles).toEqual([
        { name: "Officer", count: 1 },
        { name: "Veteran", count: 1 },
      ]);
    });

    it("returns 404 when the game does not exist", async () => {
      const res = await getDistribution("game_does_not_exist");
      expect(res.status).toBe(404);
    });

    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getDistribution(game.id, "");
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getDistribution(game.id, "Bearer wrong-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
      const noTokenApp = createApp({ prisma });
      const game = await createGame("Alpha", prisma);
      const res = await noTokenApp.request(
        `/v1/admin/games/${game.id}/analytics/role-distribution`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        },
      );
      expect(res.status).toBe(401);
    });

    it("URL-decodes the gameId path parameter", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getDistribution(encodeURIComponent(game.id));
      expect(res.status).toBe(200);
    });
  },
);
