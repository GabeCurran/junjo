import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-as-game";
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "IdempotencyRecord", "EventLog", "GameEventCounter", "GameBan", "BanHistory", "ModerationState", "Sanction", "SanctionHistory", "MemberRole", "GroupMember", "Role", "Group", "LinkCode", "ExternalIdentity", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE`;
const VALID_UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)("/v1/admin/games/:gameId/as-game", () => {
  let app: Hono;
  let gameA: string;
  let gameB: string;
  let keyA: string;
  let keyAId: string;
  let keyB: string;

  beforeAll(() => {
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    gameA = (await createGame("Alpha", prisma)).id;
    gameB = (await createGame("Bravo", prisma)).id;
    const seededA = await createApiKey(gameA, prisma);
    keyA = `Bearer ${seededA.raw.full}`;
    keyAId = seededA.apiKey.id;
    keyB = `Bearer ${(await createApiKey(gameB, prisma)).raw.full}`;
  });

  function call(
    path: string,
    init: {
      method?: string;
      auth?: string | null;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    const auth = init.auth === undefined ? `Bearer ${ADMIN_TOKEN}` : init.auth;
    if (auth !== null) headers.authorization = auth;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    return app.request(path, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  const asGame = (gameId: string, path: string) => `/v1/admin/games/${gameId}/as-game${path}`;

  async function makeGroup(gameId: string, name: string) {
    return prisma.group.create({
      data: { gameId, kind: "guild", name, visibility: "public", metadata: {} },
    });
  }

  describe("auth", () => {
    it("refuses a request with no token", async () => {
      const res = await call(asGame(gameA, "/whoami"), { auth: null });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_admin_token");
    });

    it("refuses a wrong admin token", async () => {
      const res = await call(asGame(gameA, "/whoami"), { auth: "Bearer not-the-token" });
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_admin_token");
    });

    it("refuses a per-game key, including the key of the path's own game", async () => {
      for (const key of [keyA, keyB]) {
        const res = await call(asGame(gameA, "/whoami"), { auth: key });
        expect(res.status).toBe(401);
        expect(((await res.json()) as { code: string }).code).toBe("invalid_admin_token");
      }
    });

    it("refuses an unknown game before running any handler", async () => {
      const res = await call(asGame("no-such-game", "/whoami"));
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("not_found");
      expect(body.message).toBe("game not found");
    });

    it("answers as the path's game", async () => {
      const res = await call(asGame(gameA, "/whoami"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ gameId: gameA });
    });

    it("leaves the per-game routes refusing the admin token", async () => {
      const res = await call("/v1/whoami");
      expect(res.status).toBe(401);
      expect(((await res.json()) as { code: string }).code).toBe("invalid_api_key");
    });
  });

  describe("reads", () => {
    it("matches the per-game route's response for user moderation", async () => {
      const ban = await call("/v1/bans", {
        method: "POST",
        auth: keyA,
        body: { userId: "alice", reason: "cheating" },
      });
      expect(ban.status).toBe(201);

      const viaKey = await call("/v1/users/alice/moderation", { auth: keyA });
      const viaAdmin = await call(asGame(gameA, "/users/alice/moderation"));
      expect(viaAdmin.status).toBe(viaKey.status);
      expect(viaAdmin.status).toBe(200);
      const body = await viaAdmin.json();
      expect(body).toEqual(await viaKey.json());
      expect((body as { ban: { reason: string } | null }).ban?.reason).toBe("cheating");
    });

    it("matches the per-game route's response for the group list", async () => {
      await makeGroup(gameA, "Wolves");
      await makeGroup(gameA, "Ravens");
      const viaKey = await call("/v1/groups", { auth: keyA });
      const viaAdmin = await call(asGame(gameA, "/groups"));
      expect(viaAdmin.status).toBe(200);
      expect(await viaAdmin.json()).toEqual(await viaKey.json());
    });

    it("serves the event stream position, which reads no key", async () => {
      const viaKey = await call("/v1/events/position", { auth: keyA });
      const viaAdmin = await call(asGame(gameA, "/events/position"));
      expect(viaAdmin.status).toBe(200);
      expect(await viaAdmin.json()).toEqual(await viaKey.json());
    });
  });

  describe("writes", () => {
    it("bans in the path's game and writes an audit row with no API key", async () => {
      const res = await call(asGame(gameA, "/bans"), {
        method: "POST",
        body: { userId: "alice", reason: "griefing" },
      });
      expect(res.status).toBe(201);

      const bans = await prisma.gameBan.findMany({ select: { gameId: true } });
      expect(bans).toEqual([{ gameId: gameA }]);
      const audit = await prisma.auditEntry.findMany({
        where: { action: "game.user.banned" },
        select: { gameId: true, apiKeyId: true, targetId: true },
      });
      expect(audit).toEqual([{ gameId: gameA, apiKeyId: null, targetId: "alice" }]);
    });

    it("attributes the same write to the key when made through the per-game route", async () => {
      const res = await call("/v1/bans", { method: "POST", auth: keyA, body: { userId: "bob" } });
      expect(res.status).toBe(201);
      const audit = await prisma.auditEntry.findFirst({
        where: { action: "game.user.banned" },
        select: { apiKeyId: true },
      });
      expect(audit?.apiKeyId).toBe(keyAId);
    });

    it("issues a sanction in the path's game", async () => {
      const res = await call(asGame(gameB, "/sanctions"), {
        method: "POST",
        body: { userId: "carol", type: "mute" },
      });
      expect(res.status).toBe(201);
      const rows = await prisma.sanction.findMany({ select: { gameId: true, type: true } });
      expect(rows).toEqual([{ gameId: gameB, type: "mute" }]);
      const audit = await prisma.auditEntry.findMany({ select: { gameId: true, apiKeyId: true } });
      expect(audit.length).toBeGreaterThan(0);
      for (const row of audit) expect(row).toEqual({ gameId: gameB, apiKeyId: null });
    });

    it("validates an Idempotency-Key header but stores no record without a key", async () => {
      const bad = await call(asGame(gameA, "/bans"), {
        method: "POST",
        body: { userId: "alice" },
        headers: { "idempotency-key": "has spaces" },
      });
      expect(bad.status).toBe(400);

      for (let i = 0; i < 2; i++) {
        const res = await call(asGame(gameA, "/bans"), {
          method: "POST",
          body: { userId: "alice" },
          headers: { "idempotency-key": "retry-1" },
        });
        expect(res.status).toBe(201);
        expect(res.headers.get("idempotent-replayed")).toBeNull();
      }
      expect(await prisma.idempotencyRecord.count()).toBe(0);
    });
  });

  describe("declared id formats", () => {
    it("enforces the path game's formats and not another game's", async () => {
      await prisma.game.update({
        where: { id: gameA },
        data: { config: { identity: { formats: { mc: "uuid" } } } },
      });

      const rejected = await call(asGame(gameA, "/bans"), {
        method: "POST",
        body: { userId: "mc:not-a-uuid" },
      });
      expect(rejected.status).toBe(400);
      expect(((await rejected.json()) as { code: string }).code).toBe("invalid_user_id");

      const accepted = await call(asGame(gameA, "/bans"), {
        method: "POST",
        body: { userId: `mc:${VALID_UUID}` },
      });
      expect(accepted.status).toBe(201);

      const otherGame = await call(asGame(gameB, "/bans"), {
        method: "POST",
        body: { userId: "mc:not-a-uuid" },
      });
      expect(otherGame.status).toBe(201);
    });
  });

  describe("excluded routes", () => {
    it("does not serve the key-bound routes", async () => {
      const group = await makeGroup(gameA, "Wolves");
      const excluded: Array<[string, string]> = [
        ["GET", "/events"],
        ["GET", `/events/${group.id}`],
        ["GET", "/export"],
        ["POST", "/link-codes/redeem"],
      ];
      for (const [method, path] of excluded) {
        const res = await call(
          asGame(gameA, path),
          method === "POST" ? { method, body: { userId: "alice", code: "ABCD-EFGH" } } : { method },
        );
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(res.headers.get("content-type") ?? "").not.toContain("text/event-stream");
      }
    });

    it("answers 404 for a path no per-game route serves", async () => {
      const res = await call(asGame(gameA, "/no-such-route"));
      expect(res.status).toBe(404);
    });
  });

  describe("game isolation", () => {
    it("never shows game B's data through game A's mount", async () => {
      await makeGroup(gameA, "Alpha Wolves");
      const bGroup = await makeGroup(gameB, "Bravo Ravens");
      const banB = await call("/v1/bans", {
        method: "POST",
        auth: keyB,
        body: { userId: "alice" },
      });
      expect(banB.status).toBe(201);

      const groups = await call(asGame(gameA, "/groups"));
      const names = ((await groups.json()) as { items: Array<{ name: string }> }).items.map(
        (g) => g.name,
      );
      expect(names).toEqual(["Alpha Wolves"]);

      const crossGroup = await call(asGame(gameA, `/groups/${bGroup.id}`));
      expect(crossGroup.status).toBe(404);

      const moderation = await call(asGame(gameA, "/users/alice/moderation"));
      expect(moderation.status).toBe(200);
      expect(((await moderation.json()) as { ban: unknown }).ban).toBeNull();

      const bModeration = await call(asGame(gameB, "/users/alice/moderation"));
      expect(((await bModeration.json()) as { ban: unknown }).ban).not.toBeNull();
    });
  });
});
