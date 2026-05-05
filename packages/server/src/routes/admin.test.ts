import { type Prisma, PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/users/:junjoUserId/games", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
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
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
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
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
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

// =====================================================================
// Cross-game games + API key management
// =====================================================================

type WireGame = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  groupCount: number;
  activeMemberCount: number;
  apiKeyCount: number;
};

type WireApiKey = {
  id: string;
  gameId: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
};

type WireApiKeyCreated = WireApiKey & { key: string };

type WireAdminGroup = {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

type WireAdminGroupList = {
  items: WireAdminGroup[];
  total: number;
  hasMore: boolean;
};

type WireAdminMemberRole = {
  id: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
};

type WireAdminGroupMember = {
  id: string;
  groupId: string;
  externalUserId: string;
  junjoUserId: string;
  status: string;
  metadata: Record<string, unknown>;
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: string;
  leftAt: string | null;
  roles: WireAdminMemberRole[];
};

type WireAdminGroupMemberList = {
  items: WireAdminGroupMember[];
  total: number;
  hasMore: boolean;
};

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function listFetch(query = "", header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty items array when no games exist", async () => {
    const res = await listFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items).toEqual([]);
  });

  it("returns games with zero counts on a fresh database", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      id: game.id,
      name: "Alpha",
      createdAt: game.createdAt.toISOString(),
      updatedAt: game.updatedAt.toISOString(),
      groupCount: 0,
      activeMemberCount: 0,
      apiKeyCount: 0,
    });
  });

  it("orders games by createdAt desc, id desc (newest first)", async () => {
    const older = await createGame("Older", prisma);
    // Force a fresh timestamp so the second row is unambiguously newer.
    await new Promise((r) => setTimeout(r, 5));
    const newer = await createGame("Newer", prisma);
    const res = await listFetch();
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items.map((g) => g.id)).toEqual([newer.id, older.id]);
  });

  it("counts groups per game, excluding soft-deleted", async () => {
    const game = await createGame("Alpha", prisma);
    await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "live-1", visibility: "invite-only" },
    });
    await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "live-2", visibility: "invite-only" },
    });
    await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "deleted",
        visibility: "invite-only",
        softDeletedAt: new Date(),
      },
    });
    const res = await listFetch();
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items[0]?.groupCount).toBe(2);
  });

  it("counts active members per game, excluding non-active and soft-deleted-group members", async () => {
    const game = await createGame("Alpha", prisma);
    const live = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "live", visibility: "invite-only" },
    });
    const dead = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "dead",
        visibility: "invite-only",
        softDeletedAt: new Date(),
      },
    });
    for (const status of ["active", "active", "left", "kicked", "invited"] as const) {
      const u = await prisma.junjoUser.create({ data: {} });
      await prisma.groupMember.create({
        data: { groupId: live.id, junjoUserId: u.id, status },
      });
    }
    // Active member in the soft-deleted group should NOT count.
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.create({
      data: { groupId: dead.id, junjoUserId: u.id, status: "active" },
    });
    const res = await listFetch();
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items[0]?.activeMemberCount).toBe(2);
  });

  it("counts non-revoked API keys per game", async () => {
    const game = await createGame("Alpha", prisma);
    await createApiKey(game.id, prisma);
    await createApiKey(game.id, prisma);
    const revoked = await createApiKey(game.id, prisma);
    await prisma.apiKey.update({
      where: { id: revoked.apiKey.id },
      data: { revokedAt: new Date() },
    });
    const res = await listFetch();
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items[0]?.apiKeyCount).toBe(2);
  });

  it("isolates counts across games", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    await prisma.group.create({
      data: { gameId: a.id, kind: "guild", name: "ag1", visibility: "invite-only" },
    });
    await prisma.group.create({
      data: { gameId: a.id, kind: "guild", name: "ag2", visibility: "invite-only" },
    });
    await prisma.group.create({
      data: { gameId: b.id, kind: "guild", name: "bg1", visibility: "invite-only" },
    });
    await createApiKey(a.id, prisma);
    const res = await listFetch();
    const body = (await res.json()) as { items: WireGame[] };
    const byId = new Map(body.items.map((g) => [g.id, g]));
    expect(byId.get(a.id)?.groupCount).toBe(2);
    expect(byId.get(a.id)?.apiKeyCount).toBe(1);
    expect(byId.get(b.id)?.groupCount).toBe(1);
    expect(byId.get(b.id)?.apiKeyCount).toBe(0);
  });

  it("forwards a custom limit", async () => {
    for (let i = 0; i < 5; i += 1) {
      await createGame(`Game-${i}`, prisma);
    }
    const res = await listFetch("?limit=3");
    const body = (await res.json()) as { items: WireGame[] };
    expect(body.items).toHaveLength(3);
  });

  it("rejects limit=0 with 400", async () => {
    const res = await listFetch("?limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects limit > 200 with 400", async () => {
    const res = await listFetch("?limit=201");
    expect(res.status).toBe(400);
  });

  it("rejects non-integer limit with 400", async () => {
    const res = await listFetch("?limit=abc");
    expect(res.status).toBe(400);
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.request("/v1/admin/games", { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests with the wrong admin token", async () => {
    const res = await listFetch("", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request("/v1/admin/games", {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/admin/games", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function postFetch(body: unknown, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request("/v1/admin/games", {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a game with zero counts and returns 201", async () => {
    const res = await postFetch({ name: "MyGame" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireGame;
    expect(body.name).toBe("MyGame");
    expect(body.groupCount).toBe(0);
    expect(body.activeMemberCount).toBe(0);
    expect(body.apiKeyCount).toBe(0);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const stored = await prisma.game.findUnique({ where: { id: body.id } });
    expect(stored?.name).toBe("MyGame");
  });

  it("allows duplicate names (no uniqueness constraint at the server level)", async () => {
    await postFetch({ name: "Same" });
    const res = await postFetch({ name: "Same" });
    expect(res.status).toBe(201);
    const total = await prisma.game.count();
    expect(total).toBe(2);
  });

  it("rejects missing name with 400", async () => {
    const res = await postFetch({});
    expect(res.status).toBe(400);
    const total = await prisma.game.count();
    expect(total).toBe(0);
  });

  it("rejects empty name with 400", async () => {
    const res = await postFetch({ name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects over-cap name with 400", async () => {
    const res = await postFetch({ name: "x".repeat(201) });
    expect(res.status).toBe(400);
  });

  it("rejects non-string name with 400", async () => {
    const res = await postFetch({ name: 123 });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await postFetch("{not-json");
    expect(res.status).toBe(400);
  });

  it("rejects requests with no Authorization header", async () => {
    const res = await app.request("/v1/admin/games", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Whatever" }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request("/v1/admin/games", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "Whatever" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function getFetch(gameId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the game with computed counts", async () => {
    const game = await createGame("Alpha", prisma);
    const live = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "live", visibility: "invite-only" },
    });
    await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "dead",
        visibility: "invite-only",
        softDeletedAt: new Date(),
      },
    });
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.create({
      data: { groupId: live.id, junjoUserId: u.id, status: "active" },
    });
    await createApiKey(game.id, prisma);

    const res = await getFetch(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireGame;
    expect(body.id).toBe(game.id);
    expect(body.name).toBe("Alpha");
    expect(body.groupCount).toBe(1);
    expect(body.activeMemberCount).toBe(1);
    expect(body.apiKeyCount).toBe(1);
  });

  it("returns 404 for a missing game", async () => {
    const res = await getFetch("nonexistent_id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getFetch(game.id, "Bearer nope");
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/api-keys", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function listFetch(gameId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/api-keys`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty items array when the game has no keys", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: WireApiKey[] };
    expect(body.items).toEqual([]);
  });

  it("returns keys sorted by createdAt desc, id desc", async () => {
    const game = await createGame("Alpha", prisma);
    const k1 = await createApiKey(game.id, prisma);
    await new Promise((r) => setTimeout(r, 5));
    const k2 = await createApiKey(game.id, prisma);
    const res = await listFetch(game.id);
    const body = (await res.json()) as { items: WireApiKey[] };
    expect(body.items.map((k) => k.id)).toEqual([k2.apiKey.id, k1.apiKey.id]);
  });

  it("includes revoked keys in the listing", async () => {
    const game = await createGame("Alpha", prisma);
    const seeded = await createApiKey(game.id, prisma);
    const revokedAt = new Date();
    await prisma.apiKey.update({
      where: { id: seeded.apiKey.id },
      data: { revokedAt },
    });
    const res = await listFetch(game.id);
    const body = (await res.json()) as { items: WireApiKey[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.revokedAt).toBe(revokedAt.toISOString());
  });

  it("never exposes the secret or hashed secret on the wire", async () => {
    const game = await createGame("Alpha", prisma);
    await createApiKey(game.id, prisma);
    const res = await listFetch(game.id);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items[0]).toBeDefined();
    const item = body.items[0] ?? {};
    expect(item).not.toHaveProperty("secret");
    expect(item).not.toHaveProperty("hashedSecret");
    expect(item).not.toHaveProperty("key");
  });

  it("scopes listings to the requested game", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    await createApiKey(a.id, prisma);
    await createApiKey(b.id, prisma);
    await createApiKey(b.id, prisma);
    const res = await listFetch(a.id);
    const body = (await res.json()) as { items: WireApiKey[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.gameId).toBe(a.id);
  });

  it("returns 404 for a missing game", async () => {
    const res = await listFetch("nonexistent_id");
    expect(res.status).toBe(404);
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/api-keys`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/admin/games/:gameId/api-keys", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function postFetch(gameId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/api-keys`, {
      method: "POST",
      headers: { authorization: header },
    });
  }

  it("issues a fresh key with the prefix.secret form returned once", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await postFetch(game.id);
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireApiKeyCreated;
    expect(body.gameId).toBe(game.id);
    expect(body.prefix).toMatch(/^jk_[A-Za-z0-9_-]+$/);
    expect(body.key).toMatch(/^jk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(body.key.startsWith(body.prefix)).toBe(true);
    expect(body.key.split(".")[0]).toBe(body.prefix);
    expect(body.revokedAt).toBeNull();

    const stored = await prisma.apiKey.findUnique({ where: { id: body.id } });
    expect(stored?.prefix).toBe(body.prefix);
    expect(stored?.hashedSecret).toMatch(/^scrypt\$/);
  });

  it("issues distinct keys on subsequent calls", async () => {
    const game = await createGame("Alpha", prisma);
    const r1 = await postFetch(game.id);
    const r2 = await postFetch(game.id);
    const k1 = (await r1.json()) as WireApiKeyCreated;
    const k2 = (await r2.json()) as WireApiKeyCreated;
    expect(k1.id).not.toBe(k2.id);
    expect(k1.prefix).not.toBe(k2.prefix);
    expect(k1.key).not.toBe(k2.key);
  });

  it("the issued key shows up in the list endpoint without the secret", async () => {
    const game = await createGame("Alpha", prisma);
    const created = (await (await postFetch(game.id)).json()) as WireApiKeyCreated;
    const list = (await (
      await app.request(`/v1/admin/games/${game.id}/api-keys`, {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      })
    ).json()) as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.id).toBe(created.id);
    expect(list.items[0]).not.toHaveProperty("key");
    expect(list.items[0]).not.toHaveProperty("secret");
  });

  it("returns 404 for a missing game and creates no key", async () => {
    const res = await postFetch("nonexistent_id");
    expect(res.status).toBe(404);
    const total = await prisma.apiKey.count();
    expect(total).toBe(0);
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/api-keys`, { method: "POST" });
    expect(res.status).toBe(401);
    const total = await prisma.apiKey.count();
    expect(total).toBe(0);
  });

  it("rejects requests with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await postFetch(game.id, "Bearer nope");
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/admin/games/:gameId/api-keys/:keyId/revoke", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function revokeFetch(gameId: string, keyId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/api-keys/${keyId}/revoke`, {
      method: "POST",
      headers: { authorization: header },
    });
  }

  it("revokes an active key and stamps revokedAt", async () => {
    const game = await createGame("Alpha", prisma);
    const seeded = await createApiKey(game.id, prisma);
    const before = Date.now();
    const res = await revokeFetch(game.id, seeded.apiKey.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireApiKey;
    expect(body.id).toBe(seeded.apiKey.id);
    expect(body.revokedAt).not.toBeNull();
    if (body.revokedAt === null) return;
    const ts = new Date(body.revokedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 1000);

    const stored = await prisma.apiKey.findUnique({ where: { id: seeded.apiKey.id } });
    expect(stored?.revokedAt).not.toBeNull();
  });

  it("is idempotent on already-revoked keys (no timestamp bump)", async () => {
    const game = await createGame("Alpha", prisma);
    const seeded = await createApiKey(game.id, prisma);
    const original = new Date(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    await prisma.apiKey.update({
      where: { id: seeded.apiKey.id },
      data: { revokedAt: original },
    });
    const res = await revokeFetch(game.id, seeded.apiKey.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireApiKey;
    expect(body.revokedAt).toBe(original.toISOString());
    const stored = await prisma.apiKey.findUnique({ where: { id: seeded.apiKey.id } });
    expect(stored?.revokedAt?.toISOString()).toBe(original.toISOString());
  });

  it("never hard-deletes the row (the prefix stays resolvable for audit)", async () => {
    const game = await createGame("Alpha", prisma);
    const seeded = await createApiKey(game.id, prisma);
    await revokeFetch(game.id, seeded.apiKey.id);
    const stored = await prisma.apiKey.findUnique({ where: { id: seeded.apiKey.id } });
    expect(stored).not.toBeNull();
    expect(stored?.prefix).toBe(seeded.apiKey.prefix);
  });

  it("returns 404 when the key id does not exist", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await revokeFetch(game.id, "nonexistent_id");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the key exists but belongs to a different game", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    const seeded = await createApiKey(b.id, prisma);
    const res = await revokeFetch(a.id, seeded.apiKey.id);
    expect(res.status).toBe(404);
    const stored = await prisma.apiKey.findUnique({ where: { id: seeded.apiKey.id } });
    expect(stored?.revokedAt).toBeNull();
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const seeded = await createApiKey(game.id, prisma);
    const res = await app.request(
      `/v1/admin/games/${game.id}/api-keys/${seeded.apiKey.id}/revoke`,
      { method: "POST" },
    );
    expect(res.status).toBe(401);
    const stored = await prisma.apiKey.findUnique({ where: { id: seeded.apiKey.id } });
    expect(stored?.revokedAt).toBeNull();
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const game = await createGame("Alpha", prisma);
    const seeded = await createApiKey(game.id, prisma);
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request(
      `/v1/admin/games/${game.id}/api-keys/${seeded.apiKey.id}/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      },
    );
    expect(res.status).toBe(401);
  });
});

// =====================================================================
// Cross-game group browser
// =====================================================================

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/groups", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function listFetch(gameId: string, query = "", header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/groups${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  // Seed N groups for the same game with optional kind / visibility / soft-delete
  // overrides. Returns the created rows in insertion order so tests can assert
  // on stable ids.
  async function seedGroups(
    gameId: string,
    plan: Array<{
      name: string;
      kind?: string;
      visibility?: "public" | "invite-only" | "secret";
      softDeleted?: boolean;
      activeMembers?: number;
    }>,
  ) {
    const created: Array<{ id: string; name: string }> = [];
    for (const p of plan) {
      const row = await prisma.group.create({
        data: {
          gameId,
          kind: p.kind ?? "guild",
          name: p.name,
          visibility: p.visibility ?? "invite-only",
          softDeletedAt: p.softDeleted ? new Date() : null,
        },
      });
      for (let i = 0; i < (p.activeMembers ?? 0); i += 1) {
        const u = await prisma.junjoUser.create({ data: {} });
        await prisma.groupMember.create({
          data: { groupId: row.id, junjoUserId: u.id, status: "active" },
        });
      }
      // Stagger createdAt so the asc/desc ordering tests are deterministic.
      await new Promise((r) => setTimeout(r, 2));
      created.push({ id: row.id, name: row.name });
    }
    return created;
  }

  it("returns an empty page for a game with no groups", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGroupList;
    expect(body).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("returns groups with their full wire shape on a fresh database", async () => {
    const game = await createGame("Alpha", prisma);
    const groupRow = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "Sun Wukong",
        visibility: "invite-only",
        metadata: { theme: "fire" },
      },
    });
    const role = await prisma.role.create({
      data: { groupId: groupRow.id, name: "Member", priority: 0 },
    });
    await prisma.group.update({
      where: { id: groupRow.id },
      data: { defaultRoleId: role.id },
    });
    const res = await listFetch(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    if (!item) throw new Error("expected one item");
    expect(item.id).toBe(groupRow.id);
    expect(item.gameId).toBe(game.id);
    expect(item.kind).toBe("guild");
    expect(item.name).toBe("Sun Wukong");
    expect(item.visibility).toBe("invite-only");
    expect(item.metadata).toEqual({ theme: "fire" });
    expect(item.defaultRoleId).toBe(role.id);
    expect(item.parentGroupId).toBeNull();
    expect(item.memberCount).toBe(0);
    expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("excludes soft-deleted groups", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "live-1" },
      { name: "deleted", softDeleted: true },
      { name: "live-2" },
    ]);
    const res = await listFetch(game.id);
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.total).toBe(2);
    expect(body.items.map((g) => g.name).sort()).toEqual(["live-1", "live-2"]);
  });

  it("scopes results to the path-supplied gameId", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    await seedGroups(a.id, [{ name: "a-only" }]);
    await seedGroups(b.id, [{ name: "b-only-1" }, { name: "b-only-2" }]);
    const res = await listFetch(a.id);
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["a-only"]);
  });

  it("counts active members per group, excluding non-active", async () => {
    const game = await createGame("Alpha", prisma);
    const groups = await seedGroups(game.id, [
      { name: "busy", activeMembers: 3 },
      { name: "empty" },
    ]);
    // Add some non-active members to the busy group; they must not count.
    const busyId = groups.find((g) => g.name === "busy")?.id;
    if (!busyId) throw new Error("busy group missing");
    for (const status of ["left", "kicked", "invited"] as const) {
      const u = await prisma.junjoUser.create({ data: {} });
      await prisma.groupMember.create({ data: { groupId: busyId, junjoUserId: u.id, status } });
    }
    const res = await listFetch(game.id);
    const body = (await res.json()) as WireAdminGroupList;
    const byName = new Map(body.items.map((g) => [g.name, g]));
    expect(byName.get("busy")?.memberCount).toBe(3);
    expect(byName.get("empty")?.memberCount).toBe(0);
  });

  it("defaults to sort=createdAt desc (newest first)", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [{ name: "first" }, { name: "second" }, { name: "third" }]);
    const res = await listFetch(game.id);
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["third", "second", "first"]);
  });

  it("supports sort=createdAt asc (oldest first)", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [{ name: "first" }, { name: "second" }, { name: "third" }]);
    const res = await listFetch(game.id, "?sort=createdAt&order=asc");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["first", "second", "third"]);
  });

  it("supports sort=name asc (alphabetical)", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [{ name: "zebra" }, { name: "apple" }, { name: "mango" }]);
    const res = await listFetch(game.id, "?sort=name&order=asc");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["apple", "mango", "zebra"]);
  });

  it("supports sort=name desc (reverse alphabetical)", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [{ name: "zebra" }, { name: "apple" }, { name: "mango" }]);
    const res = await listFetch(game.id, "?sort=name&order=desc");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["zebra", "mango", "apple"]);
  });

  it("supports sort=memberCount desc (busiest first)", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "small", activeMembers: 1 },
      { name: "huge", activeMembers: 5 },
      { name: "medium", activeMembers: 3 },
    ]);
    const res = await listFetch(game.id, "?sort=memberCount&order=desc");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["huge", "medium", "small"]);
    expect(body.items.map((g) => g.memberCount)).toEqual([5, 3, 1]);
  });

  it("supports sort=memberCount asc (emptiest first)", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "huge", activeMembers: 5 },
      { name: "medium", activeMembers: 3 },
      { name: "small", activeMembers: 1 },
    ]);
    const res = await listFetch(game.id, "?sort=memberCount&order=asc");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["small", "medium", "huge"]);
  });

  it("filters by case-insensitive name search via q", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "Sun Wukong" },
      { name: "moon-walkers" },
      { name: "Star Brigade" },
    ]);
    const res = await listFetch(game.id, "?q=moon");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["moon-walkers"]);

    const upper = await listFetch(game.id, "?q=MOON");
    const upperBody = (await upper.json()) as WireAdminGroupList;
    expect(upperBody.items.map((g) => g.name)).toEqual(["moon-walkers"]);
  });

  it("returns empty results when q matches nothing", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [{ name: "Sun Wukong" }]);
    const res = await listFetch(game.id, "?q=zzzz");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("filters by exact kind match", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "g1", kind: "guild" },
      { name: "g2", kind: "guild" },
      { name: "p1", kind: "party" },
    ]);
    const res = await listFetch(game.id, "?kind=party");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["p1"]);
  });

  it("filters by visibility", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "p1", visibility: "public" },
      { name: "p2", visibility: "public" },
      { name: "i1", visibility: "invite-only" },
      { name: "s1", visibility: "secret" },
    ]);
    const res = await listFetch(game.id, "?visibility=public");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name).sort()).toEqual(["p1", "p2"]);
  });

  it("AND-combines q + kind + visibility filters", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "Sunbreaker", kind: "guild", visibility: "public" },
      { name: "Sunbreaker", kind: "party", visibility: "public" },
      { name: "Sunbreaker", kind: "guild", visibility: "invite-only" },
      { name: "Moonshade", kind: "guild", visibility: "public" },
    ]);
    const res = await listFetch(game.id, "?q=sun&kind=guild&visibility=public");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.name).toBe("Sunbreaker");
  });

  it("paginates via offset + limit, surfacing total + hasMore", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(
      game.id,
      Array.from({ length: 7 }, (_, i) => ({ name: `g${i.toString().padStart(2, "0")}` })),
    );
    const first = await listFetch(game.id, "?sort=name&order=asc&limit=3&offset=0");
    const firstBody = (await first.json()) as WireAdminGroupList;
    expect(firstBody.items.map((g) => g.name)).toEqual(["g00", "g01", "g02"]);
    expect(firstBody.total).toBe(7);
    expect(firstBody.hasMore).toBe(true);

    const second = await listFetch(game.id, "?sort=name&order=asc&limit=3&offset=3");
    const secondBody = (await second.json()) as WireAdminGroupList;
    expect(secondBody.items.map((g) => g.name)).toEqual(["g03", "g04", "g05"]);
    expect(secondBody.total).toBe(7);
    expect(secondBody.hasMore).toBe(true);

    const third = await listFetch(game.id, "?sort=name&order=asc&limit=3&offset=6");
    const thirdBody = (await third.json()) as WireAdminGroupList;
    expect(thirdBody.items.map((g) => g.name)).toEqual(["g06"]);
    expect(thirdBody.total).toBe(7);
    expect(thirdBody.hasMore).toBe(false);
  });

  it("paginates correctly under sort=memberCount", async () => {
    const game = await createGame("Alpha", prisma);
    await seedGroups(game.id, [
      { name: "huge", activeMembers: 5 },
      { name: "medium", activeMembers: 3 },
      { name: "small", activeMembers: 1 },
      { name: "tiny", activeMembers: 0 },
    ]);
    const res = await listFetch(game.id, "?sort=memberCount&order=desc&limit=2&offset=0");
    const body = (await res.json()) as WireAdminGroupList;
    expect(body.items.map((g) => g.name)).toEqual(["huge", "medium"]);
    expect(body.total).toBe(4);
    expect(body.hasMore).toBe(true);

    const next = await listFetch(game.id, "?sort=memberCount&order=desc&limit=2&offset=2");
    const nextBody = (await next.json()) as WireAdminGroupList;
    expect(nextBody.items.map((g) => g.name)).toEqual(["small", "tiny"]);
    expect(nextBody.total).toBe(4);
    expect(nextBody.hasMore).toBe(false);
  });

  it("returns 400 when sort=memberCount and the matching set exceeds the cap", async () => {
    // Cap is 500; seed 501 rows via createMany (single statement, fast) and
    // confirm the route refuses to do an in-memory sort over that many rows.
    const game = await createGame("Alpha", prisma);
    const data = Array.from({ length: 501 }, (_, i) => ({
      gameId: game.id,
      kind: "guild",
      name: `g${i.toString().padStart(4, "0")}`,
      visibility: "invite-only",
    }));
    await prisma.group.createMany({ data });
    const res = await listFetch(game.id, "?sort=memberCount");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/memberCount/);
  }, 30_000);

  it("rejects limit=0 with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?limit=101");
    expect(res.status).toBe(400);
  });

  it("rejects negative offset with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?offset=-1");
    expect(res.status).toBe(400);
  });

  it("rejects unknown sort field with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?sort=age");
    expect(res.status).toBe(400);
  });

  it("rejects unknown order with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?order=sideways");
    expect(res.status).toBe(400);
  });

  it("rejects unknown visibility with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?visibility=nope");
    expect(res.status).toBe(400);
  });

  it("rejects empty q with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "?q=");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown gameId", async () => {
    const res = await listFetch("missing-game-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/groups`, { method: "GET" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "", "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const game = await createGame("Alpha", prisma);
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request(`/v1/admin/games/${game.id}/groups`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/groups/:groupId", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function getFetch(gameId: string, groupId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/groups/${groupId}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the group's full wire shape", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "Sun Wukong",
        visibility: "invite-only",
        metadata: { theme: "fire" },
      },
    });
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "Member", priority: 0 },
    });
    await prisma.group.update({
      where: { id: group.id },
      data: { defaultRoleId: role.id },
    });

    const res = await getFetch(game.id, group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGroup;
    expect(body.id).toBe(group.id);
    expect(body.gameId).toBe(game.id);
    expect(body.kind).toBe("guild");
    expect(body.name).toBe("Sun Wukong");
    expect(body.visibility).toBe("invite-only");
    expect(body.metadata).toEqual({ theme: "fire" });
    expect(body.defaultRoleId).toBe(role.id);
    expect(body.parentGroupId).toBeNull();
    expect(body.memberCount).toBe(0);
    expect(body.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("counts active members for memberCount, excluding non-active", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
      },
    });
    for (const status of ["active", "active", "active", "left", "kicked", "invited"] as const) {
      const u = await prisma.junjoUser.create({ data: {} });
      await prisma.groupMember.create({
        data: { groupId: group.id, junjoUserId: u.id, status },
      });
    }
    const res = await getFetch(game.id, group.id);
    const body = (await res.json()) as WireAdminGroup;
    expect(body.memberCount).toBe(3);
  });

  it("returns 404 when the group does not exist", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getFetch(game.id, "missing-group-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
        softDeletedAt: new Date(),
      },
    });
    const res = await getFetch(game.id, group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group exists but belongs to a different game", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: b.id,
        kind: "guild",
        name: "b-group",
        visibility: "invite-only",
      },
    });
    const res = await getFetch(a.id, group.id);
    expect(res.status).toBe(404);
    const ok = await getFetch(b.id, group.id);
    expect(ok.status).toBe(200);
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
      },
    });
    const res = await app.request(`/v1/admin/games/${game.id}/groups/${group.id}`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("rejects requests with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
      },
    });
    const res = await getFetch(game.id, group.id, "Bearer nope");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
      },
    });
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request(`/v1/admin/games/${game.id}/groups/${group.id}`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/groups/:groupId/members", () => {
  let app: Hono;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  function listFetch(
    gameId: string,
    groupId: string,
    query = "",
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/members${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  // Seeds members in the supplied group; each member gets its own JunjoUser
  // + ExternalIdentity, plus optional MemberRole join rows. Stagger between
  // creates makes joinedAt-desc ordering deterministic across rows.
  async function seedMembers(
    gameId: string,
    groupId: string,
    plan: Array<{
      external: string;
      status?: "active" | "left" | "kicked" | "invited";
      roles?: Array<{ name: string; priority?: number; color?: string }>;
      notesPublic?: string;
      notesPrivate?: string;
      metadata?: Record<string, unknown>;
    }>,
    staggerMs = 2,
  ) {
    const created: Array<{ memberId: string; externalUserId: string }> = [];
    for (const p of plan) {
      const u = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: u.id, externalUserId: p.external },
      });
      const member = await prisma.groupMember.create({
        data: {
          groupId,
          junjoUserId: u.id,
          status: p.status ?? "active",
          notesPublic: p.notesPublic ?? null,
          notesPrivate: p.notesPrivate ?? null,
          metadata: (p.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      for (const r of p.roles ?? []) {
        const role = await prisma.role.create({
          data: {
            groupId,
            name: r.name,
            priority: r.priority ?? 0,
            color: r.color ?? null,
          },
        });
        await prisma.memberRole.create({
          data: { groupMemberId: member.id, roleId: role.id },
        });
      }
      created.push({ memberId: member.id, externalUserId: p.external });
      await new Promise((resolve) => setTimeout(resolve, staggerMs));
    }
    return created;
  }

  it("returns an empty page for a group with no members", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(game.id, group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body).toEqual({ items: [], total: 0, hasMore: false });
  });

  it("returns members with full wire shape including roles and notes", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      {
        external: "user_alice",
        roles: [{ name: "Officer", priority: 100, color: "#ff0000" }],
        notesPublic: "Founding member",
        notesPrivate: "VIP",
        metadata: { custom: "value" },
      },
    ]);
    const res = await listFetch(game.id, group.id);
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.total).toBe(1);
    expect(body.hasMore).toBe(false);
    const item = body.items[0];
    if (!item) throw new Error("expected one item");
    expect(item.externalUserId).toBe("user_alice");
    expect(typeof item.junjoUserId).toBe("string");
    expect(item.junjoUserId.length).toBeGreaterThan(0);
    expect(item.status).toBe("active");
    expect(item.metadata).toEqual({ custom: "value" });
    expect(item.notesPublic).toBe("Founding member");
    expect(item.notesPrivate).toBe("VIP");
    expect(item.joinedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(item.leftAt).toBeNull();
    expect(item.roles).toHaveLength(1);
    const role = item.roles[0];
    if (!role) throw new Error("expected role chip");
    expect(role.name).toBe("Officer");
    expect(role.priority).toBe(100);
    expect(role.color).toBe("#ff0000");
    expect(role.isDefault).toBe(false);
  });

  it("orders members by joinedAt desc (newest first)", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      { external: "user_first" },
      { external: "user_second" },
      { external: "user_third" },
    ]);
    const res = await listFetch(game.id, group.id);
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.items.map((m) => m.externalUserId)).toEqual([
      "user_third",
      "user_second",
      "user_first",
    ]);
  });

  it("defaults to status=active and excludes non-active members", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      { external: "u_active", status: "active" },
      { external: "u_left", status: "left" },
      { external: "u_kicked", status: "kicked" },
      { external: "u_invited", status: "invited" },
    ]);
    const res = await listFetch(game.id, group.id);
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.total).toBe(1);
    expect(body.items.map((m) => m.externalUserId)).toEqual(["u_active"]);
  });

  it("supports status=all to return every status", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      { external: "u_active", status: "active" },
      { external: "u_left", status: "left" },
      { external: "u_kicked", status: "kicked" },
      { external: "u_invited", status: "invited" },
    ]);
    const res = await listFetch(game.id, group.id, "?status=all");
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.total).toBe(4);
    expect(body.items.map((m) => m.status).sort()).toEqual(["active", "invited", "kicked", "left"]);
  });

  it("supports status=left filter", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      { external: "u_active", status: "active" },
      { external: "u_left_a", status: "left" },
      { external: "u_left_b", status: "left" },
    ]);
    const res = await listFetch(game.id, group.id, "?status=left");
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.total).toBe(2);
    expect(body.items.every((m) => m.status === "left")).toBe(true);
  });

  it("filters by case-insensitive externalUserId substring via q", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      { external: "user_alice" },
      { external: "user_bob" },
      { external: "user_charlie" },
    ]);
    const res = await listFetch(game.id, group.id, "?q=ALI");
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.items.map((m) => m.externalUserId)).toEqual(["user_alice"]);
  });

  it("paginates via offset + limit, surfacing total + hasMore", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(
      game.id,
      group.id,
      Array.from({ length: 5 }, (_, i) => ({ external: `u${i}` })),
    );
    const first = await listFetch(game.id, group.id, "?limit=2&offset=0");
    const firstBody = (await first.json()) as WireAdminGroupMemberList;
    expect(firstBody.total).toBe(5);
    expect(firstBody.hasMore).toBe(true);
    expect(firstBody.items).toHaveLength(2);

    const last = await listFetch(game.id, group.id, "?limit=2&offset=4");
    const lastBody = (await last.json()) as WireAdminGroupMemberList;
    expect(lastBody.total).toBe(5);
    expect(lastBody.hasMore).toBe(false);
    expect(lastBody.items).toHaveLength(1);
  });

  it("returns roles sorted by priority desc with name asc tiebreaker", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      {
        external: "u_multi",
        roles: [
          { name: "Member", priority: 0 },
          { name: "Officer", priority: 100 },
          { name: "Veteran", priority: 50 },
          { name: "Apprentice", priority: 50 },
        ],
      },
    ]);
    const res = await listFetch(game.id, group.id);
    const body = (await res.json()) as WireAdminGroupMemberList;
    const item = body.items[0];
    if (!item) throw new Error("expected one member");
    expect(item.roles.map((r) => r.name)).toEqual(["Officer", "Apprentice", "Veteran", "Member"]);
  });

  it("returns members across multiple roles without duplicating the row", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    await seedMembers(game.id, group.id, [
      {
        external: "u_two_roles",
        roles: [
          { name: "Officer", priority: 100 },
          { name: "Strategist", priority: 80 },
        ],
      },
    ]);
    const res = await listFetch(game.id, group.id);
    const body = (await res.json()) as WireAdminGroupMemberList;
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const item = body.items[0];
    if (!item) throw new Error("expected one member");
    expect(item.roles).toHaveLength(2);
  });

  it("returns 404 when the group does not exist", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "missing-group-id");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "g1",
        visibility: "invite-only",
        softDeletedAt: new Date(),
      },
    });
    const res = await listFetch(game.id, group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game (cross-game)", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    const group = await prisma.group.create({
      data: { gameId: b.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(a.id, group.id);
    expect(res.status).toBe(404);
  });

  it("rejects limit=0 with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(game.id, group.id, "?limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(game.id, group.id, "?limit=101");
    expect(res.status).toBe(400);
  });

  it("rejects negative offset with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(game.id, group.id, "?offset=-1");
    expect(res.status).toBe(400);
  });

  it("rejects unknown status value with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(game.id, group.id, "?status=banned");
    expect(res.status).toBe(400);
  });

  it("rejects empty q with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await listFetch(game.id, group.id, "?q=");
    expect(res.status).toBe(400);
  });

  it("rejects requests with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const res = await app.request(`/v1/admin/games/${game.id}/groups/${group.id}/members`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invalid_admin_token");
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
    });
    const noTokenApp = createApp({ prisma, adminToken: undefined });
    const res = await noTokenApp.request(`/v1/admin/games/${game.id}/groups/${group.id}/members`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});
