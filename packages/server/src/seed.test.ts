import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifySecret } from "./apiKey";
import { createApiKey, createGame } from "./seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("seed helpers (DB-backed)", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "ApiKey", "Game" RESTART IDENTITY CASCADE');
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe("createGame", () => {
    it("inserts a row and returns it", async () => {
      const game = await createGame("Test Game", prisma);
      expect(game.id).toMatch(/^c[a-z0-9]{20,}$/);
      expect(game.name).toBe("Test Game");
      expect(game.createdAt).toBeInstanceOf(Date);

      const fetched = await prisma.game.findUnique({ where: { id: game.id } });
      expect(fetched?.name).toBe("Test Game");
    });

    it("creates independent rows on each call", async () => {
      const a = await createGame("A", prisma);
      const b = await createGame("A", prisma);
      expect(a.id).not.toBe(b.id);
    });
  });

  describe("createApiKey", () => {
    it("creates a key linked to the game and returns the plaintext once", async () => {
      const game = await createGame("Owner", prisma);
      const { apiKey, raw } = await createApiKey(game.id, prisma);

      expect(apiKey.gameId).toBe(game.id);
      expect(apiKey.prefix).toBe(raw.prefix);
      expect(apiKey.revokedAt).toBeNull();
      expect(raw.full).toBe(`${raw.prefix}.${raw.secret}`);
      expect(raw.prefix.startsWith("jk_")).toBe(true);

      const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(stored?.hashedSecret).toBe(raw.hashedSecret);
      expect(stored?.hashedSecret).not.toContain(raw.secret);
      expect(await verifySecret(raw.secret, stored?.hashedSecret ?? "")).toBe(true);
    });

    it("issues distinct prefixes and secrets per call", async () => {
      const game = await createGame("Owner", prisma);
      const a = await createApiKey(game.id, prisma);
      const b = await createApiKey(game.id, prisma);
      expect(a.raw.prefix).not.toBe(b.raw.prefix);
      expect(a.raw.secret).not.toBe(b.raw.secret);
      expect(a.raw.hashedSecret).not.toBe(b.raw.hashedSecret);
    });

    it("rejects an unknown gameId", async () => {
      await expect(createApiKey("game_does_not_exist", prisma)).rejects.toThrow();
    });

    it("cascades when the owning game is deleted", async () => {
      const game = await createGame("Doomed", prisma);
      const { apiKey } = await createApiKey(game.id, prisma);
      await prisma.game.delete({ where: { id: game.id } });
      const stored = await prisma.apiKey.findUnique({ where: { id: apiKey.id } });
      expect(stored).toBeNull();
    });
  });
});
