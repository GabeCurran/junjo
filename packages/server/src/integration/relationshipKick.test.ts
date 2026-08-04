import type { GroupRelationshipChangedEvent, JunjoEvent, MemberLeftEvent } from "@junjo.io/shared";
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
  "integration: mutual enemy relationship + kick fires SSE-bound events",
  () => {
    let app: Hono;
    let hub: EventHub;
    let authHeader: string;

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(TRUNCATE);
      const game = await createGame("Test Game", prisma);
      const seeded = await createApiKey(game.id, prisma);
      authHeader = `Bearer ${seeded.raw.full}`;
      hub = new EventHub();
      app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
    });

    function jsonHeaders() {
      return { authorization: authHeader, "content-type": "application/json" };
    }

    it("publishes a relationship event for each direction, then a kicked-member event when a member is removed", async () => {
      const groupARes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "faction", name: "Faction A" }),
      });
      const groupA = (await groupARes.json()) as { id: string };

      const groupBRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "faction", name: "Faction B" }),
      });
      const groupB = (await groupBRes.json()) as { id: string };

      const inviteRes = await app.request(`/v1/groups/${groupA.id}/invitations`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ targetUserId: "user_alice" }),
      });
      const aliceJoin = (await inviteRes.json()) as { code: string };

      await app.request(`/v1/invitations/${aliceJoin.code}/accept`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ userId: "user_alice" }),
      });

      const recordedA: JunjoEvent[] = [];
      const recordedB: JunjoEvent[] = [];
      hub.subscribe(groupA.id as never, (e) => recordedA.push(e));
      hub.subscribe(groupB.id as never, (e) => recordedB.push(e));

      const relationshipRes = await app.request(
        `/v1/groups/${groupA.id}/relationships/${groupB.id}`,
        {
          method: "PUT",
          headers: jsonHeaders(),
          body: JSON.stringify({ type: "enemy", mutual: true }),
        },
      );
      expect(relationshipRes.status).toBe(200);

      expect(recordedA).toHaveLength(1);
      expect(recordedB).toHaveLength(1);
      const aRel = recordedA[0] as GroupRelationshipChangedEvent;
      const bRel = recordedB[0] as GroupRelationshipChangedEvent;
      expect(aRel.type).toBe("group.relationship.changed");
      expect(aRel.otherGroupId).toBe(groupB.id);
      expect(aRel.relationship?.type).toBe("enemy");
      expect(bRel.otherGroupId).toBe(groupA.id);
      expect(bRel.relationship?.type).toBe("enemy");

      const kickRes = await app.request(`/v1/groups/${groupA.id}/members/user_alice/kick`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ reason: "spying for Faction B" }),
      });
      expect(kickRes.status).toBe(200);

      expect(recordedA).toHaveLength(2);
      const kickEvent = recordedA[1] as MemberLeftEvent;
      expect(kickEvent.type).toBe("member.left");
      expect(kickEvent.userId).toBe("user_alice");
      expect(kickEvent.reason).toBe("kicked");

      const auditA = await prisma.auditEntry.findMany({
        where: { groupId: groupA.id },
        orderBy: { createdAt: "asc" },
      });
      const actionsA = auditA.map((e) => e.action);
      expect(actionsA).toEqual([
        "group.created",
        "member.invited",
        "member.joined",
        "group.relationship.set",
        "member.kicked",
      ]);

      const kickAudit = auditA[auditA.length - 1];
      expect(kickAudit?.targetId).toBe("user_alice");
      expect(kickAudit?.payload).toMatchObject({ reason: "spying for Faction B" });

      const member = await prisma.groupMember.findFirst({
        where: { groupId: groupA.id },
        select: { status: true, leftAt: true },
      });
      expect(member?.status).toBe("kicked");
      expect(member?.leftAt).toBeInstanceOf(Date);
    });
  },
);
