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
import type { WireUserVisibility } from "./visibility.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-vis";

const TRUNCATE =
  'TRUNCATE TABLE "UserVisibility", "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("user visibility setting + enforcement", () => {
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

  async function makeUser(gameId: string): Promise<string> {
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, externalUserId: u.id, junjoUserId: u.id },
    });
    return u.id;
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

  // -----------------------------------------------------------------
  // GET / PATCH visibility
  // -----------------------------------------------------------------

  it("GET returns the default when no row exists", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const res = await app.request(`/v1/users/${a}/visibility`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireUserVisibility;
    expect(body.friendsListVisibility).toBe("private");
    expect(body.allowed).toEqual(["private", "friends-only"]);
    expect(body.updatedAt).toBeNull();
  });

  it("PATCH stores the value and GET returns it", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const patched = await app.request(`/v1/users/${a}/visibility`, {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ friendsListVisibility: "friends-only" }),
    });
    expect(patched.status).toBe(200);
    const body = (await patched.json()) as WireUserVisibility;
    expect(body.friendsListVisibility).toBe("friends-only");
    expect(body.updatedAt).not.toBeNull();
  });

  it("PATCH rejects values outside config.friends.visibility.allowed", async () => {
    const { gameId, apiKey } = await setupGame({
      friends: { visibility: { allowed: ["private"], default: "private" } },
    });
    const a = await makeUser(gameId);
    const res = await app.request(`/v1/users/${a}/visibility`, {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ friendsListVisibility: "public" }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH auto-vivifies a not-yet-seen user", async () => {
    // Under the external-id contract, visibility writes upsert both
    // the ExternalIdentity mapping and the UserVisibility row in one
    // call. The dev's backend can pre-create visibility settings for
    // users it has provisioned in its own DB but who have not yet
    // touched any Junjo write path. Matches the auto-vivify behavior
    // of every other write-path on Junjo (groups, invitations, bans,
    // friend-requests).
    const { apiKey } = await setupGame();
    const res = await app.request("/v1/users/cuid_fresh_user/visibility", {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ friendsListVisibility: "friends-only" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { junjoUserId: string; friendsListVisibility: string };
    expect(body.junjoUserId).toBe("cuid_fresh_user");
    expect(body.friendsListVisibility).toBe("friends-only");
  });

  // -----------------------------------------------------------------
  // Enforcement on GET /v1/users/:userId/friends?viewer=...
  // -----------------------------------------------------------------

  it("admin (no viewer) sees a private user's friend list", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    // a is "private" (default).
    const res = await app.request(`/v1/users/${a}/friends`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireFriendshipList;
    expect(body.items).toHaveLength(1);
  });

  it("non-friend viewer 404s on a private user's friend list", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const c = await makeUser(gameId); // c is the snooping viewer
    const b = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    // a is private.
    const res = await app.request(`/v1/users/${a}/friends?viewer=${c}`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("the user themselves can always see their own list", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    const res = await app.request(`/v1/users/${a}/friends?viewer=${a}`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(200);
  });

  it("public visibility lets anyone see", async () => {
    const { gameId, apiKey } = await setupGame({
      friends: {
        visibility: { allowed: ["private", "friends-only", "public"], default: "private" },
      },
    });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const c = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    await app.request(`/v1/users/${a}/visibility`, {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ friendsListVisibility: "public" }),
    });
    const res = await app.request(`/v1/users/${a}/friends?viewer=${c}`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(200);
  });

  it("friends-only visibility lets confirmed friends see", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    await app.request(`/v1/users/${a}/visibility`, {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ friendsListVisibility: "friends-only" }),
    });
    // b is a confirmed friend; should see.
    const okRes = await app.request(`/v1/users/${a}/friends?viewer=${b}`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(okRes.status).toBe(200);

    // c is a stranger; should not see.
    const c = await makeUser(gameId);
    const blockedRes = await app.request(`/v1/users/${a}/friends?viewer=${c}`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(blockedRes.status).toBe(404);
  });
});
