import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminGroupChurn` from `routes/admin.ts`.
type WireBin = {
  label: string;
  minMs: number | null;
  maxMs: number | null;
  count: number;
};

type WireAdminGroupChurn = {
  from: string | null;
  to: string | null;
  totalGroupsInWindow: number;
  totalDeparturesInWindow: number;
  bins: WireBin[];
};

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;
const ONE_MONTH_MS = 30 * ONE_DAY_MS;

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/analytics/group-churn", () => {
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

  async function seedGroup(
    gameId: string,
    name: string,
    overrides: { createdAt?: Date; softDeleted?: boolean } = {},
  ) {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        softDeletedAt: overrides.softDeleted ? new Date() : null,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  async function seedDeparture(
    groupId: string,
    tenureMs: number,
    status: "left" | "kicked" = "left",
    joinedAt: Date = new Date("2026-01-01T00:00:00Z"),
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    return prisma.groupMember.create({
      data: {
        groupId,
        junjoUserId: user.id,
        status,
        joinedAt,
        leftAt: new Date(joinedAt.getTime() + tenureMs),
      },
    });
  }

  function getChurn(gameId: string, query = "", header = `Bearer ${ADMIN_TOKEN}`) {
    const path = query
      ? `/v1/admin/games/${gameId}/analytics/group-churn?${query}`
      : `/v1/admin/games/${gameId}/analytics/group-churn`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  it("returns zero counts in every bin when the game has no groups", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(0);
    expect(body.totalDeparturesInWindow).toBe(0);
    expect(body.bins.map((b) => b.label)).toEqual([
      "< 1h",
      "1h - 1d",
      "1d - 1w",
      "1w - 1mo",
      "1mo+",
    ]);
    for (const b of body.bins) expect(b.count).toBe(0);
  });

  it("returns the full bin shape with stable labels and half-open bounds", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.bins).toEqual([
      { label: "< 1h", minMs: null, maxMs: ONE_HOUR_MS, count: 0 },
      { label: "1h - 1d", minMs: ONE_HOUR_MS, maxMs: ONE_DAY_MS, count: 0 },
      { label: "1d - 1w", minMs: ONE_DAY_MS, maxMs: ONE_WEEK_MS, count: 0 },
      { label: "1w - 1mo", minMs: ONE_WEEK_MS, maxMs: ONE_MONTH_MS, count: 0 },
      { label: "1mo+", minMs: ONE_MONTH_MS, maxMs: null, count: 0 },
    ]);
  });

  it("counts a single 30-minute departure in the < 1h bin", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await seedGroup(game.id, "g1");
    await seedDeparture(group.id, 30 * 60 * 1000);
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(1);
    expect(body.totalDeparturesInWindow).toBe(1);
    expect(body.bins.map((b) => b.count)).toEqual([1, 0, 0, 0, 0]);
  });

  it("places one departure per bin across all five buckets (left + kicked both count)", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await seedGroup(game.id, "g1");
    // Five members, one per bin. Tenures chosen so each lands strictly
    // inside its bin's half-open range.
    await seedDeparture(group.id, 30 * 60 * 1000, "left"); // 30m -> < 1h
    await seedDeparture(group.id, 6 * ONE_HOUR_MS, "kicked"); // 6h -> 1h-1d
    await seedDeparture(group.id, 3 * ONE_DAY_MS, "left"); // 3d -> 1d-1w
    await seedDeparture(group.id, 14 * ONE_DAY_MS, "kicked"); // 14d -> 1w-1mo
    await seedDeparture(group.id, 45 * ONE_DAY_MS, "left"); // 45d -> 1mo+
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalDeparturesInWindow).toBe(5);
    expect(body.bins.map((b) => b.count)).toEqual([1, 1, 1, 1, 1]);
  });

  it("places exact bin-boundary tenures into the higher bin (lower bound is inclusive)", async () => {
    // tenure === ONE_HOUR_MS goes into the second bin (`1h - 1d`)
    // because the second bin's lower bound is inclusive and the first
    // bin's upper bound is exclusive.
    const game = await createGame("Alpha", prisma);
    const group = await seedGroup(game.id, "g1");
    await seedDeparture(group.id, ONE_HOUR_MS); // exactly 1h
    await seedDeparture(group.id, ONE_DAY_MS); // exactly 1d
    await seedDeparture(group.id, ONE_WEEK_MS); // exactly 1w
    await seedDeparture(group.id, ONE_MONTH_MS); // exactly 1mo
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.bins.map((b) => b.count)).toEqual([0, 1, 1, 1, 1]);
  });

  it("excludes active and invited members (only left + kicked count)", async () => {
    const game = await createGame("Alpha", prisma);
    const group = await seedGroup(game.id, "g1");
    const u1 = await prisma.junjoUser.create({ data: {} });
    const u2 = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.create({
      data: {
        groupId: group.id,
        junjoUserId: u1.id,
        status: "active",
        joinedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await prisma.groupMember.create({
      data: {
        groupId: group.id,
        junjoUserId: u2.id,
        status: "invited",
        joinedAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    await seedDeparture(group.id, 30 * 60 * 1000, "left");
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalDeparturesInWindow).toBe(1);
    expect(body.totalGroupsInWindow).toBe(1);
  });

  it("scopes the population to groups created in [from, to) and ignores departures from other windows", async () => {
    const game = await createGame("Alpha", prisma);
    // Group A created Jan 5; Group B created Mar 1 (outside the window).
    const a = await seedGroup(game.id, "A", { createdAt: new Date("2026-01-05T00:00:00Z") });
    const b = await seedGroup(game.id, "B", { createdAt: new Date("2026-03-01T00:00:00Z") });
    // A: 1 departure (lands in <1h).
    // B: 1 departure (would land in <1h), but B is outside the window.
    await seedDeparture(a.id, 30 * 60 * 1000);
    await seedDeparture(b.id, 30 * 60 * 1000);

    const res = await getChurn(game.id, "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z");
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(1);
    expect(body.totalDeparturesInWindow).toBe(1);
    expect(body.bins.map((b2) => b2.count)).toEqual([1, 0, 0, 0, 0]);
    expect(body.from).toBe("2026-01-01T00:00:00Z");
    expect(body.to).toBe("2026-02-01T00:00:00Z");
  });

  it("counts a year-old departure when its group was created within the window (window applies to Group.createdAt)", async () => {
    // The window applies to the group, NOT to the departure, so a
    // group born in this window with an ancient departure still counts.
    const game = await createGame("Alpha", prisma);
    const group = await seedGroup(game.id, "A", {
      createdAt: new Date("2026-01-05T00:00:00Z"),
    });
    // Departure with a 200-day tenure, joined far in the past.
    await seedDeparture(group.id, 200 * ONE_DAY_MS, "left", new Date("2025-01-01T00:00:00Z"));

    const res = await getChurn(game.id, "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z");
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalDeparturesInWindow).toBe(1);
    expect(body.bins.map((b) => b.count)).toEqual([0, 0, 0, 0, 1]);
  });

  it("excludes soft-deleted groups from the population", async () => {
    const game = await createGame("Alpha", prisma);
    const live = await seedGroup(game.id, "live");
    const dead = await seedGroup(game.id, "dead", { softDeleted: true });
    await seedDeparture(live.id, 30 * 60 * 1000);
    await seedDeparture(dead.id, 30 * 60 * 1000);
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(1);
    expect(body.totalDeparturesInWindow).toBe(1);
  });

  it("scopes to the requested game (cross-game exclusion)", async () => {
    const a = await createGame("Alpha", prisma);
    const b = await createGame("Beta", prisma);
    const ag = await seedGroup(a.id, "ag");
    const bg = await seedGroup(b.id, "bg");
    await seedDeparture(ag.id, 30 * 60 * 1000);
    await seedDeparture(bg.id, 30 * 60 * 1000);

    const res = await getChurn(a.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(1);
    expect(body.totalDeparturesInWindow).toBe(1);
  });

  it("echoes from / to verbatim in the response when supplied", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id, "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z");
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.from).toBe("2026-01-01T00:00:00Z");
    expect(body.to).toBe("2026-02-01T00:00:00Z");
  });

  it("echoes null for from / to when omitted", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.from).toBeNull();
    expect(body.to).toBeNull();
  });

  it("supports a from-only window (open upper bound)", async () => {
    const game = await createGame("Alpha", prisma);
    const old = await seedGroup(game.id, "old", {
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    const fresh = await seedGroup(game.id, "fresh", {
      createdAt: new Date("2026-04-15T00:00:00Z"),
    });
    await seedDeparture(old.id, 30 * 60 * 1000);
    await seedDeparture(fresh.id, 30 * 60 * 1000);
    const res = await getChurn(game.id, "from=2026-04-01T00:00:00Z");
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(1);
    expect(body.totalDeparturesInWindow).toBe(1);
  });

  it("supports a to-only window (open lower bound)", async () => {
    const game = await createGame("Alpha", prisma);
    const old = await seedGroup(game.id, "old", {
      createdAt: new Date("2025-01-01T00:00:00Z"),
    });
    const fresh = await seedGroup(game.id, "fresh", {
      createdAt: new Date("2026-04-15T00:00:00Z"),
    });
    await seedDeparture(old.id, 30 * 60 * 1000);
    await seedDeparture(fresh.id, 30 * 60 * 1000);
    const res = await getChurn(game.id, "to=2026-04-01T00:00:00Z");
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalGroupsInWindow).toBe(1);
    expect(body.totalDeparturesInWindow).toBe(1);
  });

  it("ignores departures with leftAt = null even when status is left/kicked (defensive)", async () => {
    // The `status: "left" | "kicked"` rows are never written without a
    // `leftAt` in production, but the schema allows it and the
    // handler's filter (`leftAt: { not: null }`) guards against it.
    const game = await createGame("Alpha", prisma);
    const group = await seedGroup(game.id, "g");
    const u = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.create({
      data: {
        groupId: group.id,
        junjoUserId: u.id,
        status: "left",
        joinedAt: new Date("2026-01-01T00:00:00Z"),
        leftAt: null,
      },
    });
    const res = await getChurn(game.id);
    const body = (await res.json()) as WireAdminGroupChurn;
    expect(body.totalDeparturesInWindow).toBe(0);
  });

  it("returns 400 on a malformed `from` value", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id, "from=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 400 on a malformed `to` value", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id, "to=not-a-date");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the game does not exist", async () => {
    const res = await getChurn("game_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("returns 401 without an Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id, "", "");
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await getChurn(game.id, "", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
    const noTokenApp = createApp({ prisma });
    const game = await createGame("Alpha", prisma);
    const res = await noTokenApp.request(`/v1/admin/games/${game.id}/analytics/group-churn`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the gameId path parameter", async () => {
    const game = await createGame("Alpha", prisma);
    // Game ids are cuids without special chars, but the route should
    // tolerate URL-encoded path segments. Round-trip the same id.
    const res = await getChurn(encodeURIComponent(game.id));
    expect(res.status).toBe(200);
  });
});
