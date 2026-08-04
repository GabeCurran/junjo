import type { GroupId } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireInvitation` from `routes/invitations.ts` (the
// admin route returns the same shape; the dashboard's lib/admin.ts will
// mirror it byte-for-byte in 11.5d-ii). Tests assert against this shape so
// a drift on the route side surfaces as a typed failure.
type WireInvitation = {
  id: string;
  groupId: string;
  code: string;
  roleId: string | null;
  targetUserId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedBy: string | null;
};

describe.skipIf(!TEST_DATABASE_URL)(
  "POST /v1/admin/games/:gameId/groups/:groupId/invitations",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "Invitation", "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function inviteFetch(
      gameId: string,
      groupId: string,
      body: unknown = undefined,
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
      return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/invitations`, init);
    }

    async function seedGroup(
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

    it("creates a direct-user invitation, returns 201, and writes an audit entry", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, { targetUserId: "user_alice" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as WireInvitation;
      expect(body.groupId).toBe(seed.groupId);
      expect(body.targetUserId).toBe("user_alice");
      expect(body.roleId).toBeNull();
      expect(body.expiresAt).toBeNull();
      expect(body.createdBy).toBeNull();
      expect(body.usedAt).toBeNull();
      expect(body.usedBy).toBeNull();
      expect(body.code).toMatch(/^[a-f0-9]{16}$/);
      expect(typeof body.id).toBe("string");
      expect(typeof body.createdAt).toBe("string");

      const stored = await prisma.invitation.findUnique({ where: { id: body.id } });
      expect(stored?.groupId).toBe(seed.groupId);
      expect(stored?.targetUserId).toBe("user_alice");
      expect(stored?.createdByUserId).toBeNull();
      expect(stored?.code).toBe(body.code);

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.invited" },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorUserId).toBeNull();
      expect(audit?.targetId).toBe("user_alice");
      const payload = audit?.payload as {
        invitationId: string;
        code: string;
        targetUserId: string | null;
        roleId: string | null;
        expiresAt: string | null;
        source: string;
      };
      expect(payload.invitationId).toBe(body.id);
      expect(payload.code).toBe(body.code);
      expect(payload.targetUserId).toBe("user_alice");
      expect(payload.roleId).toBeNull();
      expect(payload.expiresAt).toBeNull();
      expect(payload.source).toBe("admin");
    });

    it("creates an open-code invitation when targetUserId is omitted", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, {});
      expect(res.status).toBe(201);
      const body = (await res.json()) as WireInvitation;
      expect(body.targetUserId).toBeNull();
      expect(body.roleId).toBeNull();
      expect(body.expiresAt).toBeNull();
      expect(body.code).toMatch(/^[a-f0-9]{16}$/);

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.invited" },
      });
      expect(audit?.targetId).toBeNull();
      const payload = audit?.payload as { targetUserId: string | null; source: string };
      expect(payload.targetUserId).toBeNull();
      expect(payload.source).toBe("admin");
    });

    it("rejects a request with no JSON body (admin caller must send at least {})", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId);
      expect(res.status).toBe(400);
      const count = await prisma.invitation.count({ where: { groupId: seed.groupId } });
      expect(count).toBe(0);
    });

    it("forwards a roleId verbatim", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, {
        targetUserId: "user_bob",
        roleId: "role_officer",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as WireInvitation;
      expect(body.roleId).toBe("role_officer");

      const stored = await prisma.invitation.findFirst({ where: { groupId: seed.groupId } });
      expect(stored?.roleId).toBe("role_officer");

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.invited" },
      });
      const payload = audit?.payload as { roleId: string | null };
      expect(payload.roleId).toBe("role_officer");
    });

    it("computes expiresAt from a 7d duration string", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const before = Date.now();
      const res = await inviteFetch(seed.gameId, seed.groupId, { expiresIn: "7d" });
      const after = Date.now();
      expect(res.status).toBe(201);
      const body = (await res.json()) as WireInvitation;
      expect(body.expiresAt).not.toBeNull();
      const expiresMs = new Date(body.expiresAt as string).getTime();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
      expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs);

      const stored = await prisma.invitation.findUnique({ where: { id: body.id } });
      expect(stored?.expiresAt?.getTime()).toBe(expiresMs);

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.invited" },
      });
      const payload = audit?.payload as { expiresAt: string | null };
      expect(payload.expiresAt).toBe(body.expiresAt);
    });

    it("supports all four duration units (s|m|h|d)", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const cases = [
        { expiresIn: "30s", ms: 30 * 1000 },
        { expiresIn: "15m", ms: 15 * 60 * 1000 },
        { expiresIn: "2h", ms: 2 * 60 * 60 * 1000 },
        { expiresIn: "1d", ms: 24 * 60 * 60 * 1000 },
      ];
      for (const c of cases) {
        const before = Date.now();
        const res = await inviteFetch(seed.gameId, seed.groupId, { expiresIn: c.expiresIn });
        const after = Date.now();
        expect(res.status).toBe(201);
        const body = (await res.json()) as WireInvitation;
        const t = new Date(body.expiresAt as string).getTime();
        expect(t).toBeGreaterThanOrEqual(before + c.ms);
        expect(t).toBeLessThanOrEqual(after + c.ms);
      }
    });

    it("dispatches a member.invited JunjoEvent to SSE subscribers", async () => {
      const seed = await seedGroup("Alpha", "g1");
      // Open an SSE stream so the dispatched event has at least one
      // observer; without a subscriber the event is published but cannot
      // be observed. Use the eventHub directly via the test harness.
      const events: unknown[] = [];
      const { eventHub } = await import("../eventHub");
      const unsubscribe = eventHub.subscribe(seed.groupId as GroupId, (e) => {
        events.push(e);
      });
      try {
        const res = await inviteFetch(seed.gameId, seed.groupId, { targetUserId: "user_a" });
        expect(res.status).toBe(201);
        // dispatchEvent runs after the transaction; wait briefly then assert.
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(events).toHaveLength(1);
        const event = events[0] as {
          type: string;
          gameId: string;
          groupId: string;
          invitation: { code: string; targetUserId: string | null };
        };
        expect(event.type).toBe("member.invited");
        expect(event.gameId).toBe(seed.gameId);
        expect(event.groupId).toBe(seed.groupId);
        expect(event.invitation.targetUserId).toBe("user_a");
        expect(event.invitation.code).toMatch(/^[a-f0-9]{16}$/);
      } finally {
        unsubscribe();
      }
    });

    it("generates a unique code per call", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const codes = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const res = await inviteFetch(seed.gameId, seed.groupId, { targetUserId: `user_${i}` });
        const body = (await res.json()) as WireInvitation;
        codes.add(body.code);
      }
      expect(codes.size).toBe(5);
    });

    it("rejects malformed expiresIn with 400 and writes no row", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, { expiresIn: "7days" });
      expect(res.status).toBe(400);
      const count = await prisma.invitation.count({ where: { groupId: seed.groupId } });
      expect(count).toBe(0);
    });

    it("rejects non-positive expiresIn (e.g. '0d') with 400", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, { expiresIn: "0d" });
      expect(res.status).toBe(400);
      const count = await prisma.invitation.count({ where: { groupId: seed.groupId } });
      expect(count).toBe(0);
    });

    it("rejects an empty targetUserId with 400", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, { targetUserId: "" });
      expect(res.status).toBe(400);
    });

    it("rejects an over-cap targetUserId with 400", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, {
        targetUserId: "x".repeat(256),
      });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON with 400", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(seed.gameId, seed.groupId, "{ not json");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the group does not exist", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await inviteFetch(game.id, "missing-group", { targetUserId: "user_a" });
      expect(res.status).toBe(404);
      const count = await prisma.invitation.count();
      expect(count).toBe(0);
    });

    it("returns 404 when the group is soft-deleted", async () => {
      const seed = await seedGroup("Alpha", "g1", { softDeletedGroup: true });
      const res = await inviteFetch(seed.gameId, seed.groupId, { targetUserId: "user_a" });
      expect(res.status).toBe(404);
      const count = await prisma.invitation.count({ where: { groupId: seed.groupId } });
      expect(count).toBe(0);
    });

    it("returns 404 when the group belongs to a different game (cross-game)", async () => {
      const a = await createGame("Alpha", prisma);
      const seed = await seedGroup("Beta", "g1");
      const res = await inviteFetch(a.id, seed.groupId, { targetUserId: "user_a" });
      expect(res.status).toBe(404);
      // The invitation must not be created against the Beta group either.
      const count = await prisma.invitation.count({ where: { groupId: seed.groupId } });
      expect(count).toBe(0);
    });

    it("returns 401 with no Authorization header", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/invitations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ targetUserId: "user_a" }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with a wrong admin token", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const res = await inviteFetch(
        seed.gameId,
        seed.groupId,
        { targetUserId: "user_a" },
        "Bearer not-the-real-token",
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
      const noTokenApp = createApp({ prisma });
      const game = await createGame("Alpha", prisma);
      const group = await prisma.group.create({
        data: {
          gameId: game.id,
          kind: "guild",
          name: "g1",
          visibility: "invite-only",
        },
      });
      const res = await noTokenApp.request(
        `/v1/admin/games/${game.id}/groups/${group.id}/invitations`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ targetUserId: "user_a" }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("URL-decodes path-encoded gameId and groupId", async () => {
      const seed = await seedGroup("Alpha", "g1");
      const encGame = encodeURIComponent(seed.gameId);
      const encGroup = encodeURIComponent(seed.groupId);
      const res = await app.request(`/v1/admin/games/${encGame}/groups/${encGroup}/invitations`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: "user_a" }),
      });
      expect(res.status).toBe(201);
    });
  },
);
