import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";
import type {
  WireFriendRequest,
  WireFriendRequestSendResult,
  WireFriendshipList,
} from "./friends.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-network";

const TRUNCATE =
  'TRUNCATE TABLE "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("friends scope=network query expansion", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function setupGame(
    name: string,
    opts?: { networkId?: string; scope?: "per-game" | "network" },
  ) {
    const game = await prisma.game.create({
      data: {
        name,
        networkId: opts?.networkId ?? null,
        config: opts?.scope ? { friends: { scope: opts.scope } } : {},
      },
    });
    const { raw } = await createApiKey(game.id, prisma);
    return { gameId: game.id, apiKey: raw.full };
  }

  async function makeUser(): Promise<string> {
    return (await prisma.junjoUser.create({ data: {} })).id;
  }

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
  }

  async function makeFriendship(apiKey: string, a: string, b: string): Promise<void> {
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const result = (await sent.json()) as WireFriendRequestSendResult;
    if (result.status === "auto-accepted") return;
    const req = result.request as WireFriendRequest;
    await app.request(`/v1/friend-requests/${req.id}/accept`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
  }

  it("scope=per-game: a friendship in game A is invisible from game B even with the same networkId", async () => {
    // Both games share networkId but only A opted into scope=network.
    // B keeps its default scope=per-game so its reads stay isolated.
    const a = await setupGame("A", { networkId: "studio", scope: "network" });
    const b = await setupGame("B", { networkId: "studio" }); // default scope=per-game
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeFriendship(a.apiKey, u1, u2);

    const fromA = (await (
      await app.request(`/v1/users/${u1}/friends`, {
        method: "GET",
        headers: authHeaders(a.apiKey),
      })
    ).json()) as WireFriendshipList;
    const fromB = (await (
      await app.request(`/v1/users/${u1}/friends`, {
        method: "GET",
        headers: authHeaders(b.apiKey),
      })
    ).json()) as WireFriendshipList;

    expect(fromA.items).toHaveLength(1);
    // B's per-game scope: the row in A is not visible.
    expect(fromB.items).toHaveLength(0);
  });

  it("scope=network on both: a friendship in game A is visible from game B (shared networkId)", async () => {
    const a = await setupGame("A", { networkId: "studio", scope: "network" });
    const b = await setupGame("B", { networkId: "studio", scope: "network" });
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeFriendship(a.apiKey, u1, u2);

    const fromB = (await (
      await app.request(`/v1/users/${u1}/friends`, {
        method: "GET",
        headers: authHeaders(b.apiKey),
      })
    ).json()) as WireFriendshipList;
    expect(fromB.items).toHaveLength(1);
    expect(fromB.items[0]?.junjoUserId).toBe(u2);
  });

  it("different networkId stays isolated even when both opt into scope=network", async () => {
    const a = await setupGame("A", { networkId: "studio-1", scope: "network" });
    const c = await setupGame("C", { networkId: "studio-2", scope: "network" });
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeFriendship(a.apiKey, u1, u2);

    const fromC = (await (
      await app.request(`/v1/users/${u1}/friends`, {
        method: "GET",
        headers: authHeaders(c.apiKey),
      })
    ).json()) as WireFriendshipList;
    expect(fromC.items).toHaveLength(0);
  });

  it("flipping scope back to per-game narrows visibility but does not drop data", async () => {
    const a = await setupGame("A", { networkId: "studio", scope: "network" });
    const b = await setupGame("B", { networkId: "studio", scope: "network" });
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeFriendship(a.apiKey, u1, u2);

    // Flip B back to per-game.
    await prisma.game.update({
      where: { id: b.gameId },
      data: { config: { friends: { scope: "per-game" } } },
    });

    const fromB = (await (
      await app.request(`/v1/users/${u1}/friends`, {
        method: "GET",
        headers: authHeaders(b.apiKey),
      })
    ).json()) as WireFriendshipList;
    expect(fromB.items).toHaveLength(0);

    // Data still exists; A still sees it.
    const fromA = (await (
      await app.request(`/v1/users/${u1}/friends`, {
        method: "GET",
        headers: authHeaders(a.apiKey),
      })
    ).json()) as WireFriendshipList;
    expect(fromA.items).toHaveLength(1);
  });

  it("scope=network: duplicate friendship guard spans the network", async () => {
    // Send from A; then try sending from B (same network) - should reject
    // as already friends.
    const a = await setupGame("A", { networkId: "studio", scope: "network" });
    const b = await setupGame("B", { networkId: "studio", scope: "network" });
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeFriendship(a.apiKey, u1, u2);

    const dup = await app.request(`/v1/users/${u1}/friend-requests`, {
      method: "POST",
      headers: authHeaders(b.apiKey),
      body: JSON.stringify({ targetJunjoUserId: u2 }),
    });
    expect(dup.status).toBe(400);
  });

  it("scope=network: a block in sibling game prevents friend request in this game (silent 404)", async () => {
    const a = await setupGame("A", { networkId: "studio", scope: "network" });
    const b = await setupGame("B", { networkId: "studio", scope: "network" });
    const u1 = await makeUser();
    const u2 = await makeUser();
    // u2 blocks u1 in game A
    await app.request(`/v1/users/${u2}/blocks`, {
      method: "POST",
      headers: authHeaders(a.apiKey),
      body: JSON.stringify({ targetJunjoUserId: u1 }),
    });
    // u1 tries to friend u2 from game B - should 404 (block crosses network).
    const res = await app.request(`/v1/users/${u1}/friend-requests`, {
      method: "POST",
      headers: authHeaders(b.apiKey),
      body: JSON.stringify({ targetJunjoUserId: u2 }),
    });
    expect(res.status).toBe(404);
  });
});
