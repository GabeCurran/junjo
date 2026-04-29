import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/users/:junjoUserId/games", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function adminFetch(junjoUserId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/users/${junjoUserId}/games`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  // Seeds a Junjo user across N games, with optional per-game memberships in
  // distinct statuses or soft-delete state. Returns the JunjoUser id and a
  // record of created game ids for assertion convenience.
  async function seedUserAcrossGames(
    plan: Array<{
      gameName: string;
      externalUserId: string;
      memberships?: Array<{
        status?: "active" | "left" | "kicked" | "invited";
        groupSoftDeleted?: boolean;
      }>;
    }>,
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    const gameRows: Array<{ id: string; externalUserId: string }> = [];
    for (const entry of plan) {
      const game = await createGame(entry.gameName, prisma);
      await prisma.externalIdentity.create({
        data: {
          gameId: game.id,
          junjoUserId: user.id,
          externalUserId: entry.externalUserId,
        },
      });
      gameRows.push({ id: game.id, externalUserId: entry.externalUserId });
      for (const m of entry.memberships ?? []) {
        const group = await prisma.group.create({
          data: {
            gameId: game.id,
            kind: "guild",
            name: `${entry.gameName}-grp-${Math.random()}`,
            visibility: "invite-only",
            metadata: {},
            softDeletedAt: m.groupSoftDeleted ? new Date() : null,
          },
        });
        await prisma.groupMember.create({
          data: { groupId: group.id, junjoUserId: user.id, status: m.status ?? "active" },
        });
      }
    }
    return { junjoUserId: user.id, games: gameRows };
  }

  it("returns the user's games with active group counts", async () => {
    const seeded = await seedUserAcrossGames([
      {
        gameName: "Alpha",
        externalUserId: "user_alpha",
        memberships: [{ status: "active" }, { status: "active" }],
      },
      {
        gameName: "Beta",
        externalUserId: "user_beta",
        memberships: [{ status: "active" }],
      },
    ]);

    const res = await adminFetch(seeded.junjoUserId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      junjoUserId: string;
      games: Array<{ gameId: string; externalUserId: string; joinedGroupCount: number }>;
    };
    expect(body.junjoUserId).toBe(seeded.junjoUserId);
    expect(body.games).toHaveLength(2);

    const byId = new Map(body.games.map((g) => [g.gameId, g]));
    const alpha = seeded.games[0];
    const beta = seeded.games[1];
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    if (!alpha || !beta) return;
    expect(byId.get(alpha.id)?.externalUserId).toBe("user_alpha");
    expect(byId.get(alpha.id)?.joinedGroupCount).toBe(2);
    expect(byId.get(beta.id)?.externalUserId).toBe("user_beta");
    expect(byId.get(beta.id)?.joinedGroupCount).toBe(1);
  });

  it("returns games sorted by gameId ascending", async () => {
    const seeded = await seedUserAcrossGames([
      { gameName: "A", externalUserId: "u_a" },
      { gameName: "B", externalUserId: "u_b" },
      { gameName: "C", externalUserId: "u_c" },
    ]);
    const res = await adminFetch(seeded.junjoUserId);
    const body = (await res.json()) as { games: Array<{ gameId: string }> };
    const ids = body.games.map((g) => g.gameId);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("includes games with zero active memberships", async () => {
    const seeded = await seedUserAcrossGames([
      { gameName: "Alpha", externalUserId: "user_alpha", memberships: [] },
    ]);
    const res = await adminFetch(seeded.junjoUserId);
    const body = (await res.json()) as { games: Array<{ joinedGroupCount: number }> };
    expect(body.games).toHaveLength(1);
    expect(body.games[0]?.joinedGroupCount).toBe(0);
  });

  it("excludes left/kicked/invited members from joinedGroupCount", async () => {
    const seeded = await seedUserAcrossGames([
      {
        gameName: "Alpha",
        externalUserId: "user_alpha",
        memberships: [
          { status: "active" },
          { status: "left" },
          { status: "kicked" },
          { status: "invited" },
        ],
      },
    ]);
    const res = await adminFetch(seeded.junjoUserId);
    const body = (await res.json()) as { games: Array<{ joinedGroupCount: number }> };
    expect(body.games[0]?.joinedGroupCount).toBe(1);
  });

  it("excludes soft-deleted groups from joinedGroupCount", async () => {
    const seeded = await seedUserAcrossGames([
      {
        gameName: "Alpha",
        externalUserId: "user_alpha",
        memberships: [{ status: "active" }, { status: "active", groupSoftDeleted: true }],
      },
    ]);
    const res = await adminFetch(seeded.junjoUserId);
    const body = (await res.json()) as { games: Array<{ joinedGroupCount: number }> };
    expect(body.games[0]?.joinedGroupCount).toBe(1);
  });

  it("returns 200 with empty games array for a junjoUserId with no ExternalIdentity rows", async () => {
    const user = await prisma.junjoUser.create({ data: {} });
    const res = await adminFetch(user.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      junjoUserId: string;
      games: unknown[];
    };
    expect(body.junjoUserId).toBe(user.id);
    expect(body.games).toEqual([]);
  });

  it("returns 200 with empty games array for a junjoUserId that does not exist at all", async () => {
    // No JunjoUser row created; the route does not 404 on unknown ids
    // because it cannot distinguish "user we have never seen" from "user
    // exists but has no ExternalIdentity rows yet" without leaking
    // existence.
    const res = await adminFetch("nonexistent_user_id");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { games: unknown[] };
    expect(body.games).toEqual([]);
  });

  it("does not leak counts across users", async () => {
    const seededA = await seedUserAcrossGames([
      {
        gameName: "Shared",
        externalUserId: "user_a",
        memberships: [{ status: "active" }, { status: "active" }],
      },
    ]);
    // A second user exists in the same game with their own active memberships.
    const userB = await prisma.junjoUser.create({ data: {} });
    const sharedGameId = seededA.games[0]?.id;
    expect(sharedGameId).toBeDefined();
    if (!sharedGameId) return;
    await prisma.externalIdentity.create({
      data: { gameId: sharedGameId, junjoUserId: userB.id, externalUserId: "user_b" },
    });
    const groupB = await prisma.group.create({
      data: {
        gameId: sharedGameId,
        kind: "guild",
        name: "B-only",
        visibility: "invite-only",
        metadata: {},
      },
    });
    await prisma.groupMember.create({
      data: { groupId: groupB.id, junjoUserId: userB.id, status: "active" },
    });

    const res = await adminFetch(seededA.junjoUserId);
    const body = (await res.json()) as { games: Array<{ joinedGroupCount: number }> };
    // User A has 2 active memberships in Shared; user B's separate
    // membership must not be counted under user A.
    expect(body.games[0]?.joinedGroupCount).toBe(2);
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.request("/v1/users/some_id/games", { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests with the wrong admin token", async () => {
    const res = await adminFetch("any_id", "Bearer wrong-token");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests using a per-game API key", async () => {
    // The cross-game endpoint must not be reachable by a per-game key,
    // even one that would otherwise authenticate against
    // `apiKeyMiddleware`. We do not need to mint a real API key; the
    // admin middleware rejects anything that does not match the admin
    // token, before the apiKey middleware would even run.
    const res = await adminFetch("any_id", "Bearer junjo_pk_some_prefix.some_secret_value");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request("/v1/users/any_id/games", {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_admin_token");
    expect(body.message).toMatch(/disabled/i);
  });

  it("URL-decodes the junjoUserId path parameter", async () => {
    const seeded = await seedUserAcrossGames([
      { gameName: "Alpha", externalUserId: "user_alpha", memberships: [{ status: "active" }] },
    ]);
    const encoded = encodeURIComponent(seeded.junjoUserId);
    const res = await adminFetch(encoded);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { junjoUserId: string };
    expect(body.junjoUserId).toBe(seeded.junjoUserId);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/stats", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function statsFetch(header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request("/v1/admin/stats", {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns zero counts on an empty database", async () => {
    const res = await statsFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({
      totalGames: 0,
      totalGroups: 0,
      totalActiveMembers: 0,
      totalAuditEntriesLast24h: 0,
    });
  });

  it("counts games, groups, active members, and 24h audit events", async () => {
    const game1 = await createGame("Alpha", prisma);
    const game2 = await createGame("Beta", prisma);
    const group1 = await prisma.group.create({
      data: {
        gameId: game1.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const group2 = await prisma.group.create({
      data: {
        gameId: game2.id,
        kind: "guild",
        name: "g2",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const userA = await prisma.junjoUser.create({ data: {} });
    const userB = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.create({
      data: { groupId: group1.id, junjoUserId: userA.id, status: "active" },
    });
    await prisma.groupMember.create({
      data: { groupId: group2.id, junjoUserId: userB.id, status: "active" },
    });
    await prisma.auditEntry.create({
      data: { groupId: group1.id, action: "group.created", payload: {} },
    });
    await prisma.auditEntry.create({
      data: { groupId: group2.id, action: "group.updated", payload: {} },
    });

    const res = await statsFetch();
    const body = (await res.json()) as Record<string, number>;
    expect(body).toEqual({
      totalGames: 2,
      totalGroups: 2,
      totalActiveMembers: 2,
      totalAuditEntriesLast24h: 2,
    });
  });

  it("excludes soft-deleted groups from totalGroups", async () => {
    const game = await createGame("Alpha", prisma);
    await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "live",
        visibility: "invite-only",
        metadata: {},
      },
    });
    await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "deleted",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: new Date(),
      },
    });
    const res = await statsFetch();
    const body = (await res.json()) as Record<string, number>;
    expect(body.totalGroups).toBe(1);
  });

  it("excludes left/kicked/invited and soft-deleted-group members from totalActiveMembers", async () => {
    const game = await createGame("Alpha", prisma);
    const liveGroup = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "live",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const deletedGroup = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "deleted",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: new Date(),
      },
    });
    for (const status of ["active", "left", "kicked", "invited"] as const) {
      const u = await prisma.junjoUser.create({ data: {} });
      await prisma.groupMember.create({
        data: { groupId: liveGroup.id, junjoUserId: u.id, status },
      });
    }
    // Active member in a soft-deleted group should NOT be counted.
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.create({
      data: { groupId: deletedGroup.id, junjoUserId: u.id, status: "active" },
    });
    const res = await statsFetch();
    const body = (await res.json()) as Record<string, number>;
    expect(body.totalActiveMembers).toBe(1);
  });

  it("only counts audit entries within the last 24 hours", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const now = Date.now();
    const justInside = new Date(now - 60 * 60 * 1000); // 1h ago
    const wayOutside = new Date(now - 48 * 60 * 60 * 1000); // 48h ago
    await prisma.auditEntry.create({
      data: { groupId: group.id, action: "group.created", payload: {}, createdAt: justInside },
    });
    await prisma.auditEntry.create({
      data: { groupId: group.id, action: "group.updated", payload: {}, createdAt: wayOutside },
    });
    const res = await statsFetch();
    const body = (await res.json()) as Record<string, number>;
    expect(body.totalAuditEntriesLast24h).toBe(1);
  });

  it("includes audit entries from soft-deleted groups in the 24h count", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: new Date(),
      },
    });
    await prisma.auditEntry.create({
      data: { groupId: group.id, action: "group.deleted", payload: {} },
    });
    const res = await statsFetch();
    const body = (await res.json()) as Record<string, number>;
    expect(body.totalAuditEntriesLast24h).toBe(1);
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.request("/v1/admin/stats", { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests with the wrong admin token", async () => {
    const res = await statsFetch("Bearer nope");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request("/v1/admin/stats", {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("invalid_admin_token");
    expect(body.message).toMatch(/disabled/i);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/audit", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function auditFetch(query = "", header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/audit${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  type WireItem = {
    id: string;
    action: string;
    gameId: string;
    gameName: string;
    groupId: string;
    groupName: string;
    groupSoftDeleted: boolean;
    actorUserId: string | null;
    targetId: string | null;
    payload: Record<string, unknown>;
    createdAt: string;
  };

  it("returns an empty items array when no audit entries exist", async () => {
    const res = await auditFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items).toEqual([]);
  });

  it("returns recent audit entries with game + group names pivoted in", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "Vanguard",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const actor = await prisma.junjoUser.create({ data: {} });
    const created = await prisma.auditEntry.create({
      data: {
        groupId: group.id,
        action: "member.joined",
        actorUserId: actor.id,
        targetId: "user_xyz",
        payload: { foo: "bar" },
      },
    });

    const res = await auditFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    expect(item).toBeDefined();
    if (!item) return;
    expect(item.id).toBe(created.id);
    expect(item.action).toBe("member.joined");
    expect(item.gameId).toBe(game.id);
    expect(item.gameName).toBe("Alpha");
    expect(item.groupId).toBe(group.id);
    expect(item.groupName).toBe("Vanguard");
    expect(item.groupSoftDeleted).toBe(false);
    expect(item.actorUserId).toBe(actor.id);
    expect(item.targetId).toBe("user_xyz");
    expect(item.payload).toEqual({ foo: "bar" });
    expect(item.createdAt).toBe(created.createdAt.toISOString());
  });

  it("orders entries by createdAt desc, id desc (newest first)", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const t = Date.now();
    await prisma.auditEntry.create({
      data: {
        groupId: group.id,
        action: "group.created",
        payload: {},
        createdAt: new Date(t - 5000),
      },
    });
    await prisma.auditEntry.create({
      data: {
        groupId: group.id,
        action: "group.updated",
        payload: {},
        createdAt: new Date(t - 1000),
      },
    });
    await prisma.auditEntry.create({
      data: {
        groupId: group.id,
        action: "member.joined",
        payload: {},
        createdAt: new Date(t),
      },
    });
    const res = await auditFetch();
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items.map((i) => i.action)).toEqual([
      "member.joined",
      "group.updated",
      "group.created",
    ]);
  });

  it("includes audit entries from soft-deleted groups with groupSoftDeleted: true", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: new Date(),
      },
    });
    await prisma.auditEntry.create({
      data: { groupId: group.id, action: "group.deleted", payload: {} },
    });
    const res = await auditFetch();
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.groupSoftDeleted).toBe(true);
    expect(body.items[0]?.action).toBe("group.deleted");
  });

  it("merges entries across multiple games", async () => {
    const gameA = await createGame("Alpha", prisma);
    const gameB = await createGame("Beta", prisma);
    const groupA = await prisma.group.create({
      data: {
        gameId: gameA.id,
        kind: "guild",
        name: "GA",
        visibility: "invite-only",
        metadata: {},
      },
    });
    const groupB = await prisma.group.create({
      data: {
        gameId: gameB.id,
        kind: "guild",
        name: "GB",
        visibility: "invite-only",
        metadata: {},
      },
    });
    await prisma.auditEntry.create({
      data: { groupId: groupA.id, action: "group.created", payload: {} },
    });
    await prisma.auditEntry.create({
      data: { groupId: groupB.id, action: "group.created", payload: {} },
    });
    const res = await auditFetch();
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items).toHaveLength(2);
    const gameNames = new Set(body.items.map((i) => i.gameName));
    expect(gameNames).toEqual(new Set(["Alpha", "Beta"]));
  });

  it("defaults to a limit of 20 when no query param is supplied", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
      },
    });
    for (let i = 0; i < 25; i++) {
      await prisma.auditEntry.create({
        data: { groupId: group.id, action: "group.updated", payload: { i } },
      });
    }
    const res = await auditFetch();
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items).toHaveLength(20);
  });

  it("forwards a custom limit", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
      },
    });
    for (let i = 0; i < 8; i++) {
      await prisma.auditEntry.create({
        data: { groupId: group.id, action: "group.updated", payload: { i } },
      });
    }
    const res = await auditFetch("?limit=5");
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items).toHaveLength(5);
  });

  it("rejects limit=0 with 400", async () => {
    const res = await auditFetch("?limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const res = await auditFetch("?limit=101");
    expect(res.status).toBe(400);
  });

  it("rejects non-integer limit with 400", async () => {
    const res = await auditFetch("?limit=abc");
    expect(res.status).toBe(400);
  });

  it("preserves null actorUserId and null targetId on the wire", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g",
        visibility: "invite-only",
        metadata: {},
      },
    });
    await prisma.auditEntry.create({
      data: { groupId: group.id, action: "group.created", payload: {} },
    });
    const res = await auditFetch();
    const body = (await res.json()) as { items: WireItem[] };
    expect(body.items[0]?.actorUserId).toBeNull();
    expect(body.items[0]?.targetId).toBeNull();
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.request("/v1/admin/audit", { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests with the wrong admin token", async () => {
    const res = await auditFetch("", "Bearer nope");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request("/v1/admin/audit", {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });
});
