import type { JunjoEvent, MemberInvitedEvent } from "@junjo.io/shared";
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
  "integration: bulk-invite 100 user IDs creates 100 invitations + audit entries + events",
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

    it("processes a 100-row CSV in one round-trip with 1:1:1 invitation/audit/event counts", async () => {
      const groupRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "guild", name: "Crimson Wolves" }),
      });
      const group = (await groupRes.json()) as { id: string };

      const recorded: JunjoEvent[] = [];
      hub.subscribe(group.id as never, (e) => recorded.push(e));

      const userIds: string[] = [];
      for (let i = 0; i < 100; i++) {
        userIds.push(`user_${String(i).padStart(3, "0")}`);
      }
      const csv = userIds.join("\n");

      const bulkRes = await app.request(`/v1/groups/${group.id}/bulk-invite`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "text/csv" },
        body: csv,
      });
      expect(bulkRes.status).toBe(200);
      const summary = (await bulkRes.json()) as {
        invited: number;
        skipped: number;
        errors: { row: number; reason: string }[];
      };
      expect(summary).toEqual({ invited: 100, skipped: 0, errors: [] });

      const invitations = await prisma.invitation.findMany({
        where: { groupId: group.id },
        select: { targetUserId: true, code: true },
      });
      expect(invitations).toHaveLength(100);
      const targets = invitations.map((i) => i.targetUserId).filter((x): x is string => x !== null);
      expect(new Set(targets)).toEqual(new Set(userIds));
      const codes = new Set(invitations.map((i) => i.code));
      expect(codes.size).toBe(100);

      const auditEntries = await prisma.auditEntry.findMany({
        where: { groupId: group.id, action: "member.invited" },
        select: { targetId: true, payload: true },
      });
      expect(auditEntries).toHaveLength(100);
      expect(
        auditEntries.every((e) => (e.payload as Record<string, unknown>).source === "bulk-invite"),
      ).toBe(true);
      const auditTargets = auditEntries
        .map((e) => e.targetId)
        .filter((x): x is string => x !== null);
      expect(new Set(auditTargets)).toEqual(new Set(userIds));

      expect(recorded).toHaveLength(100);
      expect(recorded.every((e) => e.type === "member.invited")).toBe(true);
      const eventTargets = recorded.map((e) => (e as MemberInvitedEvent).invitation.targetUserId);
      expect(new Set(eventTargets)).toEqual(new Set(userIds));
    });

    it("a second bulk-invite with the same userIds reports them all skipped (pending invitations dedupe)", async () => {
      const groupRes = await app.request("/v1/groups", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ kind: "guild", name: "Crimson Wolves" }),
      });
      const group = (await groupRes.json()) as { id: string };

      const userIds = Array.from({ length: 10 }, (_, i) => `user_dup_${i}`);
      const csv = userIds.join("\n");

      const first = await app.request(`/v1/groups/${group.id}/bulk-invite`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "text/csv" },
        body: csv,
      });
      const firstSummary = (await first.json()) as {
        invited: number;
        skipped: number;
        errors: unknown[];
      };
      expect(firstSummary).toEqual({ invited: 10, skipped: 0, errors: [] });

      const second = await app.request(`/v1/groups/${group.id}/bulk-invite`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "text/csv" },
        body: csv,
      });
      const secondSummary = (await second.json()) as {
        invited: number;
        skipped: number;
        errors: unknown[];
      };
      expect(secondSummary).toEqual({ invited: 0, skipped: 10, errors: [] });

      expect(await prisma.invitation.count({ where: { groupId: group.id } })).toBe(10);
    });
  },
);
