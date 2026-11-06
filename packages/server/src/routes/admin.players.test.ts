import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";
import type { WireAdminPlayer, WireAdminPlayerList } from "./admin.players";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "Sanction", "GameBan", "GroupMember", "Group", "ExternalIdentity", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE';

const T0 = new Date("2026-10-01T00:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function at(hours: number): Date {
  return new Date(T0.getTime() + hours * HOUR_MS);
}

interface SeedId {
  userId: string;
  displayName?: string;
  // Hours after T0; also used for `linkedAt` unless `linkedAtHours` is set.
  createdAtHours?: number;
  linkedAtHours?: number;
  displayNameAtHours?: number;
}

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/players", () => {
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

  // One person holding `ids` in `gameId`. Returns the JunjoUser id.
  async function seedPerson(gameId: string, ids: SeedId[], junjoUserId?: string) {
    const personId = junjoUserId ?? (await prisma.junjoUser.create({ data: {} })).id;
    for (const id of ids) {
      const createdAt = at(id.createdAtHours ?? 0);
      await prisma.externalIdentity.create({
        data: {
          gameId,
          junjoUserId: personId,
          externalUserId: id.userId,
          createdAt,
          linkedAt: id.linkedAtHours !== undefined ? at(id.linkedAtHours) : createdAt,
          displayName: id.displayName ?? null,
          displayNameUpdatedAt:
            id.displayName !== undefined
              ? at(id.displayNameAtHours ?? id.createdAtHours ?? 0)
              : null,
        },
      });
    }
    return personId;
  }

  async function seedAudit(
    gameId: string,
    hours: number,
    fields: { targetId?: string; actorUserId?: string },
  ) {
    await prisma.auditEntry.create({
      data: {
        gameId,
        action: "game.user.banned",
        targetId: fields.targetId ?? null,
        actorUserId: fields.actorUserId ?? null,
        createdAt: at(hours),
      },
    });
  }

  async function seedGroup(gameId: string, name: string, softDeleted = false) {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name,
        visibility: "public",
        softDeletedAt: softDeleted ? new Date() : null,
      },
    });
  }

  function list(gameId: string, query = "", header = `Bearer ${ADMIN_TOKEN}`) {
    const path = `/v1/admin/games/${gameId}/players${query ? `?${query}` : ""}`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  async function listOk(gameId: string, query = ""): Promise<WireAdminPlayerList> {
    const res = await list(gameId, query);
    expect(res.status).toBe(200);
    return (await res.json()) as WireAdminPlayerList;
  }

  function firstIds(body: WireAdminPlayerList): string[] {
    return body.items.map((p) => p.userIds[0]?.userId ?? "");
  }

  describe("auth and validation", () => {
    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await list(game.id, "", "");
      expect(res.status).toBe(401);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("invalid_admin_token");
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await list(game.id, "", "Bearer wrong-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 when the server has no admin token", async () => {
      const noTokenApp = createApp({ prisma });
      const game = await createGame("Alpha", prisma);
      const res = await noTokenApp.request(`/v1/admin/games/${game.id}/players`, {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(401);
    });

    it("returns 404 not_found for an unknown game", async () => {
      const res = await list("game_does_not_exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("not_found");
    });

    it.each([
      "limit=0",
      "limit=101",
      "offset=-1",
      "sort=createdAt",
      "order=sideways",
      "standing=muted",
      "namespace=Has%20Space",
      "q=",
    ])("returns 400 for %s", async (query) => {
      const game = await createGame("Alpha", prisma);
      const res = await list(game.id, query);
      expect(res.status).toBe(400);
    });

    it("answers an empty game with no items and the echoed page", async () => {
      const game = await createGame("Alpha", prisma);
      const body = await listOk(game.id);
      expect(body).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
    });
  });

  describe("person shape", () => {
    it("groups a person's linked ids into one item", async () => {
      const game = await createGame("Alpha", prisma);
      const personId = await seedPerson(game.id, [
        { userId: "roblox:100", displayName: "OldName", createdAtHours: 5, displayNameAtHours: 6 },
        {
          userId: "discord:200",
          displayName: "NewName",
          createdAtHours: 2,
          linkedAtHours: 10,
          displayNameAtHours: 11,
        },
        { userId: "plain-id", createdAtHours: 8, linkedAtHours: 12 },
      ]);

      const body = await listOk(game.id);
      expect(body.total).toBe(1);
      expect(body.items).toEqual<WireAdminPlayer[]>([
        {
          personId,
          userIds: [
            {
              userId: "roblox:100",
              namespace: "roblox",
              displayName: "OldName",
              linkedAt: at(5).toISOString(),
            },
            {
              userId: "discord:200",
              namespace: "discord",
              displayName: "NewName",
              linkedAt: at(10).toISOString(),
            },
            {
              userId: "plain-id",
              namespace: null,
              displayName: null,
              linkedAt: at(12).toISOString(),
            },
          ],
          displayName: "NewName",
          firstSeenAt: at(2).toISOString(),
          lastActivityAt: null,
          activeGroupCount: 0,
          ban: null,
          sanctions: [],
        },
      ]);
    });

    it("lists one item per person", async () => {
      const game = await createGame("Alpha", prisma);
      await seedPerson(game.id, [{ userId: "roblox:1" }, { userId: "discord:1" }]);
      await seedPerson(game.id, [{ userId: "roblox:2" }]);
      const body = await listOk(game.id);
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(2);
      expect(body.items.map((p) => p.userIds.length).sort()).toEqual([1, 2]);
    });

    it("shows the active ban and active sanctions, newest sanction first", async () => {
      const game = await createGame("Alpha", prisma);
      const personId = await seedPerson(game.id, [{ userId: "roblox:1" }]);
      const banUntil = new Date(Date.now() + DAY_MS);
      await prisma.gameBan.create({
        data: { gameId: game.id, junjoUserId: personId, reason: "griefing", expiresAt: banUntil },
      });
      await prisma.sanction.create({
        data: {
          gameId: game.id,
          junjoUserId: personId,
          type: "mute",
          startedAt: new Date(Date.now() - 2 * HOUR_MS),
        },
      });
      const lockUntil = new Date(Date.now() + HOUR_MS);
      await prisma.sanction.create({
        data: {
          gameId: game.id,
          junjoUserId: personId,
          type: "trade_lock",
          startedAt: new Date(Date.now() - HOUR_MS),
          expiresAt: lockUntil,
        },
      });

      const [item] = (await listOk(game.id)).items;
      expect(item?.ban).toEqual({ reason: "griefing", expiresAt: banUntil.toISOString() });
      expect(item?.sanctions).toEqual([
        { type: "trade_lock", expiresAt: lockUntil.toISOString() },
        { type: "mute", expiresAt: null },
      ]);
    });

    it("does not show an expired ban or expired sanctions", async () => {
      const game = await createGame("Alpha", prisma);
      const personId = await seedPerson(game.id, [{ userId: "roblox:1" }]);
      const past = new Date(Date.now() - HOUR_MS);
      await prisma.gameBan.create({
        data: { gameId: game.id, junjoUserId: personId, reason: "old", expiresAt: past },
      });
      await prisma.sanction.create({
        data: { gameId: game.id, junjoUserId: personId, type: "mute", expiresAt: past },
      });

      const [item] = (await listOk(game.id)).items;
      expect(item?.ban).toBeNull();
      expect(item?.sanctions).toEqual([]);
    });
  });

  describe("filters", () => {
    it("q matches any id or display name, case-insensitively, as a substring", async () => {
      const game = await createGame("Alpha", prisma);
      const byId = await seedPerson(game.id, [{ userId: "roblox:ABC123" }]);
      const bySecondId = await seedPerson(game.id, [
        { userId: "roblox:999", createdAtHours: 1 },
        { userId: "discord:abc777", createdAtHours: 2 },
      ]);
      const byName = await seedPerson(game.id, [
        { userId: "roblox:555", displayName: "The xAbCx Guy", createdAtHours: 3 },
      ]);
      await seedPerson(game.id, [{ userId: "roblox:777", displayName: "Nobody" }]);

      const body = await listOk(game.id, "q=abc");
      expect(body.total).toBe(3);
      expect(body.items.map((p) => p.personId).sort()).toEqual([byId, bySecondId, byName].sort());
      const second = body.items.find((p) => p.personId === bySecondId);
      expect(second?.userIds.map((u) => u.userId)).toEqual(["roblox:999", "discord:abc777"]);

      expect((await listOk(game.id, "q=zzz")).total).toBe(0);
    });

    it("q treats pattern characters literally", async () => {
      const game = await createGame("Alpha", prisma);
      await seedPerson(game.id, [{ userId: "roblox:1", displayName: "100%_real" }]);
      await seedPerson(game.id, [{ userId: "roblox:2", displayName: "100 real" }]);
      const body = await listOk(game.id, `q=${encodeURIComponent("0%_")}`);
      expect(body.items.map((p) => p.displayName)).toEqual(["100%_real"]);
      expect((await listOk(game.id, "q=_")).total).toBe(1);
    });

    it("namespace keeps only people with an id in that namespace", async () => {
      const game = await createGame("Alpha", prisma);
      const both = await seedPerson(game.id, [
        { userId: "roblox:1" },
        { userId: "discord:1", linkedAtHours: 1 },
      ]);
      const discordOnly = await seedPerson(game.id, [{ userId: "discord:2" }]);
      await seedPerson(game.id, [{ userId: "roblox:3" }]);
      await seedPerson(game.id, [{ userId: "discordish" }]);

      const body = await listOk(game.id, "namespace=discord");
      expect(body.total).toBe(2);
      expect(body.items.map((p) => p.personId).sort()).toEqual([both, discordOnly].sort());
      // The person keeps every id, not just the matching one.
      expect(body.items.find((p) => p.personId === both)?.userIds).toHaveLength(2);

      expect((await listOk(game.id, "namespace=disc")).total).toBe(0);
    });

    it("standing=banned keeps only people with an active game ban", async () => {
      const game = await createGame("Alpha", prisma);
      const permanent = await seedPerson(game.id, [{ userId: "roblox:1" }]);
      const timed = await seedPerson(game.id, [{ userId: "roblox:2" }]);
      const expired = await seedPerson(game.id, [{ userId: "roblox:3" }]);
      const sanctionedOnly = await seedPerson(game.id, [{ userId: "roblox:4" }]);
      await seedPerson(game.id, [{ userId: "roblox:5" }]);
      await prisma.gameBan.createMany({
        data: [
          { gameId: game.id, junjoUserId: permanent },
          { gameId: game.id, junjoUserId: timed, expiresAt: new Date(Date.now() + DAY_MS) },
          { gameId: game.id, junjoUserId: expired, expiresAt: new Date(Date.now() - 1000) },
        ],
      });
      await prisma.sanction.create({
        data: { gameId: game.id, junjoUserId: sanctionedOnly, type: "mute" },
      });

      const body = await listOk(game.id, "standing=banned");
      expect(body.total).toBe(2);
      expect(body.items.map((p) => p.personId).sort()).toEqual([permanent, timed].sort());
    });

    it("standing=sanctioned keeps only people with an active sanction", async () => {
      const game = await createGame("Alpha", prisma);
      const active = await seedPerson(game.id, [{ userId: "roblox:1" }]);
      const expired = await seedPerson(game.id, [{ userId: "roblox:2" }]);
      const bannedOnly = await seedPerson(game.id, [{ userId: "roblox:3" }]);
      await prisma.sanction.createMany({
        data: [
          { gameId: game.id, junjoUserId: active, type: "mute" },
          {
            gameId: game.id,
            junjoUserId: active,
            type: "trade_lock",
            expiresAt: new Date(Date.now() + DAY_MS),
          },
          {
            gameId: game.id,
            junjoUserId: expired,
            type: "mute",
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      });
      await prisma.gameBan.create({ data: { gameId: game.id, junjoUserId: bannedOnly } });

      const body = await listOk(game.id, "standing=sanctioned");
      expect(body.total).toBe(1);
      expect(body.items[0]?.personId).toBe(active);
      expect(body.items[0]?.sanctions).toHaveLength(2);
    });

    it("combines filters", async () => {
      const game = await createGame("Alpha", prisma);
      const match = await seedPerson(game.id, [{ userId: "discord:target" }]);
      const wrongNamespace = await seedPerson(game.id, [{ userId: "roblox:target" }]);
      await seedPerson(game.id, [{ userId: "discord:other" }]);
      await prisma.gameBan.createMany({
        data: [
          { gameId: game.id, junjoUserId: match },
          { gameId: game.id, junjoUserId: wrongNamespace },
        ],
      });
      const body = await listOk(game.id, "q=target&namespace=discord&standing=banned");
      expect(body.total).toBe(1);
      expect(body.items[0]?.personId).toBe(match);
    });
  });

  describe("sorting", () => {
    it("sorts by first seen, newest first by default", async () => {
      const game = await createGame("Alpha", prisma);
      await seedPerson(game.id, [{ userId: "p:b", createdAtHours: 2 }]);
      await seedPerson(game.id, [{ userId: "p:a", createdAtHours: 1 }]);
      // First seen is the earliest id, not the earliest linked.
      await seedPerson(game.id, [
        { userId: "p:c", createdAtHours: 5, linkedAtHours: 0 },
        { userId: "p:c2", createdAtHours: 0.5, linkedAtHours: 6 },
      ]);
      await seedPerson(game.id, [{ userId: "p:d", createdAtHours: 3 }]);

      expect(firstIds(await listOk(game.id))).toEqual(["p:d", "p:b", "p:a", "p:c"]);
      expect(firstIds(await listOk(game.id, "sort=firstSeen&order=desc"))).toEqual([
        "p:d",
        "p:b",
        "p:a",
        "p:c",
      ]);
      expect(firstIds(await listOk(game.id, "sort=firstSeen&order=asc"))).toEqual([
        "p:c",
        "p:a",
        "p:b",
        "p:d",
      ]);
    });

    it("sorts by name case-insensitively, falling back to the first id", async () => {
      const game = await createGame("Alpha", prisma);
      await seedPerson(game.id, [{ userId: "p:1", displayName: "bravo" }]);
      await seedPerson(game.id, [{ userId: "p:2", displayName: "Charlie" }]);
      // No display name: sorts by its earliest linked id.
      await seedPerson(game.id, [
        { userId: "alpha:9", linkedAtHours: 0 },
        { userId: "zulu:9", linkedAtHours: 1 },
      ]);
      // The most recently set name wins over an older one.
      await seedPerson(game.id, [
        { userId: "p:4", displayName: "Aardvark", displayNameAtHours: 1 },
        { userId: "p:5", displayName: "delta", linkedAtHours: 1, displayNameAtHours: 2 },
      ]);

      expect(firstIds(await listOk(game.id, "sort=name&order=asc"))).toEqual([
        "alpha:9",
        "p:1",
        "p:2",
        "p:4",
      ]);
      const desc = await listOk(game.id, "sort=name&order=desc");
      expect(firstIds(desc)).toEqual(["p:4", "p:2", "p:1", "alpha:9"]);
      expect(desc.items.map((p) => p.displayName)).toEqual(["delta", "Charlie", "bravo", null]);
    });

    it("sorts by last activity in both orders, with inactive people last", async () => {
      const game = await createGame("Alpha", prisma);
      await seedPerson(game.id, [{ userId: "p:a" }]);
      const b = await seedPerson(game.id, [{ userId: "p:b" }]);
      await seedPerson(game.id, [{ userId: "p:c" }]);
      await seedPerson(game.id, [{ userId: "p:d" }, { userId: "p:d2", linkedAtHours: 1 }]);
      await seedAudit(game.id, 30, { targetId: "p:a" });
      await seedAudit(game.id, 10, { actorUserId: b });
      await seedAudit(game.id, 20, { targetId: "p:d2" });
      await seedAudit(game.id, 5, { targetId: "p:a" });

      const desc = await listOk(game.id, "sort=lastActivity&order=desc");
      expect(firstIds(desc)).toEqual(["p:a", "p:d", "p:b", "p:c"]);
      expect(desc.items.map((p) => p.lastActivityAt)).toEqual([
        at(30).toISOString(),
        at(20).toISOString(),
        at(10).toISOString(),
        null,
      ]);
      expect(firstIds(await listOk(game.id, "sort=lastActivity"))).toEqual(firstIds(desc));
      expect(firstIds(await listOk(game.id, "sort=lastActivity&order=asc"))).toEqual([
        "p:b",
        "p:d",
        "p:a",
        "p:c",
      ]);
    });
  });

  describe("pagination", () => {
    it("pages with limit and offset and reports the total before paging", async () => {
      const game = await createGame("Alpha", prisma);
      for (let n = 0; n < 5; n++) {
        await seedPerson(game.id, [{ userId: `p:${n}`, createdAtHours: n }]);
      }
      const page1 = await listOk(game.id, "sort=firstSeen&order=asc&limit=2");
      expect(page1).toMatchObject({ total: 5, limit: 2, offset: 0 });
      expect(firstIds(page1)).toEqual(["p:0", "p:1"]);

      const page2 = await listOk(game.id, "sort=firstSeen&order=asc&limit=2&offset=2");
      expect(page2).toMatchObject({ total: 5, limit: 2, offset: 2 });
      expect(firstIds(page2)).toEqual(["p:2", "p:3"]);

      const page3 = await listOk(game.id, "sort=firstSeen&order=asc&limit=2&offset=4");
      expect(firstIds(page3)).toEqual(["p:4"]);

      const past = await listOk(game.id, "limit=2&offset=10");
      expect(past).toEqual({ items: [], total: 5, limit: 2, offset: 10 });
    });

    it("counts the filtered set as the total", async () => {
      const game = await createGame("Alpha", prisma);
      for (let n = 0; n < 4; n++) {
        await seedPerson(game.id, [{ userId: n % 2 === 0 ? `even:${n}` : `odd:${n}` }]);
      }
      const body = await listOk(game.id, "namespace=even&limit=1");
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(1);
    });

    it("breaks sort ties on the person id so pages do not overlap", async () => {
      const game = await createGame("Alpha", prisma);
      for (let n = 0; n < 6; n++) {
        await seedPerson(game.id, [{ userId: `p:${n}`, createdAtHours: 0 }]);
      }
      const seen: string[] = [];
      for (const offset of [0, 2, 4]) {
        const body = await listOk(game.id, `limit=2&offset=${offset}`);
        seen.push(...body.items.map((p) => p.personId));
      }
      expect(new Set(seen).size).toBe(6);
      expect(seen).toEqual([...seen].sort());
    });
  });

  describe("game isolation", () => {
    it("never shows another game's ids, moderation, groups or activity", async () => {
      const game = await createGame("Alpha", prisma);
      const other = await createGame("Beta", prisma);
      const personId = await seedPerson(game.id, [{ userId: "roblox:1", displayName: "Here" }]);
      // The same person in the other game, with its own ids and state.
      await seedPerson(
        other.id,
        [{ userId: "roblox:other", displayName: "Elsewhere", displayNameAtHours: 99 }],
        personId,
      );
      // Another person in the other game reusing the same external id.
      await seedPerson(other.id, [{ userId: "roblox:1" }]);
      await prisma.gameBan.create({ data: { gameId: other.id, junjoUserId: personId } });
      await prisma.sanction.create({
        data: { gameId: other.id, junjoUserId: personId, type: "mute" },
      });
      const otherGroup = await seedGroup(other.id, "Other guild");
      await prisma.groupMember.create({
        data: { groupId: otherGroup.id, junjoUserId: personId, status: "active" },
      });
      await seedAudit(other.id, 50, { targetId: "roblox:1" });
      await seedAudit(other.id, 60, { actorUserId: personId });

      const body = await listOk(game.id);
      expect(body.total).toBe(1);
      expect(body.items[0]).toMatchObject({
        personId,
        userIds: [{ userId: "roblox:1" }],
        displayName: "Here",
        lastActivityAt: null,
        activeGroupCount: 0,
        ban: null,
        sanctions: [],
      });
      expect((await listOk(game.id, "q=other")).total).toBe(0);
      expect((await listOk(game.id, "standing=banned")).total).toBe(0);
      expect((await listOk(game.id, "standing=sanctioned")).total).toBe(0);

      const lastActivity = await listOk(game.id, "sort=lastActivity");
      expect(lastActivity.items[0]?.lastActivityAt).toBeNull();

      expect((await listOk(other.id)).total).toBe(2);
    });
  });

  describe("lastActivityAt", () => {
    it("is the newest entry in the game that targets any of the person's ids or names them as actor", async () => {
      const game = await createGame("Alpha", prisma);
      const personId = await seedPerson(game.id, [
        { userId: "roblox:1" },
        { userId: "discord:1", linkedAtHours: 1 },
      ]);
      await seedPerson(game.id, [{ userId: "roblox:2" }]);
      await seedAudit(game.id, 1, { targetId: "roblox:1" });
      await seedAudit(game.id, 3, { targetId: "discord:1" });
      // Entries about someone else, or about a non-person target.
      await seedAudit(game.id, 9, { targetId: "roblox:2" });
      await seedAudit(game.id, 9, { targetId: personId });

      const lastFor = async (query: string) =>
        (await listOk(game.id, query)).items.find((p) => p.personId === personId)?.lastActivityAt;

      expect(await lastFor("")).toBe(at(3).toISOString());
      expect(await lastFor("sort=lastActivity")).toBe(at(3).toISOString());

      await seedAudit(game.id, 4, { actorUserId: personId, targetId: "roblox:2" });
      expect(await lastFor("")).toBe(at(4).toISOString());
      expect(await lastFor("sort=name")).toBe(at(4).toISOString());
      expect(await lastFor("sort=lastActivity")).toBe(at(4).toISOString());
    });

    it("is null for a person with no entries", async () => {
      const game = await createGame("Alpha", prisma);
      await seedPerson(game.id, [{ userId: "roblox:1" }]);
      await seedAudit(game.id, 1, {});
      for (const sort of ["firstSeen", "name", "lastActivity"]) {
        const body = await listOk(game.id, `sort=${sort}`);
        expect(body.items[0]?.lastActivityAt).toBeNull();
      }
    });
  });

  describe("activeGroupCount", () => {
    it("counts active memberships in live groups of this game only", async () => {
      const game = await createGame("Alpha", prisma);
      const personId = await seedPerson(game.id, [{ userId: "roblox:1" }]);
      const live1 = await seedGroup(game.id, "Live one");
      const live2 = await seedGroup(game.id, "Live two");
      const leftGroup = await seedGroup(game.id, "Left");
      const kickedGroup = await seedGroup(game.id, "Kicked");
      const deleted = await seedGroup(game.id, "Deleted", true);
      await prisma.groupMember.createMany({
        data: [
          { groupId: live1.id, junjoUserId: personId, status: "active" },
          { groupId: live2.id, junjoUserId: personId, status: "active" },
          { groupId: leftGroup.id, junjoUserId: personId, status: "left", leftAt: new Date() },
          { groupId: kickedGroup.id, junjoUserId: personId, status: "kicked" },
          { groupId: deleted.id, junjoUserId: personId, status: "active" },
        ],
      });

      const [item] = (await listOk(game.id)).items;
      expect(item?.activeGroupCount).toBe(2);
    });
  });
});
