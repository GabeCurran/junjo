import type { JunjoEvent } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
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

describe.skipIf(!TEST_DATABASE_URL)(
  "integration: full guild lifecycle (create -> invite -> join -> role -> permission)",
  () => {
    let app: Hono;
    let hub: EventHub;
    let authHeader: string;
    let recorded: JunjoEvent[];

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(TRUNCATE);
      const game = await createGame("Test Game", prisma);
      const seeded = await createApiKey(game.id, prisma);
      authHeader = `Bearer ${seeded.raw.full}`;
      hub = new EventHub();
      app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
      recorded = [];
    });

    function jsonHeaders() {
      return { authorization: authHeader, "content-type": "application/json" };
    }

    it("walks the full path from group creation to a granted permission, with audit + events lining up", async () => {
      const createGroupRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "guild", name: "Crimson Wolves" }),
      });
      expect(createGroupRes.status).toBe(201);
      const group = (await createGroupRes.json()) as { id: string };

      hub.subscribe(group.id as never, (event) => recorded.push(event));

      const inviteRes = await app.request(`/v1/groups/${group.id}/invitations`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ targetUserId: "user_alice" }),
      });
      expect(inviteRes.status).toBe(201);
      const invitation = (await inviteRes.json()) as { code: string };

      const acceptRes = await app.request(`/v1/invitations/${invitation.code}/accept`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ userId: "user_alice" }),
      });
      expect(acceptRes.status).toBe(201);

      const createRoleRes = await app.request(`/v1/groups/${group.id}/roles`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ name: "Officer", priority: 50 }),
      });
      expect(createRoleRes.status).toBe(201);
      const role = (await createRoleRes.json()) as { id: string };

      const assignRes = await app.request(
        `/v1/groups/${group.id}/members/user_alice/roles/${role.id}`,
        { method: "POST", headers: { authorization: authHeader } },
      );
      expect(assignRes.status).toBe(200);

      const grantRes = await app.request(`/v1/roles/${role.id}/permissions`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ permission: "guild.invite_member" }),
      });
      expect(grantRes.status).toBe(200);

      const checkRes = await app.request(
        `/v1/permissions/check?userId=user_alice&groupId=${group.id}&permission=guild.invite_member`,
        { method: "GET", headers: { authorization: authHeader } },
      );
      expect(checkRes.status).toBe(200);
      const check = (await checkRes.json()) as {
        allowed: boolean;
        source: string;
        viaRoleId?: string;
      };
      expect(check.allowed).toBe(true);
      expect(check.source).toBe("role");
      expect(check.viaRoleId).toBe(role.id);

      const auditEntries = await prisma.auditEntry.findMany({
        where: { groupId: group.id },
        orderBy: { createdAt: "asc" },
      });
      const actions = auditEntries.map((e) => e.action);
      expect(actions).toEqual([
        "group.created",
        "member.invited",
        "member.joined",
        "role.created",
        "role.assigned",
        "permission.granted",
      ]);

      const eventTypes = recorded.map((e) => e.type);
      expect(eventTypes).toEqual([
        "member.invited",
        "member.joined",
        "role.created",
        "role.changed",
        "permission.granted",
      ]);

      const cachedRes = await app.request(
        `/v1/permissions/check?userId=user_alice&groupId=${group.id}&permission=guild.invite_member`,
        { method: "GET", headers: { authorization: authHeader } },
      );
      expect(cachedRes.status).toBe(200);
      const cached = (await cachedRes.json()) as { allowed: boolean };
      expect(cached.allowed).toBe(true);
    });
  },
);
