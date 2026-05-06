import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";
import type {
  WireBlock,
  WireBlockList,
  WireFriendRequest,
  WireFriendRequestSendResult,
} from "./friends.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-blocks";

const TRUNCATE =
  'TRUNCATE TABLE "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("block routes + block-implicit cleanup", () => {
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

  async function setupGame(configPatch?: Record<string, unknown>) {
    const game = await createGame("Alpha", prisma);
    if (configPatch) {
      await prisma.game.update({
        where: { id: game.id },
        data: { config: configPatch as object },
      });
    }
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

  it("POST /v1/users/:userId/blocks creates a block row", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const res = await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireBlock;
    expect(body.gameId).toBe(gameId);
    expect(body.junjoUserId).toBe(b);
  });

  it("POST is idempotent (re-blocking returns the existing row)", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const first = await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const firstBody = (await first.json()) as WireBlock;
    const second = await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as WireBlock;
    expect(secondBody.id).toBe(firstBody.id);
  });

  it("blocking removes any existing friendship in either direction", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;
    await app.request(`/v1/friend-requests/${req.id}/accept`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(await prisma.userRelationship.count({ where: { gameId, type: "friend" } })).toBe(2);

    await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });

    expect(await prisma.userRelationship.count({ where: { gameId, type: "friend" } })).toBe(0);
    expect(await prisma.userRelationship.count({ where: { gameId, type: "blocked" } })).toBe(1);
  });

  it("blocking removes pending requests in either direction", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    // a -> b pending
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    // a blocks b -> the pending outbound request should disappear.
    await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(await prisma.userRelationship.count({ where: { gameId, type: "request" } })).toBe(0);
  });

  it("DELETE removes the block", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const res = await app.request(`/v1/users/${a}/blocks/${b}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(204);
    expect(await prisma.userRelationship.count({ where: { gameId, type: "blocked" } })).toBe(0);
  });

  it("DELETE on a non-existent block returns 404", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const res = await app.request(`/v1/users/${a}/blocks/${b}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("GET lists my blocks", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    for (const target of [b, c]) {
      await app.request(`/v1/users/${a}/blocks`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ targetJunjoUserId: target }),
      });
    }
    const res = await app.request(`/v1/users/${a}/blocks`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireBlockList;
    expect(body.items).toHaveLength(2);
    expect(body.items.map((i) => i.junjoUserId).sort()).toEqual([b, c].sort());
  });

  it("friend request POST 404s when the actor has blocked the target", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(res.status).toBe(404);
  });

  it("friend request POST 404s when the target has blocked the actor (silent)", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    // b blocks a
    await app.request(`/v1/users/${b}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: a }),
    });
    // a tries to friend b -> 404 (looks like b doesn't exist)
    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(res.status).toBe(404);
  });

  it("blocks.enabled=false returns 404 on every block route", async () => {
    const { apiKey } = await setupGame({ blocks: { enabled: false } });
    const a = await makeUser();
    const b = await makeUser();
    const post = await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(post.status).toBe(404);
    const get = await app.request(`/v1/users/${a}/blocks`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(get.status).toBe(404);
    const del = await app.request(`/v1/users/${a}/blocks/${b}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(del.status).toBe(404);
  });
});
