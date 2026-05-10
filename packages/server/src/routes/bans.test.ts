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

  describe("Audit trail (game-scoped)", () => {
    it("writes a game.user.banned AuditEntry with groupId=null", async () => {
      await postBan({ userId: "alice", reason: "cheating" });
      const entries = await prisma.auditEntry.findMany({
        where: { gameId, action: "game.user.banned" },
      });
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      if (!entry) throw new Error("expected a game.user.banned entry");
      expect(entry.groupId).toBeNull();
      expect(entry.targetId).toBe("alice");
      const payload = entry.payload as { reason?: string; expiresAt?: string | null };
      expect(payload.reason).toBe("cheating");
      expect(payload.expiresAt).toBeNull();
    });

    it("writes a game.user.unbanned AuditEntry on delete", async () => {
      await postBan({ userId: "alice" });
      await deleteBan("alice");
      const entries = await prisma.auditEntry.findMany({
        where: { gameId, action: "game.user.unbanned" },
      });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.groupId).toBeNull();
      expect(entries[0]?.targetId).toBe("alice");
    });
  });

  describe("GET /v1/bans/:userId", () => {
    function getBan(userId: string) {
      return app.request(`/v1/bans/${encodeURIComponent(userId)}`, {
        headers: { authorization: authHeader },
      });
    }

    it("returns the active ban for a user", async () => {
      await postBan({ userId: "alice", reason: "cheating" });
      const res = await getBan("alice");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { userId: string; reason: string | null };
      expect(body.userId).toBe("alice");
      expect(body.reason).toBe("cheating");
    });

    it("404s when the user has never been seen", async () => {
      const res = await getBan("ghost");
      expect(res.status).toBe(404);
    });

    it("404s when the user is known but not banned", async () => {
      await postBan({ userId: "alice" });
      await deleteBan("alice");
      const res = await getBan("alice");
      expect(res.status).toBe(404);
    });

    it("404s when the ban has lazy-expired", async () => {
      await postBan({
        userId: "alice",
        expiresAt: new Date(Date.now() + 200).toISOString(),
      });
      await new Promise((r) => setTimeout(r, 250));
      const res = await getBan("alice");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/bans/:userId/history", () => {
    function getHistory(userId: string, query = "") {
      const path = query
        ? `/v1/bans/${encodeURIComponent(userId)}/history?${query}`
        : `/v1/bans/${encodeURIComponent(userId)}/history`;
      return app.request(path, { headers: { authorization: authHeader } });
    }

    it("returns set + lifted rows newest-first", async () => {
      await postBan({ userId: "alice", reason: "first" });
      await deleteBan("alice");
      await postBan({ userId: "alice", reason: "second" });
      const res = await getHistory("alice");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: { kind: string; reason: string | null; scope: string }[];
      };
      expect(body.items).toHaveLength(3);
      expect(body.items[0]?.kind).toBe("set");
      expect(body.items[0]?.reason).toBe("second");
      expect(body.items[1]?.kind).toBe("lifted");
      expect(body.items[2]?.kind).toBe("set");
      expect(body.items[2]?.reason).toBe("first");
      expect(body.items.every((i) => i.scope === "game")).toBe(true);
    });

    it("returns an empty page for an unknown user (no 404)", async () => {
      const res = await getHistory("ghost");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
      expect(body.items).toEqual([]);
      expect(body.nextCursor).toBeNull();
    });

    it("filters by scope=game", async () => {
      await postBan({ userId: "alice" });
      const res = await getHistory("alice", "scope=game");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: { scope: string }[] };
      expect(body.items.every((i) => i.scope === "game")).toBe(true);
    });

    it("rejects scope=game + groupId combo with 400", async () => {
      const res = await getHistory("alice", "scope=game&groupId=abc");
      expect(res.status).toBe(400);
    });
  });

  describe("Actor attribution (actorUserId)", () => {
    function getHistory(userId: string) {
      return app.request(`/v1/bans/${encodeURIComponent(userId)}/history`, {
        headers: { authorization: authHeader },
      });
    }

    it("populates GameBan.bannedByUserId, BanHistory.actorJunjoUserId, AuditEntry.actorUserId", async () => {
      await postBan({ userId: "alice", reason: "cheating", actorUserId: "mod_bob" });

      const ban = await prisma.gameBan.findFirstOrThrow({ where: { gameId } });
      expect(ban.bannedByUserId).not.toBeNull();

      const history = await prisma.banHistory.findFirstOrThrow({
        where: { gameId, kind: "set" },
      });
      expect(history.actorJunjoUserId).toBe(ban.bannedByUserId);

      const audit = await prisma.auditEntry.findFirstOrThrow({
        where: { gameId, action: "game.user.banned" },
      });
      expect(audit.actorUserId).toBe(ban.bannedByUserId);
    });

    it("returns the actor external id back via Ban.bannedBy", async () => {
      const res = await postBan({ userId: "alice", actorUserId: "mod_bob" });
      const body = (await res.json()) as { bannedBy: string | null };
      expect(body.bannedBy).toBe("mod_bob");
    });

    it("the history endpoint surfaces actorUserId per row", async () => {
      await postBan({ userId: "alice", actorUserId: "mod_bob" });
      await deleteBan("alice");
      const res = await getHistory("alice");
      const body = (await res.json()) as {
        items: { kind: string; actorUserId: string | null }[];
      };
      // Newest first: lifted (no actor), then set (actor=mod_bob).
      expect(body.items[0]?.kind).toBe("lifted");
      expect(body.items[0]?.actorUserId).toBeNull();
      expect(body.items[1]?.kind).toBe("set");
      expect(body.items[1]?.actorUserId).toBe("mod_bob");
    });

    it("auto-creates a JunjoUser for the actor if unknown", async () => {
      await postBan({ userId: "alice", actorUserId: "brand_new_mod" });
      const ext = await prisma.externalIdentity.findFirstOrThrow({
        where: { gameId, externalUserId: "brand_new_mod" },
      });
      expect(ext.junjoUserId).not.toBeNull();
    });

    it("DELETE /v1/bans/:userId attributes the unban via body.actorUserId", async () => {
      await postBan({ userId: "alice", actorUserId: "mod_bob" });
      // Unban with a different moderator.
      await app.request("/v1/bans/alice", {
        method: "DELETE",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ actorUserId: "mod_carol" }),
      });

      const liftedHistory = await prisma.banHistory.findFirstOrThrow({
        where: { gameId, kind: "lifted" },
      });
      expect(liftedHistory.actorJunjoUserId).not.toBeNull();

      const liftedAudit = await prisma.auditEntry.findFirstOrThrow({
        where: { gameId, action: "game.user.unbanned" },
      });
      expect(liftedAudit.actorUserId).toBe(liftedHistory.actorJunjoUserId);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Members ?status= filter", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;
  let groupId: string;

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
    const group = await prisma.group.create({
      data: { gameId, kind: "guild", name: "G", visibility: "invite-only", metadata: {} },
    });
    groupId = group.id;

    // Seed 4 members in 4 different states.
    for (const [userId, status] of [
      ["alice", "active"],
      ["bob", "left"],
      ["carol", "kicked"],
      ["dan", "banned"],
    ] as const) {
      const ju = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, externalUserId: userId, junjoUserId: ju.id },
      });
      await prisma.groupMember.create({
        data: { groupId: group.id, junjoUserId: ju.id, status },
      });
    }
  });

  function listMembers(query = "") {
    const path = query
      ? `/v1/groups/${encodeURIComponent(groupId)}/members?${query}`
      : `/v1/groups/${encodeURIComponent(groupId)}/members`;
    return app.request(path, { headers: { authorization: authHeader } });
  }

  it("returns every status when no filter is supplied", async () => {
    const res = await listMembers();
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(4);
  });

  it("filters to a single status", async () => {
    const res = await listMembers("status=banned");
    const body = (await res.json()) as { items: { userId: string; status: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.userId).toBe("dan");
    expect(body.items[0]?.status).toBe("banned");
  });

  it("filters to a comma-separated subset", async () => {
    const res = await listMembers("status=kicked,banned");
    const body = (await res.json()) as { items: { status: string }[] };
    expect(body.items).toHaveLength(2);
    expect(new Set(body.items.map((i) => i.status))).toEqual(new Set(["kicked", "banned"]));
  });

  it("rejects an unknown status with 400", async () => {
    const res = await listMembers("status=ghost");
    expect(res.status).toBe(400);
  });
});
