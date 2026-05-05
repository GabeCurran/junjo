import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";
import type {
  WireFriendRequest,
  WireFriendRequestList,
  WireFriendRequestSendResult,
  WireFriendship,
  WireFriendshipList,
} from "./friends.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-friends";

const TRUNCATE =
  'TRUNCATE TABLE "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("friend request and friendship routes", () => {
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

  // -----------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------

  async function setupGame(configPatch?: Record<string, unknown>) {
    const game = await createGame("Alpha", prisma);
    if (configPatch) {
      await prisma.game.update({
        where: { id: game.id },
        // Prisma's `Json` field type is invariant; cast through the
        // exported `InputJsonValue` shape via `object` to satisfy it.
        data: { config: configPatch as object },
      });
    }
    const { raw } = await createApiKey(game.id, prisma);
    return { gameId: game.id, apiKey: raw.full };
  }

  async function makeUser(): Promise<string> {
    const u = await prisma.junjoUser.create({ data: {} });
    return u.id;
  }

  function authHeaders(apiKey: string): Record<string, string> {
    return {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };
  }

  // -----------------------------------------------------------------
  // Send / list pending
  // -----------------------------------------------------------------

  it("POST /v1/users/:userId/friend-requests creates a pending request by default", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();

    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireFriendRequestSendResult;
    expect(body.status).toBe("pending");
    expect(body.request).toBeDefined();
    expect(body.request?.actorJunjoUserId).toBe(a);
    expect(body.request?.targetJunjoUserId).toBe(b);
    expect(body.request?.gameId).toBe(gameId);
  });

  it("POST rejects sending to yourself", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: a }),
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects when an inbound pending request already exists from the target", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    // a -> b
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    // b -> a should hit the "accept the existing inbound" guard.
    const res = await app.request(`/v1/users/${b}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: a }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /v1/users/:userId/friend-requests returns inbound + outbound by default", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    await app.request(`/v1/users/${c}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: a }),
    });
    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendRequestList;
    expect(body.outbound).toHaveLength(1);
    expect(body.outbound[0]?.targetJunjoUserId).toBe(b);
    expect(body.inbound).toHaveLength(1);
    expect(body.inbound[0]?.actorJunjoUserId).toBe(c);
  });

  it("GET supports direction=in and direction=out filters", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    await app.request(`/v1/users/${c}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: a }),
    });

    const inOnly = (await (
      await app.request(`/v1/users/${a}/friend-requests?direction=in`, {
        method: "GET",
        headers: authHeaders(apiKey),
      })
    ).json()) as WireFriendRequestList;
    expect(inOnly.outbound).toEqual([]);
    expect(inOnly.inbound).toHaveLength(1);

    const outOnly = (await (
      await app.request(`/v1/users/${a}/friend-requests?direction=out`, {
        method: "GET",
        headers: authHeaders(apiKey),
      })
    ).json()) as WireFriendRequestList;
    expect(outOnly.inbound).toEqual([]);
    expect(outOnly.outbound).toHaveLength(1);
  });

  // -----------------------------------------------------------------
  // Accept
  // -----------------------------------------------------------------

  it("POST /v1/friend-requests/:id/accept promotes the request and creates the mirror row", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;

    const res = await app.request(`/v1/friend-requests/${req.id}/accept`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(200);
    const friendship = (await res.json()) as WireFriendship;
    expect(friendship.junjoUserId).toBe(b);

    const rows = await prisma.userRelationship.findMany({ where: { gameId, type: "friend" } });
    expect(rows).toHaveLength(2);
    const pairs = rows.map((r) => `${r.actorJunjoUserId}->${r.targetJunjoUserId}`).sort();
    expect(pairs).toEqual([`${a}->${b}`, `${b}->${a}`].sort());
    // The original request row's createdAt is preserved (it was
    // promoted in place, not deleted+recreated).
    const promoted = rows.find((r) => r.id === req.id);
    expect(promoted).toBeDefined();
    expect(promoted?.respondedAt).not.toBeNull();
  });

  it("POST accept with an unknown id returns 404", async () => {
    const { apiKey } = await setupGame();
    const res = await app.request("/v1/friend-requests/nonexistent/accept", {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("POST accept rejects requests from a different game (cross-game leak guard)", async () => {
    const game1 = await setupGame();
    const game2 = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(game1.apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;

    const res = await app.request(`/v1/friend-requests/${req.id}/accept`, {
      method: "POST",
      headers: authHeaders(game2.apiKey),
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------
  // Decline / cancel
  // -----------------------------------------------------------------

  it("POST decline deletes the request without creating a friendship", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;

    const res = await app.request(`/v1/friend-requests/${req.id}/decline`, {
      method: "POST",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(204);
    const remaining = await prisma.userRelationship.count({ where: { gameId } });
    expect(remaining).toBe(0);
  });

  it("DELETE friend-request cancels (sender's outbound)", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const sent = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;

    const res = await app.request(`/v1/friend-requests/${req.id}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(204);
    const remaining = await prisma.userRelationship.count({ where: { gameId } });
    expect(remaining).toBe(0);
  });

  // -----------------------------------------------------------------
  // List friends + unfriend
  // -----------------------------------------------------------------

  it("GET /v1/users/:userId/friends lists accepted friendships from that user's POV", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();

    for (const target of [b, c]) {
      const sent = await app.request(`/v1/users/${a}/friend-requests`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ targetJunjoUserId: target }),
      });
      const req = ((await sent.json()) as WireFriendRequestSendResult).request as WireFriendRequest;
      await app.request(`/v1/friend-requests/${req.id}/accept`, {
        method: "POST",
        headers: authHeaders(apiKey),
      });
    }

    const res = await app.request(`/v1/users/${a}/friends`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendshipList;
    expect(body.items).toHaveLength(2);
    const friendIds = body.items.map((i) => i.junjoUserId).sort();
    expect(friendIds).toEqual([b, c].sort());
  });

  it("DELETE /v1/users/:userId/friends/:otherUserId removes both rows", async () => {
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

    const res = await app.request(`/v1/users/${a}/friends/${b}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(204);

    const remaining = await prisma.userRelationship.count({
      where: { gameId, type: "friend" },
    });
    expect(remaining).toBe(0);
  });

  it("DELETE on a non-existent friendship returns 404", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const res = await app.request(`/v1/users/${a}/friends/${b}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(404);
  });

  // -----------------------------------------------------------------
  // Toggle matrix
  // -----------------------------------------------------------------

  it("friends.enabled=false returns 404 on every friends route", async () => {
    const { apiKey } = await setupGame({ friends: { enabled: false } });
    const a = await makeUser();
    const b = await makeUser();
    for (const path of [`/v1/users/${a}/friend-requests`, `/v1/users/${a}/friends`]) {
      const res = await app.request(path, { method: "GET", headers: authHeaders(apiKey) });
      expect(res.status).toBe(404);
    }
    const post = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(post.status).toBe(404);
  });

  it("friends.requestsRequired=false auto-accepts on POST", async () => {
    const { gameId, apiKey } = await setupGame({
      friends: { requestsRequired: false },
    });
    const a = await makeUser();
    const b = await makeUser();
    const res = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: b }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireFriendRequestSendResult;
    expect(body.status).toBe("auto-accepted");
    expect(body.friendship?.junjoUserId).toBe(b);

    const friendRows = await prisma.userRelationship.count({
      where: { gameId, type: "friend" },
    });
    expect(friendRows).toBe(2);
    const pendingRows = await prisma.userRelationship.count({
      where: { gameId, type: "request" },
    });
    expect(pendingRows).toBe(0);
  });

  it("friends.maxFriends caps the third friendship", async () => {
    const { apiKey } = await setupGame({
      friends: { requestsRequired: false, maxFriends: 2 },
    });
    const a = await makeUser();
    const targets = [await makeUser(), await makeUser(), await makeUser()];
    for (let i = 0; i < 2; i++) {
      const ok = await app.request(`/v1/users/${a}/friend-requests`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ targetJunjoUserId: targets[i] }),
      });
      expect(ok.status).toBe(201);
    }
    const blocked = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: targets[2] }),
    });
    expect(blocked.status).toBe(400);
  });

  it("friends.maxPendingRequests caps the next outbound request", async () => {
    const { apiKey } = await setupGame({
      friends: { maxPendingRequests: 1 },
    });
    const a = await makeUser();
    const t1 = await makeUser();
    const t2 = await makeUser();
    const ok = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: t1 }),
    });
    expect(ok.status).toBe(201);
    const blocked = await app.request(`/v1/users/${a}/friend-requests`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: t2 }),
    });
    expect(blocked.status).toBe(400);
  });
});
