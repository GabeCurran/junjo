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
