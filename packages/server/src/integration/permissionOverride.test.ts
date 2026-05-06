import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

interface PermissionCheck {
  allowed: boolean;
  source: "default" | "role" | "override" | "none";
  viaRoleId?: string;
}

describe.skipIf(!TEST_DATABASE_URL)(
  "integration: member-level override beats role grant; clearing the override restores role-derived behavior",
  () => {
    let app: Hono;
    let authHeader: string;

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(TRUNCATE);
      permissionCache.clear();
      const game = await createGame("Test Game", prisma);
      const seeded = await createApiKey(game.id, prisma);
      authHeader = `Bearer ${seeded.raw.full}`;
      const hub = new EventHub();
      app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
    });

    function jsonHeaders() {
      return { authorization: authHeader, "content-type": "application/json" };
    }

    async function check(
      userId: string,
      groupId: string,
      permission: string,
    ): Promise<PermissionCheck> {
      const res = await app.request(
        `/v1/permissions/check?userId=${userId}&groupId=${groupId}&permission=${permission}`,
        { method: "GET", headers: { authorization: authHeader } },
      );
      expect(res.status).toBe(200);
      return (await res.json()) as PermissionCheck;
    }

    it("transitions role-grant -> override-deny -> override-cleared, with the cache invalidating in lockstep", async () => {
      const groupRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "guild", name: "Crimson Wolves" }),
      });
      const group = (await groupRes.json()) as { id: string };

      const inviteRes = await app.request(`/v1/groups/${group.id}/invitations`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ targetUserId: "user_alice" }),
      });
      const invitation = (await inviteRes.json()) as { code: string };

      await app.request(`/v1/invitations/${invitation.code}/accept`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ userId: "user_alice" }),
      });

      const roleRes = await app.request(`/v1/groups/${group.id}/roles`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "Officer", priority: 50 }),
      });
      const role = (await roleRes.json()) as { id: string };

      await app.request(`/v1/groups/${group.id}/members/user_alice/roles/${role.id}`, {
        method: "POST",
        headers: { authorization: authHeader },
      });
      await app.request(`/v1/roles/${role.id}/permissions`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ permission: "guild.invite_member" }),
      });

      const granted = await check("user_alice", group.id, "guild.invite_member");
      expect(granted).toMatchObject({ allowed: true, source: "role", viaRoleId: role.id });

      const overrideRes = await app.request(
        `/v1/groups/${group.id}/members/user_alice/permissions/guild.invite_member`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ grant: false }),
        },
      );
      expect(overrideRes.status).toBe(200);

      const denied = await check("user_alice", group.id, "guild.invite_member");
      expect(denied).toEqual({ allowed: false, source: "override" });

      const clearRes = await app.request(
        `/v1/groups/${group.id}/members/user_alice/permissions/guild.invite_member`,
        { method: "DELETE", headers: { authorization: authHeader } },
      );
      expect(clearRes.status).toBe(204);

      const restored = await check("user_alice", group.id, "guild.invite_member");
      expect(restored).toMatchObject({ allowed: true, source: "role", viaRoleId: role.id });

      const auditActions = (
        await prisma.auditEntry.findMany({
          where: { groupId: group.id },
          orderBy: { createdAt: "asc" },
          select: { action: true },
        })
      ).map((e) => e.action);
      expect(auditActions).toEqual([
        "group.created",
        "member.invited",
        "member.joined",
        "role.created",
        "role.assigned",
        "permission.granted",
        "permission.override.set",
        "permission.override.cleared",
      ]);
    });

    it("a non-active member fails the permission check even with a role grant in place", async () => {
      const groupRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "guild", name: "Crimson Wolves" }),
      });
      const group = (await groupRes.json()) as { id: string };

      const inviteRes = await app.request(`/v1/groups/${group.id}/invitations`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ targetUserId: "user_bob" }),
      });
      const invitation = (await inviteRes.json()) as { code: string };

      await app.request(`/v1/invitations/${invitation.code}/accept`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ userId: "user_bob" }),
      });

      const roleRes = await app.request(`/v1/groups/${group.id}/roles`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "Officer", priority: 50 }),
      });
      const role = (await roleRes.json()) as { id: string };

      await app.request(`/v1/groups/${group.id}/members/user_bob/roles/${role.id}`, {
        method: "POST",
        headers: { authorization: authHeader },
      });
      await app.request(`/v1/roles/${role.id}/permissions`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ permission: "guild.invite_member" }),
      });

      const kickRes = await app.request(`/v1/groups/${group.id}/members/user_bob/kick`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({}),
      });
      expect(kickRes.status).toBe(200);

      // The kick path does not invalidate `permissionCache`, so the resolver
      // is the only thing exercised here. Skipping a pre-kick `check` keeps
      // the cache empty and isolates this test to the resolver's
      // active-status gate.
      const after = await check("user_bob", group.id, "guild.invite_member");
      expect(after).toEqual({ allowed: false, source: "none" });
    });
  },
);
