import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)("Group passcode", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function createGroup(body: Record<string, unknown>) {
    return app.request("/v1/groups", {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function patchGroup(id: string, body: Record<string, unknown>) {
    return app.request(`/v1/groups/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function joinGroup(id: string, body: Record<string, unknown>) {
    return app.request(`/v1/groups/${encodeURIComponent(id)}/join`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  describe("create + serialize", () => {
    it("hashes passcode on create and surfaces hasPasscode=true", async () => {
      const res = await createGroup({
        kind: "room",
        name: "Lounge",
        visibility: "public",
        passcode: "let-me-in",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; hasPasscode: boolean };
      expect(body.hasPasscode).toBe(true);

      const row = await prisma.group.findUniqueOrThrow({ where: { id: body.id } });
      expect(row.passcodeHash).not.toBeNull();
      expect(row.passcodeHash).not.toBe("let-me-in");
      expect(row.passcodeSetAt).not.toBeNull();
    });

    it("hasPasscode=false when no passcode is supplied", async () => {
      const res = await createGroup({ kind: "room", name: "Open", visibility: "public" });
      const body = (await res.json()) as { hasPasscode: boolean };
      expect(body.hasPasscode).toBe(false);
    });

    it("rejects passcodes shorter than 4 chars", async () => {
      const res = await createGroup({
        kind: "room",
        name: "X",
        visibility: "public",
        passcode: "ab",
      });
      expect(res.status).toBe(400);
    });
  });

  describe("update", () => {
    let groupId: string;
    beforeEach(async () => {
      const res = await createGroup({ kind: "room", name: "G", visibility: "public" });
      groupId = ((await res.json()) as { id: string }).id;
    });

    it("setting passcode flips hasPasscode and writes group.passcode.set audit", async () => {
      const res = await patchGroup(groupId, { passcode: "rotate-me" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hasPasscode: boolean };
      expect(body.hasPasscode).toBe(true);

      const audits = await prisma.auditEntry.findMany({
        where: { groupId, action: "group.passcode.set" },
      });
      expect(audits).toHaveLength(1);
      expect((audits[0]?.payload as { transition: string }).transition).toBe("set");
    });

    it("rotating passcode writes a 'rotated' audit", async () => {
      await patchGroup(groupId, { passcode: "first-pass" });
      const res = await patchGroup(groupId, { passcode: "second-pass" });
      expect(res.status).toBe(200);
      const audits = await prisma.auditEntry.findMany({
        where: { groupId, action: "group.passcode.set" },
        orderBy: { createdAt: "asc" },
      });
      expect(audits).toHaveLength(2);
      expect((audits[1]?.payload as { transition: string }).transition).toBe("rotated");
    });

    it("clearing passcode (null) flips hasPasscode and writes group.passcode.cleared", async () => {
      await patchGroup(groupId, { passcode: "temp-pass" });
      const res = await patchGroup(groupId, { passcode: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hasPasscode: boolean };
      expect(body.hasPasscode).toBe(false);
      const row = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
      expect(row.passcodeHash).toBeNull();
      expect(row.passcodeSetAt).toBeNull();

      const cleared = await prisma.auditEntry.findMany({
        where: { groupId, action: "group.passcode.cleared" },
      });
      expect(cleared).toHaveLength(1);
    });

    it("omitting passcode in PATCH leaves the existing one untouched", async () => {
      await patchGroup(groupId, { passcode: "keep-me" });
      const res = await patchGroup(groupId, { name: "Renamed" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { hasPasscode: boolean; name: string };
      expect(body.hasPasscode).toBe(true);
      expect(body.name).toBe("Renamed");
    });

    it("clearing on a group with no passcode is a no-op (no audit row)", async () => {
      const res = await patchGroup(groupId, { passcode: null, name: "Noop" });
      expect(res.status).toBe(200);
      const audits = await prisma.auditEntry.findMany({
        where: { groupId, action: { in: ["group.passcode.set", "group.passcode.cleared"] } },
      });
      expect(audits).toHaveLength(0);
    });
  });

  describe("join enforcement", () => {
    let groupId: string;
    beforeEach(async () => {
      const res = await createGroup({
        kind: "room",
        name: "Gated",
        visibility: "public",
        passcode: "open-sesame",
      });
      groupId = ((await res.json()) as { id: string }).id;
    });

    it("rejects join with no passcode (403 passcode_required)", async () => {
      const res = await joinGroup(groupId, { userId: "alice" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("passcode_required");
    });

    it("rejects join with wrong passcode (403 passcode_invalid)", async () => {
      const res = await joinGroup(groupId, { userId: "alice", passcode: "wrong-pass" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("passcode_invalid");
    });

    it("accepts join with correct passcode", async () => {
      const res = await joinGroup(groupId, { userId: "alice", passcode: "open-sesame" });
      expect(res.status).toBe(201);
    });

    it("does not auto-create JunjoUser on a failed passcode attempt", async () => {
      await joinGroup(groupId, { userId: "ghost", passcode: "wrong" });
      const ext = await prisma.externalIdentity.findFirst({
        where: { gameId, externalUserId: "ghost" },
      });
      expect(ext).toBeNull();
    });

    it("public-join still works on a group with no passcode", async () => {
      const openRes = await createGroup({ kind: "room", name: "Open", visibility: "public" });
      const openId = ((await openRes.json()) as { id: string }).id;
      const res = await joinGroup(openId, { userId: "alice" });
      expect(res.status).toBe(201);
    });
  });

  describe("rate limiting", () => {
    let groupId: string;
    beforeEach(async () => {
      const res = await createGroup({
        kind: "room",
        name: "Locked",
        visibility: "public",
        passcode: "right-passcode",
      });
      groupId = ((await res.json()) as { id: string }).id;
    });

    it("429s after 5 wrong attempts from the same userId in one minute", async () => {
      // Per-(group, userId) bucket is configured at burst=5.
      for (let i = 0; i < 5; i++) {
        const res = await joinGroup(groupId, { userId: "alice", passcode: "wrong" });
        expect(res.status).toBe(403);
      }
      const res = await joinGroup(groupId, { userId: "alice", passcode: "wrong" });
      expect(res.status).toBe(429);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("rate_limit_exceeded");
      expect(res.headers.get("retry-after")).not.toBeNull();
    });

    it("eventually 429s the per-group cap when attempts fan out across userIds", async () => {
      // Per-group bucket is configured at burst=30, perMinute=30 (refill
      // rate of 0.5/sec). scrypt verify is intentionally slow, so the
      // per-call latency lets a small amount of refill happen while the
      // test runs. Spam well past `burst + expected_refill_during_test`
      // and assert that SOMEWHERE in the back half a 429 surfaces. This
      // test would be tighter with an injectable clock; rather than wire
      // one through groupsRouter for now, just spam.
      let saw429 = false;
      for (let i = 0; i < 80; i++) {
        const res = await joinGroup(groupId, { userId: `u${i}`, passcode: "wrong" });
        if (res.status === 429) {
          saw429 = true;
          break;
        }
        expect(res.status).toBe(403);
      }
      expect(saw429).toBe(true);
    }, 30000);

    it("does not rate-limit groups without a passcode", async () => {
      const openRes = await createGroup({ kind: "room", name: "Open", visibility: "public" });
      const openId = ((await openRes.json()) as { id: string }).id;
      // 6 distinct users joining successfully would bust the per-(group,
      // userId) cap if it applied; but it shouldn't, since there's no
      // passcode on this group.
      for (let i = 0; i < 6; i++) {
        const res = await joinGroup(openId, { userId: `u${i}` });
        expect(res.status).toBe(201);
      }
    });
  });
});
