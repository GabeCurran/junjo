import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { DEFAULT_GAME_CONFIG } from "../config/defaults.js";
import { createGame } from "../seed.js";
import type { WireAdminGameConfig } from "./admin.config.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-cfg";

const TRUNCATE = 'TRUNCATE TABLE "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("admin GET/PATCH /v1/admin/games/:gameId/config", () => {
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

  function authHeader() {
    return { authorization: `Bearer ${ADMIN_TOKEN}` };
  }

  it("returns the resolved DEFAULT_GAME_CONFIG for a fresh game", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "GET",
      headers: authHeader(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGameConfig;
    expect(body.gameId).toBe(game.id);
    expect(body.config).toEqual(DEFAULT_GAME_CONFIG);
    expect(body.networkId).toBeNull();
  });

  it("PATCH merges a partial into the stored config and returns the resolved result", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ config: { friends: { enabled: false, maxFriends: 50 } } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGameConfig;
    expect(body.config.friends.enabled).toBe(false);
    expect(body.config.friends.maxFriends).toBe(50);
    // Untouched fields default through.
    expect(body.config.friends.scope).toBe("per-game");
    expect(body.config.blocks.enabled).toBe(true);
  });

  it("PATCH preserves earlier partials when a later patch only touches one field", async () => {
    const game = await createGame("Alpha", prisma);
    await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ config: { friends: { maxFriends: 50 } } }),
    });
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ config: { blocks: { enabled: false } } }),
    });
    const body = (await res.json()) as WireAdminGameConfig;
    expect(body.config.friends.maxFriends).toBe(50);
    expect(body.config.blocks.enabled).toBe(false);
  });

  it("PATCH sets networkId and a subsequent PATCH with explicit null clears it", async () => {
    const game = await createGame("Alpha", prisma);
    const setRes = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ networkId: "studio-prod" }),
    });
    expect(((await setRes.json()) as WireAdminGameConfig).networkId).toBe("studio-prod");

    const clearRes = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ networkId: null }),
    });
    expect(((await clearRes.json()) as WireAdminGameConfig).networkId).toBeNull();
  });

  it("PATCH with both config and networkId updates both atomically", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({
        config: { friends: { scope: "network" } },
        networkId: "studio-prod",
      }),
    });
    const body = (await res.json()) as WireAdminGameConfig;
    expect(body.config.friends.scope).toBe("network");
    expect(body.networkId).toBe("studio-prod");
  });

  it("PATCH with neither config nor networkId returns 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects unknown branches (strict schema)", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ config: { friends: { unknownKey: 1 } } }),
    });
    expect(res.status).toBe(400);
  });

  it("PATCH rejects out-of-range maxFriends", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({ config: { friends: { maxFriends: 0 } } }),
    });
    expect(res.status).toBe(400);
  });

  it("GET returns 404 for an unknown game", async () => {
    const res = await app.request("/v1/admin/games/does-not-exist/config", {
      method: "GET",
      headers: authHeader(),
    });
    expect(res.status).toBe(404);
  });

  it("GET requires the admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`);
    expect(res.status).toBe(401);
  });

  it("PATCH requires the admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: { friends: { enabled: false } } }),
    });
    expect(res.status).toBe(401);
  });

  it("visibility default snaps to first allowed when narrowed", async () => {
    // Set allowed=["private"] while default was "public" — resolver
    // should report "private" on the next read.
    const game = await createGame("Alpha", prisma);
    await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({
        config: { friends: { visibility: { default: "public" } } },
      }),
    });
    const res = await app.request(`/v1/admin/games/${game.id}/config`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify({
        config: { friends: { visibility: { allowed: ["private"] } } },
      }),
    });
    const body = (await res.json()) as WireAdminGameConfig;
    expect(body.config.friends.visibility.allowed).toEqual(["private"]);
    expect(body.config.friends.visibility.default).toBe("private");
  });
});
