import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { createApiKey, createGame } from "../seed.js";
import type { WireFriendTag, WireFriendTagAssignment, WireFriendTagList } from "./friendTags.js";
import type {
  WireFriendRequest,
  WireFriendRequestSendResult,
  WireFriendshipList,
} from "./friends.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-tags";

const TRUNCATE =
  'TRUNCATE TABLE "UserRelationshipTag", "FriendTag", "UserRelationship", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("friend tag CRUD + tag filtering", () => {
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
  // Tag CRUD
  // -----------------------------------------------------------------

  it("POST creates a tag", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const res = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close friends", color: "#ff5050" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireFriendTag;
    expect(body.name).toBe("Close friends");
    expect(body.color).toBe("#ff5050");
    expect(body.gameId).toBe(gameId);
    expect(body.junjoUserId).toBe(a);
  });

  it("POST without color works (defaults to null)", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const res = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Coworkers" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as WireFriendTag;
    expect(body.color).toBeNull();
  });

  it("POST rejects invalid color", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const res = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close", color: "red" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST rejects duplicate tag name within same user/game", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close" }),
    });
    const dup = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close" }),
    });
    expect(dup.status).toBe(400);
  });

  it("GET lists my tags sorted by name", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    for (const name of ["Coworkers", "Close", "Guildmates"]) {
      await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ name }),
      });
    }
    const res = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    const body = (await res.json()) as WireFriendTagList;
    expect(body.items.map((t) => t.name)).toEqual(["Close", "Coworkers", "Guildmates"]);
  });

  it("PATCH updates name and color", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const created = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close" }),
    });
    const tag = (await created.json()) as WireFriendTag;

    const res = await app.request(`/v1/friend-tags/${tag.id}`, {
      method: "PATCH",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close friends", color: "#aabbcc" }),
    });
    const updated = (await res.json()) as WireFriendTag;
    expect(updated.name).toBe("Close friends");
    expect(updated.color).toBe("#aabbcc");
  });

  it("DELETE removes the tag and its joins (cascade)", async () => {
    const { gameId, apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    await makeFriendship(apiKey, a, b);
    const created = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close" }),
    });
    const tag = (await created.json()) as WireFriendTag;
    await app.request(`/v1/users/${a}/friends/${b}/tags`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tagIds: [tag.id] }),
    });
    expect(await prisma.userRelationshipTag.count()).toBe(1);

    await app.request(`/v1/friend-tags/${tag.id}`, {
      method: "DELETE",
      headers: authHeaders(apiKey),
    });
    expect(await prisma.friendTag.count({ where: { gameId } })).toBe(0);
    expect(await prisma.userRelationshipTag.count()).toBe(0);
  });

  it("PATCH/DELETE on a tag from a different game returns 404", async () => {
    const game1 = await setupGame();
    const game2 = await setupGame();
    const a = await makeUser();
    const created = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(game1.apiKey),
      body: JSON.stringify({ name: "Close" }),
    });
    const tag = (await created.json()) as WireFriendTag;
    const patch = await app.request(`/v1/friend-tags/${tag.id}`, {
      method: "PATCH",
      headers: authHeaders(game2.apiKey),
      body: JSON.stringify({ name: "Hijack" }),
    });
    expect(patch.status).toBe(404);
    const del = await app.request(`/v1/friend-tags/${tag.id}`, {
      method: "DELETE",
      headers: authHeaders(game2.apiKey),
    });
    expect(del.status).toBe(404);
  });

  // -----------------------------------------------------------------
  // Toggle gates
  // -----------------------------------------------------------------

  it("friends.tags.enabled=false returns 404 on every tag route", async () => {
    const { apiKey } = await setupGame({ friends: { tags: { enabled: false } } });
    const a = await makeUser();
    const post = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "Close" }),
    });
    expect(post.status).toBe(404);
    const get = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "GET",
      headers: authHeaders(apiKey),
    });
    expect(get.status).toBe(404);
  });

  it("friends.tags.maxPerUser caps tag creation", async () => {
    const { apiKey } = await setupGame({ friends: { tags: { maxPerUser: 2 } } });
    const a = await makeUser();
    for (const name of ["a", "b"]) {
      const ok = await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ name }),
      });
      expect(ok.status).toBe(201);
    }
    const blocked = await app.request(`/v1/users/${a}/friend-tags`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ name: "c" }),
    });
    expect(blocked.status).toBe(400);
  });

  // -----------------------------------------------------------------
  // Assign tags to friends
  // -----------------------------------------------------------------

  it("PUT /tags assigns the tag set to a friend", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    await makeFriendship(apiKey, a, b);
    const t1 = (await (
      await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ name: "Close" }),
      })
    ).json()) as WireFriendTag;
    const t2 = (await (
      await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ name: "Guildmates" }),
      })
    ).json()) as WireFriendTag;

    const res = await app.request(`/v1/users/${a}/friends/${b}/tags`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tagIds: [t1.id, t2.id] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireFriendTagAssignment;
    expect(body.tagIds.sort()).toEqual([t1.id, t2.id].sort());

    expect(await prisma.userRelationshipTag.count()).toBe(2);
  });

  it("PUT /tags with an empty array clears all tags from the friend", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    await makeFriendship(apiKey, a, b);
    const tag = (await (
      await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ name: "Close" }),
      })
    ).json()) as WireFriendTag;
    await app.request(`/v1/users/${a}/friends/${b}/tags`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tagIds: [tag.id] }),
    });
    expect(await prisma.userRelationshipTag.count()).toBe(1);

    await app.request(`/v1/users/${a}/friends/${b}/tags`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tagIds: [] }),
    });
    expect(await prisma.userRelationshipTag.count()).toBe(0);
  });

  it("PUT /tags rejects tags from a different game", async () => {
    const game1 = await setupGame();
    const game2 = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    await makeFriendship(game1.apiKey, a, b);
    const foreignTag = (await (
      await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(game2.apiKey),
        body: JSON.stringify({ name: "Cross" }),
      })
    ).json()) as WireFriendTag;
    const res = await app.request(`/v1/users/${a}/friends/${b}/tags`, {
      method: "PUT",
      headers: authHeaders(game1.apiKey),
      body: JSON.stringify({ tagIds: [foreignTag.id] }),
    });
    expect(res.status).toBe(400);
  });

  // -----------------------------------------------------------------
  // Tag filter on friends list
  // -----------------------------------------------------------------

  it("GET /friends?tagId=X filters to friends with that tag", async () => {
    const { apiKey } = await setupGame();
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    await makeFriendship(apiKey, a, b);
    await makeFriendship(apiKey, a, c);
    const tag = (await (
      await app.request(`/v1/users/${a}/friend-tags`, {
        method: "POST",
        headers: authHeaders(apiKey),
        body: JSON.stringify({ name: "Close" }),
      })
    ).json()) as WireFriendTag;
    await app.request(`/v1/users/${a}/friends/${b}/tags`, {
      method: "PUT",
      headers: authHeaders(apiKey),
      body: JSON.stringify({ tagIds: [tag.id] }),
    });

    const filtered = (await (
      await app.request(`/v1/users/${a}/friends?tagId=${tag.id}`, {
        method: "GET",
        headers: authHeaders(apiKey),
      })
    ).json()) as WireFriendshipList;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0]?.junjoUserId).toBe(b);
  });
});
