import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";
import type { WireFriendRequest, WireFriendRequestSendResult } from "./friends.js";
import type { WireFriendSuggestionList } from "./suggestions.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-suggest";

const TRUNCATE =
  'TRUNCATE TABLE "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("mutual-friend suggestions", () => {
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

  it("returns no suggestions when the user has no friends", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { minMutuals: 1 } } });
    const a = await makeUser(gameId);
    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendSuggestionList;
    expect(body.items).toEqual([]);
  });

  it("ranks suggestions by mutual count desc and includes sample mutuals", async () => {
    // a is friends with b, c, d.
    // e is friends with b, c, d -> 3 mutuals with a.
    // f is friends with b -> 1 mutual.
    // g is friends with c, d -> 2 mutuals.
    // Expected order: e (3), g (2), f (1).
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { minMutuals: 1 } } });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const c = await makeUser(gameId);
    const d = await makeUser(gameId);
    const e = await makeUser(gameId);
    const f = await makeUser(gameId);
    const g = await makeUser(gameId);

    for (const friendId of [b, c, d]) {
      await makeFriendship(apiKey, a, friendId);
    }
    for (const friendId of [b, c, d]) {
      await makeFriendship(apiKey, e, friendId);
    }
    await makeFriendship(apiKey, f, b);
    for (const friendId of [c, d]) {
      await makeFriendship(apiKey, g, friendId);
    }

    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendSuggestionList;
    expect(body.items.map((i) => ({ id: i.junjoUserId, count: i.mutualCount }))).toEqual([
      { id: e, count: 3 },
      { id: g, count: 2 },
      { id: f, count: 1 },
    ]);
    // Sample mutuals for e are some subset of [b, c, d].
    const eRow = body.items.find((i) => i.junjoUserId === e);
    for (const sample of eRow?.sampleMutualJunjoUserIds ?? []) {
      expect([b, c, d]).toContain(sample);
    }
  });

  it("excludes existing friends and self", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { minMutuals: 1 } } });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const c = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    await makeFriendship(apiKey, a, c);
    await makeFriendship(apiKey, b, c);

    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendSuggestionList;
    // c is already a's friend, so c should not be a suggestion. a is
    // self. No candidates remain.
    expect(body.items).toEqual([]);
  });

  it("excludes blocked users in either direction", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { minMutuals: 1 } } });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const c = await makeUser(gameId); // candidate via mutual b
    await makeFriendship(apiKey, a, b);
    await makeFriendship(apiKey, b, c);
    // a blocks c -> c should not appear as a suggestion.
    await app.request(`/v1/users/${a}/blocks`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ targetJunjoUserId: c }),
    });
    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendSuggestionList;
    expect(body.items.map((i) => i.junjoUserId)).not.toContain(c);
  });

  it("respects friends.discovery.minMutuals", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { minMutuals: 2 } } });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    const c = await makeUser(gameId);
    const d = await makeUser(gameId); // 1 mutual via b -> below threshold
    await makeFriendship(apiKey, a, b);
    await makeFriendship(apiKey, a, c);
    await makeFriendship(apiKey, b, d);

    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendSuggestionList;
    expect(body.items.map((i) => i.junjoUserId)).not.toContain(d);
  });

  it("friends.discovery.enabled=false returns 404", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { enabled: false } } });
    const a = await makeUser(gameId);
    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("friends.enabled=false returns 404", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { enabled: false } });
    const a = await makeUser(gameId);
    const res = await app.request(`/v1/users/${a}/friends/suggestions`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(res.status).toBe(404);
  });

  it("respects ?limit=N", async () => {
    const { gameId, apiKey } = await setupGame({ friends: { discovery: { minMutuals: 1 } } });
    const a = await makeUser(gameId);
    const b = await makeUser(gameId);
    await makeFriendship(apiKey, a, b);
    // Create 5 friends-of-b who are not a's friends.
    const candidates: string[] = [];
    for (let i = 0; i < 5; i++) {
      const u = await makeUser(gameId);
      await makeFriendship(apiKey, b, u);
      candidates.push(u);
    }
    const res = await app.request(`/v1/users/${a}/friends/suggestions?limit=3`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendSuggestionList;
    expect(body.items.length).toBeLessThanOrEqual(3);
  });
});
