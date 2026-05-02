import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminMemberActivity` from `routes/admin.ts`.
type WireAdminMemberActivity = {
  from: string | null;
  to: string | null;
  totalEvents: number;
  cells: number[][];
};

const TRUNCATE = 'TRUNCATE TABLE "AuditEntry", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)(
  "GET /v1/admin/games/:gameId/analytics/member-activity (Phase 12.4a)",
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

    async function seedGroup(
      gameId: string,
      name: string,
      overrides: { softDeleted?: boolean } = {},
    ) {
      return prisma.group.create({
        data: {
          gameId,
          kind: "guild",
          name,
          visibility: "invite-only",
          softDeletedAt: overrides.softDeleted ? new Date() : null,
        },
      });
    }

    async function seedAudit(groupId: string, createdAt: Date, action = "member.joined") {
      return prisma.auditEntry.create({
        data: {
          groupId,
          action,
          actorUserId: null,
          targetId: null,
          payload: {},
          createdAt,
        },
      });
    }

    function getActivity(gameId: string, query = "", header = `Bearer ${ADMIN_TOKEN}`) {
      const path = query
        ? `/v1/admin/games/${gameId}/analytics/member-activity?${query}`
        : `/v1/admin/games/${gameId}/analytics/member-activity`;
      return app.request(path, { method: "GET", headers: { authorization: header } });
    }

    function emptyGrid(): number[][] {
      const cells: number[][] = [];
      for (let d = 0; d < 7; d += 1) cells.push(new Array<number>(24).fill(0));
      return cells;
    }

    it("returns the fully-zero 7x24 grid when the game has no audit entries", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(0);
      expect(body.cells).toEqual(emptyGrid());
      expect(body.cells.length).toBe(7);
      expect(body.cells[0]?.length).toBe(24);
    });

    it("places a single audit entry into the correct (UTC dow, hour) cell", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // Wednesday 2026-01-07 at 14:30 UTC. UTC day-of-week: Wednesday=3.
      // UTC hour: 14.
      await seedAudit(group.id, new Date("2026-01-07T14:30:00Z"));

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(1);
      expect(body.cells[3]?.[14]).toBe(1);
      // Every other cell must remain zero.
      for (let d = 0; d < 7; d += 1) {
        for (let h = 0; h < 24; h += 1) {
          if (d === 3 && h === 14) continue;
          expect(body.cells[d]?.[h]).toBe(0);
        }
      }
    });

    it("sums multiple audit entries that land in the same cell", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // Three entries on Sunday 2026-01-04 at hour 9 UTC. dow=0, hour=9.
      await seedAudit(group.id, new Date("2026-01-04T09:01:00Z"));
      await seedAudit(group.id, new Date("2026-01-04T09:30:00Z"));
      await seedAudit(group.id, new Date("2026-01-04T09:59:59Z"));

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(3);
      expect(body.cells[0]?.[9]).toBe(3);
    });

    it("places entries on the correct UTC day-of-week (Sunday=0 ... Saturday=6)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // 2026-01-04 (Sun) through 2026-01-10 (Sat), one entry each.
      await seedAudit(group.id, new Date("2026-01-04T12:00:00Z")); // Sun -> 0
      await seedAudit(group.id, new Date("2026-01-05T12:00:00Z")); // Mon -> 1
      await seedAudit(group.id, new Date("2026-01-06T12:00:00Z")); // Tue -> 2
      await seedAudit(group.id, new Date("2026-01-07T12:00:00Z")); // Wed -> 3
      await seedAudit(group.id, new Date("2026-01-08T12:00:00Z")); // Thu -> 4
      await seedAudit(group.id, new Date("2026-01-09T12:00:00Z")); // Fri -> 5
      await seedAudit(group.id, new Date("2026-01-10T12:00:00Z")); // Sat -> 6

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(7);
      for (let d = 0; d < 7; d += 1) {
        expect(body.cells[d]?.[12]).toBe(1);
      }
    });

    it("places entries on the correct UTC hour-of-day (0-23)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // 24 entries at 24 distinct hours on Sunday 2026-01-04.
      for (let h = 0; h < 24; h += 1) {
        const ts = new Date(Date.UTC(2026, 0, 4, h, 0, 0));
        await seedAudit(group.id, ts);
      }

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(24);
      for (let h = 0; h < 24; h += 1) {
        expect(body.cells[0]?.[h]).toBe(1);
      }
    });

    it("counts audit entries from soft-deleted groups (audit history rule)", async () => {
      const game = await createGame("Alpha", prisma);
      const live = await seedGroup(game.id, "live");
      const dead = await seedGroup(game.id, "dead", { softDeleted: true });
      // Both groups generate one entry at the same timestamp.
      const ts = new Date("2026-01-04T08:00:00Z"); // Sun, hr 8
      await seedAudit(live.id, ts);
      await seedAudit(dead.id, ts);

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(2);
      expect(body.cells[0]?.[8]).toBe(2);
    });

    it("fans in audit entries across every group in the game", async () => {
      const game = await createGame("Alpha", prisma);
      const a = await seedGroup(game.id, "A");
      const b = await seedGroup(game.id, "B");
      const c = await seedGroup(game.id, "C");
      // Three groups, each one entry at the same time.
      const ts = new Date("2026-01-04T15:00:00Z"); // Sun, hr 15
      await seedAudit(a.id, ts);
      await seedAudit(b.id, ts);
      await seedAudit(c.id, ts);

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(3);
      expect(body.cells[0]?.[15]).toBe(3);
    });

    it("scopes counts to the requested game (cross-game exclusion)", async () => {
      const a = await createGame("Alpha", prisma);
      const b = await createGame("Beta", prisma);
      const ag = await seedGroup(a.id, "ag");
      const bg = await seedGroup(b.id, "bg");
      const ts = new Date("2026-01-04T10:00:00Z");
      await seedAudit(ag.id, ts);
      await seedAudit(bg.id, ts);

      const res = await getActivity(a.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(1);
      expect(body.cells[0]?.[10]).toBe(1);
    });

    it("respects from (inclusive) and to (exclusive) bounds", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      // Three entries: before window, in window, after window.
      await seedAudit(group.id, new Date("2025-12-31T12:00:00Z"));
      await seedAudit(group.id, new Date("2026-01-04T12:00:00Z")); // in window
      await seedAudit(group.id, new Date("2026-02-15T12:00:00Z"));

      const res = await getActivity(game.id, "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z");
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(1);
      expect(body.cells[0]?.[12]).toBe(1);
      expect(body.from).toBe("2026-01-01T00:00:00Z");
      expect(body.to).toBe("2026-02-01T00:00:00Z");
    });

    it("treats the upper bound `to` as exclusive (a row at exactly `to` is dropped)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const boundary = new Date("2026-01-04T00:00:00Z");
      await seedAudit(group.id, boundary);

      const res = await getActivity(game.id, "from=2026-01-01T00:00:00Z&to=2026-01-04T00:00:00Z");
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(0);
    });

    it("treats the lower bound `from` as inclusive (a row at exactly `from` is included)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const boundary = new Date("2026-01-04T00:00:00Z");
      await seedAudit(group.id, boundary);

      const res = await getActivity(game.id, "from=2026-01-04T00:00:00Z");
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(1);
    });

    it("supports a from-only window (open upper bound)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      await seedAudit(group.id, new Date("2025-01-01T08:00:00Z"));
      await seedAudit(group.id, new Date("2026-04-15T08:00:00Z"));

      const res = await getActivity(game.id, "from=2026-04-01T00:00:00Z");
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(1);
    });

    it("supports a to-only window (open lower bound)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      await seedAudit(group.id, new Date("2025-01-01T08:00:00Z"));
      await seedAudit(group.id, new Date("2026-04-15T08:00:00Z"));

      const res = await getActivity(game.id, "to=2026-04-01T00:00:00Z");
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(1);
    });

    it("echoes from / to verbatim in the response when supplied", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id, "from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z");
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.from).toBe("2026-01-01T00:00:00Z");
      expect(body.to).toBe("2026-02-01T00:00:00Z");
    });

    it("echoes null for from / to when omitted", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.from).toBeNull();
      expect(body.to).toBeNull();
    });

    it("counts audit entries regardless of `action` (any action contributes)", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      const ts = new Date("2026-01-04T11:00:00Z"); // Sun, hr 11
      await seedAudit(group.id, ts, "member.joined");
      await seedAudit(group.id, ts, "member.left");
      await seedAudit(group.id, ts, "role.created");
      await seedAudit(group.id, ts, "permission.granted");
      await seedAudit(group.id, ts, "group.updated");

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.totalEvents).toBe(5);
      expect(body.cells[0]?.[11]).toBe(5);
    });

    it("returns 400 on a malformed `from` value", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id, "from=not-a-date");
      expect(res.status).toBe(400);
    });

    it("returns 400 on a malformed `to` value", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id, "to=not-a-date");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the game does not exist", async () => {
      const res = await getActivity("game_does_not_exist");
      expect(res.status).toBe(404);
    });

    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id, "", "");
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(game.id, "", "Bearer wrong-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
      const noTokenApp = createApp({ prisma });
      const game = await createGame("Alpha", prisma);
      const res = await noTokenApp.request(`/v1/admin/games/${game.id}/analytics/member-activity`, {
        method: "GET",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(401);
    });

    it("URL-decodes the gameId path parameter", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await getActivity(encodeURIComponent(game.id));
      expect(res.status).toBe(200);
    });

    it("preserves all 168 cells in row-major order even when only a few cells have data", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await seedGroup(game.id, "g1");
      await seedAudit(group.id, new Date("2026-01-07T14:30:00Z")); // Wed, 14
      await seedAudit(group.id, new Date("2026-01-10T03:00:00Z")); // Sat, 3

      const res = await getActivity(game.id);
      const body = (await res.json()) as WireAdminMemberActivity;
      expect(body.cells.length).toBe(7);
      for (const row of body.cells) expect(row.length).toBe(24);
      expect(body.cells[3]?.[14]).toBe(1);
      expect(body.cells[6]?.[3]).toBe(1);
      expect(body.totalEvents).toBe(2);
    });
  },
);
