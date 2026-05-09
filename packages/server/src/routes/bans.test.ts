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

describe.skipIf(!TEST_DATABASE_URL)("Game bans (/v1/bans)", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "GameBan", "Invitation", "AuditEntry", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function postBan(body: unknown) {
    return app.request("/v1/bans", {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function deleteBan(userId: string) {
    return app.request(`/v1/bans/${encodeURIComponent(userId)}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
  }

  function listBans(query = "") {
    const path = query ? `/v1/bans?${query}` : "/v1/bans";
    return app.request(path, { headers: { authorization: authHeader } });
  }

  async function makeGroup(visibility: "public" | "invite-only" | "secret", name: string) {
    return prisma.group.create({
      data: { gameId, kind: "guild", name, visibility, metadata: {} },
    });
  }

  describe("POST /v1/bans", () => {
    it("creates a permanent game-level ban", async () => {
      const res = await postBan({ userId: "alice", reason: "cheating" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        userId: string;
        expiresAt: string | null;
        reason: string | null;
      };
      expect(body.userId).toBe("alice");
      expect(body.expiresAt).toBeNull();
      expect(body.reason).toBe("cheating");

      const stored = await prisma.gameBan.findFirst({
        include: { junjoUser: { include: { externalIdentities: true } } },
      });
      expect(stored?.expiresAt).toBeNull();
      expect(stored?.junjoUser.externalIdentities[0]?.externalUserId).toBe("alice");
    });

    it("accepts an ISO expiresAt for a time-bounded ban", async () => {
      const future = new Date(Date.now() + 60_000).toISOString();
      const res = await postBan({ userId: "alice", expiresAt: future });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresAt: string };
      expect(body.expiresAt).toBe(future);
    });

    it("upserts: re-banning an active user keeps original bannedAt", async () => {
      const first = await postBan({ userId: "alice", reason: "rude" });
      const firstBody = (await first.json()) as { bannedAt: string };

      const second = await postBan({ userId: "alice", reason: "still rude" });
      expect(second.status).toBe(201);
      const secondBody = (await second.json()) as { bannedAt: string; reason: string };
      // bannedAt is preserved while the prior ban is still active.
      expect(secondBody.bannedAt).toBe(firstBody.bannedAt);
      expect(secondBody.reason).toBe("still rude");
    });

    it("upserts: re-banning after expiry refreshes bannedAt", async () => {
      const first = await postBan({
        userId: "alice",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const firstBody = (await first.json()) as { bannedAt: string };
      // Backdate the existing row to look expired.
      await prisma.gameBan.updateMany({
        where: {},
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const second = await postBan({ userId: "alice" });
      const secondBody = (await second.json()) as { bannedAt: string };
      expect(secondBody.bannedAt).not.toBe(firstBody.bannedAt);
    });

    it("rejects a malformed expiresAt with 400", async () => {
      const res = await postBan({ userId: "alice", expiresAt: "garbage" });
      expect(res.status).toBe(400);
    });

    it("rejects a body missing userId with 400", async () => {
      const res = await postBan({});
      expect(res.status).toBe(400);
    });

    it("rejects extra body keys (.strict)", async () => {
      const res = await postBan({ userId: "alice", weird: 1 });
      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /v1/bans/:userId", () => {
    it("removes an active ban and 204s", async () => {
      await postBan({ userId: "alice" });
      const res = await deleteBan("alice");
      expect(res.status).toBe(204);
      const remaining = await prisma.gameBan.count();
      expect(remaining).toBe(0);
    });

    it("404s when no ban exists for the user", async () => {
      const res = await deleteBan("alice");
      expect(res.status).toBe(404);
    });

    it("404s for a user who has never been seen in this game", async () => {
      const res = await deleteBan("ghost");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/bans", () => {
    it("returns active bans newest-first by default", async () => {
      await postBan({ userId: "alice" });
      await postBan({ userId: "bob" });

      const res = await listBans();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: Array<{ userId: string }> };
      // Newest-first: bob (most recent) comes before alice.
      expect(body.items.map((b) => b.userId)).toEqual(["bob", "alice"]);
    });

    it("hides expired bans by default", async () => {
      await postBan({ userId: "alice" });
      await postBan({
        userId: "bob",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      // Backdate bob's expiry into the past.
      await prisma.gameBan.updateMany({
        where: { junjoUser: { externalIdentities: { some: { externalUserId: "bob" } } } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await listBans();
      const body = (await res.json()) as { items: Array<{ userId: string }> };
      expect(body.items.map((b) => b.userId)).toEqual(["alice"]);
    });

    it("includes expired bans when includeExpired=true", async () => {
      await postBan({ userId: "alice" });
      await postBan({
        userId: "bob",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await prisma.gameBan.updateMany({
        where: { junjoUser: { externalIdentities: { some: { externalUserId: "bob" } } } },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await listBans("includeExpired=true");
      const body = (await res.json()) as { items: Array<{ userId: string }> };
      expect(body.items.map((b) => b.userId).sort()).toEqual(["alice", "bob"]);
    });

    it("paginates via cursor + limit", async () => {
      for (let i = 0; i < 5; i++) {
        await postBan({ userId: `user_${i}` });
      }
      const page1 = await listBans("limit=2");
      const body1 = (await page1.json()) as {
        items: Array<{ id: string; userId: string }>;
        nextCursor: string | null;
      };
      expect(body1.items).toHaveLength(2);
      expect(body1.nextCursor).not.toBeNull();

      const page2 = await listBans(`limit=2&cursor=${body1.nextCursor}`);
      const body2 = (await page2.json()) as {
        items: Array<{ userId: string }>;
        nextCursor: string | null;
      };
      expect(body2.items).toHaveLength(2);
      const seen = new Set([
        ...body1.items.map((b) => b.userId),
        ...body2.items.map((b) => b.userId),
      ]);
      expect(seen.size).toBe(4);
    });
  });

  describe("Cross-group enforcement", () => {
    it("blocks public-join across multiple groups when game-banned", async () => {
      const a = await makeGroup("public", "a");
      const b = await makeGroup("public", "b");
      await postBan({ userId: "alice" });

      const r1 = await app.request(`/v1/groups/${a.id}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ userId: "alice" }),
      });
      const r2 = await app.request(`/v1/groups/${b.id}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ userId: "alice" }),
      });
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(403);
    });

    it("re-allows joins after the game-ban is removed", async () => {
      const pub = await makeGroup("public", "p");
      await postBan({ userId: "alice" });
      await deleteBan("alice");

      const res = await app.request(`/v1/groups/${pub.id}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ userId: "alice" }),
      });
      expect(res.status).toBe(201);
    });

    it("re-allows joins after a game-ban expires (lazy expiry)", async () => {
      const pub = await makeGroup("public", "p");
      await postBan({
        userId: "alice",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await prisma.gameBan.updateMany({
        where: {},
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await app.request(`/v1/groups/${pub.id}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ userId: "alice" }),
      });
      expect(res.status).toBe(201);
    });

    it("a per-group ban does not affect joins of other groups", async () => {
      const a = await makeGroup("public", "a");
      const b = await makeGroup("public", "b");
      // Per-group ban on a only.
      const banRes = await app.request(`/v1/groups/${a.id}/members/alice/ban`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(banRes.status).toBe(200);

      const r1 = await app.request(`/v1/groups/${a.id}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ userId: "alice" }),
      });
      const r2 = await app.request(`/v1/groups/${b.id}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ userId: "alice" }),
      });
      expect(r1.status).toBe(403);
      expect(r2.status).toBe(201);
    });
  });
});
