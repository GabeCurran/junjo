import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminGroupGrowth` from `routes/admin.ts`.
type WireSeries = {
  key: string;
  name: string;
  groupId: string | null;
  data: number[];
};

type WireGrowth = {
  from: string;
  to: string;
  bucketSizeMs: number;
  buckets: string[];
  series: WireSeries[];
};

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

describe.skipIf(!TEST_DATABASE_URL)(
  "GET /v1/admin/games/:gameId/analytics/group-growth (Phase 12.3a)",
  () => {
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

    async function seedGroup(gameId: string, name: string) {
      return prisma.group.create({
        data: {
          gameId,
          kind: "guild",
          name,
          visibility: "invite-only",
        },
      });
    }

    async function seedSoftDeletedGroup(gameId: string, name: string) {
      return prisma.group.create({
        data: {
          gameId,
          kind: "guild",
          name,
          visibility: "invite-only",
          softDeletedAt: new Date(),
        },
      });
    }

    async function seedMember(
      groupId: string,
      joinedAt: Date,
      leftAt: Date | null = null,
      status: "active" | "left" | "kicked" | "invited" = "active",
    ) {
      const user = await prisma.junjoUser.create({ data: {} });
      return prisma.groupMember.create({
        data: {
          groupId,
          junjoUserId: user.id,
          status,
          joinedAt,
          leftAt,
        },
      });
    }

    function getGrowth(gameId: string, query = "", header = `Bearer ${ADMIN_TOKEN}`) {
      const path = query
        ? `/v1/admin/games/${gameId}/analytics/group-growth?${query}`
        : `/v1/admin/games/${gameId}/analytics/group-growth`;
      return app.request(path, { method: "GET", headers: { authorization: header } });
    }

    it("returns empty series array for a game with no groups", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGrowth;
      expect(body.series).toEqual([]);
      expect(body.buckets.length).toBeGreaterThan(0);
      expect(body.bucketSizeMs).toBeGreaterThan(0);
    });

    it("returns the full wire shape with from / to / bucketSizeMs / buckets / series populated", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      await seedMember(group.id, new Date("2026-01-01T00:00:00Z"));
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z");
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGrowth;
      expect(body.from).toBe("2026-01-01T00:00:00.000Z");
      expect(body.to).toBe("2026-01-08T00:00:00.000Z");
      expect(typeof body.bucketSizeMs).toBe("number");
      expect(Array.isArray(body.buckets)).toBe(true);
      expect(body.series.length).toBe(1);
      const first = body.series[0];
      expect(first?.groupId).toBe(group.id);
      expect(first?.name).toBe("g1");
      expect(first?.key).toBe(`group:${group.id}`);
      expect(first?.data.length).toBe(body.buckets.length);
    });

    it("uses hourly bucket for windows <= 1d, 6h for <= 7d, daily for <= 30d, 3-day for <= 90d, weekly for longer", async () => {
      const game = await createGame("Alpha", prisma);
      // 1d
      let res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z");
      let body = (await res.json()) as WireGrowth;
      expect(body.bucketSizeMs).toBe(ONE_HOUR_MS);
      // 7d
      res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z");
      body = (await res.json()) as WireGrowth;
      expect(body.bucketSizeMs).toBe(6 * ONE_HOUR_MS);
      // 30d
      res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      body = (await res.json()) as WireGrowth;
      expect(body.bucketSizeMs).toBe(ONE_DAY_MS);
      // 90d
      res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-04-01T00:00:00Z");
      body = (await res.json()) as WireGrowth;
      expect(body.bucketSizeMs).toBe(3 * ONE_DAY_MS);
      // 180d -> weekly
      res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-07-01T00:00:00Z");
      body = (await res.json()) as WireGrowth;
      expect(body.bucketSizeMs).toBe(ONE_WEEK_MS);
    });

    it("counts a member as active at T iff joinedAt <= T AND (leftAt IS NULL OR leftAt > T)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // Member joined Jan 1, never left.
      await seedMember(group.id, new Date("2026-01-01T00:00:00Z"));
      // Member joined Jan 3, left Jan 5.
      await seedMember(
        group.id,
        new Date("2026-01-03T00:00:00Z"),
        new Date("2026-01-05T00:00:00Z"),
        "left",
      );

      // Daily buckets across Jan 1 - Jan 8 (7d window -> 6h buckets).
      // Use a wider window to get daily-ish granularity.
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      expect(body.bucketSizeMs).toBe(ONE_DAY_MS);
      const first = body.series[0];
      expect(first).toBeDefined();
      // Bucket 0: Jan 1 -> 1 active (the never-left member; joined exactly at the boundary).
      expect(first?.data[0]).toBe(1);
      // Jan 3: joined at exactly Jan 3 boundary -> 2 active (counts because joinedAt <= T).
      expect(first?.data[2]).toBe(2);
      // Jan 4: 2 active.
      expect(first?.data[3]).toBe(2);
      // Jan 5: leftAt = Jan 5 means leftAt > T is false at exactly T = Jan 5,
      // so the second member is no longer active.
      expect(first?.data[4]).toBe(1);
      // Jan 6 onwards: 1 active.
      expect(first?.data[5]).toBe(1);
    });

    it("does NOT consult member status (a kicked member with leftAt > T still counts at T)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // Member joined Jan 1, kicked Jan 10.
      await seedMember(
        group.id,
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-10T00:00:00Z"),
        "kicked",
      );
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      const first = body.series[0];
      // Jan 5 (bucket index 4): kicked member is still active (leftAt = Jan 10 > Jan 5).
      expect(first?.data[4]).toBe(1);
      // Jan 11 (bucket index 10): no longer active.
      expect(first?.data[10]).toBe(0);
    });

    it("ranks groups by active-count-at-`to` descending with groupId tiebreaker", async () => {
      const game = await createGame("Alpha", prisma);
      const big = await seedGroup(game.id, "big");
      const small = await seedGroup(game.id, "small");
      // big has 3 active members at `to`.
      for (let i = 0; i < 3; i += 1) {
        await seedMember(big.id, new Date("2026-01-01T00:00:00Z"));
      }
      // small has 1 active member at `to`.
      await seedMember(small.id, new Date("2026-01-01T00:00:00Z"));
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      expect(body.series.map((s) => s.name)).toEqual(["big", "small"]);
    });

    it("aggregates groups beyond top-N into an 'All others' series", async () => {
      const game = await createGame("Alpha", prisma);
      // 7 groups, each with 1 active member. topN=5.
      for (let i = 0; i < 7; i += 1) {
        const g = await seedGroup(game.id, `g${i}`);
        await seedMember(g.id, new Date("2026-01-01T00:00:00Z"));
      }
      const res = await getGrowth(
        game.id,
        "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z&topN=5",
      );
      const body = (await res.json()) as WireGrowth;
      expect(body.series.length).toBe(6); // 5 top + "All others"
      const last = body.series[5];
      expect(last?.key).toBe("all-others");
      expect(last?.name).toBe("All others");
      expect(last?.groupId).toBeNull();
      // Each of the 2 leftover groups has 1 active member at `to`, so the
      // aggregate = 2 at the last bucket.
      expect(last?.data[last.data.length - 1]).toBe(2);
    });

    it("omits the 'All others' row when groups.length <= topN", async () => {
      const game = await createGame("Alpha", prisma);
      for (let i = 0; i < 3; i += 1) {
        const g = await seedGroup(game.id, `g${i}`);
        await seedMember(g.id, new Date("2026-01-01T00:00:00Z"));
      }
      const res = await getGrowth(
        game.id,
        "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z&topN=5",
      );
      const body = (await res.json()) as WireGrowth;
      expect(body.series.length).toBe(3);
      expect(body.series.find((s) => s.key === "all-others")).toBeUndefined();
    });

    it("excludes soft-deleted groups from both top-N and the 'All others' aggregate", async () => {
      const game = await createGame("Alpha", prisma);
      const live = await seedGroup(game.id, "live");
      const dead = await seedSoftDeletedGroup(game.id, "dead");
      await seedMember(live.id, new Date("2026-01-01T00:00:00Z"));
      await seedMember(dead.id, new Date("2026-01-01T00:00:00Z"));
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      expect(body.series.length).toBe(1);
      expect(body.series[0]?.name).toBe("live");
    });

    it("scopes the read to the calling game (cross-game exclusion)", async () => {
      const a = await createGame("Alpha", prisma);
      const b = await createGame("Beta", prisma);
      const ag = await seedGroup(a.id, "ag");
      const bg = await seedGroup(b.id, "bg");
      await seedMember(ag.id, new Date("2026-01-01T00:00:00Z"));
      await seedMember(bg.id, new Date("2026-01-01T00:00:00Z"));

      const res = await getGrowth(a.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      expect(body.series.length).toBe(1);
      expect(body.series[0]?.groupId).toBe(ag.id);
    });

    it("respects a custom topN value", async () => {
      const game = await createGame("Alpha", prisma);
      for (let i = 0; i < 5; i += 1) {
        const g = await seedGroup(game.id, `g${i}`);
        await seedMember(g.id, new Date("2026-01-01T00:00:00Z"));
      }
      const res = await getGrowth(
        game.id,
        "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z&topN=2",
      );
      const body = (await res.json()) as WireGrowth;
      expect(body.series.length).toBe(3); // 2 top + "All others"
    });

    it("defaults topN to 5 when not supplied", async () => {
      const game = await createGame("Alpha", prisma);
      for (let i = 0; i < 8; i += 1) {
        const g = await seedGroup(game.id, `g${i}`);
        await seedMember(g.id, new Date("2026-01-01T00:00:00Z"));
      }
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-31T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      expect(body.series.length).toBe(6); // 5 top + "All others"
    });

    it("defaults the window to the last 30 days when from / to are omitted", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGrowth;
      const fromMs = Date.parse(body.from);
      const toMs = Date.parse(body.to);
      // ~30d window (allow a little slack for test execution time).
      expect(toMs - fromMs).toBeGreaterThan(29 * ONE_DAY_MS);
      expect(toMs - fromMs).toBeLessThan(31 * ONE_DAY_MS);
      expect(body.bucketSizeMs).toBe(ONE_DAY_MS);
    });

    it("accepts a from-only window (open upper bound, defaults to now)", async () => {
      const game = await createGame("Alpha", prisma);
      // Use 6d (not 7d) so test execution drift between Date.now() in the
      // test and Date.now() in the handler cannot nudge the window past
      // ONE_WEEK_MS into the daily-bucket bracket.
      const fromIso = new Date(Date.now() - 6 * ONE_DAY_MS).toISOString();
      const res = await getGrowth(game.id, `from=${fromIso}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGrowth;
      // <= 7d window -> 6h buckets.
      expect(body.bucketSizeMs).toBe(6 * ONE_HOUR_MS);
    });

    it("accepts a to-only window (open lower bound, defaults to to - 30d)", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "to=2026-02-01T00:00:00Z");
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGrowth;
      expect(body.to).toBe("2026-02-01T00:00:00.000Z");
      // 30d window -> daily buckets.
      expect(body.bucketSizeMs).toBe(ONE_DAY_MS);
    });

    it("returns 400 when from >= to", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z");
      expect(res.status).toBe(400);
    });

    it("returns 400 when window + bucket combination would emit too many buckets", async () => {
      const game = await createGame("Alpha", prisma);
      // 5 years -> weekly bucket = ~260 buckets, well past the 100 cap.
      const res = await getGrowth(game.id, "from=2021-01-01T00:00:00Z&to=2026-01-01T00:00:00Z");
      expect(res.status).toBe(400);
    });

    it("returns 400 on a malformed from value", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "from=not-a-date");
      expect(res.status).toBe(400);
    });

    it("returns 400 on a malformed to value", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "to=not-a-date");
      expect(res.status).toBe(400);
    });

    it("returns 400 on topN below the minimum", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "topN=0");
      expect(res.status).toBe(400);
    });

    it("returns 400 on topN above the maximum", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "topN=999");
      expect(res.status).toBe(400);
    });

    it("returns 400 on non-integer topN", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "topN=2.5");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the game does not exist", async () => {
      const res = await getGrowth("game_does_not_exist");
      expect(res.status).toBe(404);
    });

    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "", "");
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "", "Bearer wrong-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
      const noTokenApp = createApp({ prisma });
      const game = await createGame("Alpha", prisma);
      const res = await noTokenApp.request(`/v1/admin/games/${game.id}/analytics/group-growth`, {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(401);
    });

    it("URL-decodes the gameId path parameter", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(encodeURIComponent(game.id));
      expect(res.status).toBe(200);
    });

    it("preserves bucket ordering as ISO 8601 timestamps in chronological order", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      expect(body.buckets.length).toBeGreaterThan(0);
      for (let i = 1; i < body.buckets.length; i += 1) {
        const prev = body.buckets[i - 1];
        const cur = body.buckets[i];
        expect(prev).toBeDefined();
        expect(cur).toBeDefined();
        expect(Date.parse(cur as string)).toBeGreaterThan(Date.parse(prev as string));
      }
    });

    it("returns series.data arrays aligned 1:1 with the buckets array", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g");
      await seedMember(group.id, new Date("2026-01-01T00:00:00Z"));
      const res = await getGrowth(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-08T00:00:00Z");
      const body = (await res.json()) as WireGrowth;
      for (const s of body.series) {
        expect(s.data.length).toBe(body.buckets.length);
      }
    });
  },
);
