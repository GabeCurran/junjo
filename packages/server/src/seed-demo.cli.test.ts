import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// The seed walks 26 users, 5 groups, 78 friendships, etc. ~10-15s on
// dev hardware; allow generous headroom for slower CI.
const SEED_TIMEOUT_MS = 60_000;

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

// Regression: a fresh-DB run of `db:seed:demo` should always complete
// without throwing. The seed wipes the DB itself, so this test inherits
// no preconditions; it spawns the CLI as a subprocess against
// TEST_DATABASE_URL and asserts the run exits 0 with a Game + ApiKey row
// landed. Catches breakage from schema migrations that move a foreign-key
// target, wipe-step drift after a model is added, or any other failure
// that would block a clean `npm run dev` for a new contributor.
describe.skipIf(!TEST_DATABASE_URL)("db:seed:demo (CLI regression)", () => {
  it(
    "completes a full fresh-DB seed without throwing",
    async () => {
      const result = spawnSync("npm", ["run", "db:seed:demo"], {
        env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
        encoding: "utf8",
        shell: process.platform === "win32",
      });

      // Surface the seed output on failure so CI logs explain what blew up.
      if (result.status !== 0) {
        process.stderr.write(`\n[seed-demo regression] stdout:\n${result.stdout}\n`);
        process.stderr.write(`[seed-demo regression] stderr:\n${result.stderr}\n`);
      }

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Open the dashboard at");

      // Sanity-check the rows the failing call would have rejected: at
      // least one Game and one ApiKey, with the ApiKey's gameId resolving
      // to an actual Game row (the FK the original bug report flagged).
      const games = await prisma.game.findMany({ select: { id: true, name: true } });
      expect(games.length).toBeGreaterThanOrEqual(1);

      const apiKeys = await prisma.apiKey.findMany({ select: { gameId: true } });
      expect(apiKeys.length).toBeGreaterThanOrEqual(1);
      const gameIds = new Set(games.map((g) => g.id));
      for (const k of apiKeys) {
        expect(gameIds.has(k.gameId)).toBe(true);
      }
    },
    SEED_TIMEOUT_MS,
  );
});
