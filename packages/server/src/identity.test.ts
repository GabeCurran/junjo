import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { findJunjoUserId, findOrCreateJunjoUser } from "./identity";
import { createGame } from "./seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("identity helpers", () => {
  let prisma: PrismaClient;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "ExternalIdentity", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("findOrCreateJunjoUser", () => {
    it("creates both JunjoUser and ExternalIdentity rows for a brand-new external id", async () => {
      expect(await prisma.junjoUser.count()).toBe(0);
      expect(await prisma.externalIdentity.count()).toBe(0);

      const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, "user_abc");
      expect(typeof junjoUserId).toBe("string");
      expect(junjoUserId.length).toBeGreaterThan(0);

      expect(await prisma.junjoUser.count()).toBe(1);
      expect(await prisma.externalIdentity.count()).toBe(1);

      const identity = await prisma.externalIdentity.findUnique({
        where: { gameId_externalUserId: { gameId, externalUserId: "user_abc" } },
      });
      expect(identity).not.toBeNull();
      expect(identity?.junjoUserId).toBe(junjoUserId);
      expect(identity?.gameId).toBe(gameId);
      expect(identity?.externalUserId).toBe("user_abc");
    });

    it("reuses the existing JunjoUser when the external id is already mapped", async () => {
      const first = await findOrCreateJunjoUser(prisma, gameId, "user_abc");
      const second = await findOrCreateJunjoUser(prisma, gameId, "user_abc");

      expect(second).toBe(first);
      expect(await prisma.junjoUser.count()).toBe(1);
      expect(await prisma.externalIdentity.count()).toBe(1);
    });

    it("returns separate JunjoUsers for the same external id across different games", async () => {
      const otherGame = await createGame("Other Game", prisma);

      const idA = await findOrCreateJunjoUser(prisma, gameId, "user_abc");
      const idB = await findOrCreateJunjoUser(prisma, otherGame.id, "user_abc");

      expect(idA).not.toBe(idB);
      expect(await prisma.junjoUser.count()).toBe(2);
      expect(await prisma.externalIdentity.count()).toBe(2);
    });

    it("does not create duplicate JunjoUsers under concurrent first-time requests for the same id", async () => {
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => findOrCreateJunjoUser(prisma, gameId, "user_race")),
      );

      const unique = new Set(results);
      expect(unique.size).toBe(1);
      expect(await prisma.junjoUser.count()).toBe(1);
      expect(await prisma.externalIdentity.count()).toBe(1);

      const identity = await prisma.externalIdentity.findUnique({
        where: { gameId_externalUserId: { gameId, externalUserId: "user_race" } },
        select: { junjoUserId: true },
      });
      expect(identity?.junjoUserId).toBe(results[0]);
    });

    it("recovers when the first call wins and a concurrent second call hits the unique constraint", async () => {
      const winner = await findOrCreateJunjoUser(prisma, gameId, "user_seed");

      const racers = await Promise.all([
        findOrCreateJunjoUser(prisma, gameId, "user_seed"),
        findOrCreateJunjoUser(prisma, gameId, "user_seed"),
        findOrCreateJunjoUser(prisma, gameId, "user_seed"),
      ]);

      for (const id of racers) expect(id).toBe(winner);
      expect(await prisma.junjoUser.count()).toBe(1);
      expect(await prisma.externalIdentity.count()).toBe(1);
    });

    it("isolates concurrent creates across distinct external ids in the same game", async () => {
      const [a, b, c] = await Promise.all([
        findOrCreateJunjoUser(prisma, gameId, "user_a"),
        findOrCreateJunjoUser(prisma, gameId, "user_b"),
        findOrCreateJunjoUser(prisma, gameId, "user_c"),
      ]);

      expect(new Set([a, b, c]).size).toBe(3);
      expect(await prisma.junjoUser.count()).toBe(3);
      expect(await prisma.externalIdentity.count()).toBe(3);
    });
  });

  describe("findJunjoUserId", () => {
    it("returns null when no ExternalIdentity exists for the (gameId, externalUserId) pair", async () => {
      const result = await findJunjoUserId(prisma, gameId, "missing_user");
      expect(result).toBeNull();
    });

    it("returns the JunjoUser id when the mapping exists", async () => {
      const created = await findOrCreateJunjoUser(prisma, gameId, "user_abc");
      const found = await findJunjoUserId(prisma, gameId, "user_abc");
      expect(found).toBe(created);
    });

    it("does not leak across games", async () => {
      const otherGame = await createGame("Other Game", prisma);
      await findOrCreateJunjoUser(prisma, gameId, "user_abc");

      const result = await findJunjoUserId(prisma, otherGame.id, "user_abc");
      expect(result).toBeNull();
    });
  });
});
