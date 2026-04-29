import type { GroupId } from "@junjo/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireGroupRelationship` from `routes/relationships.ts`
// (the admin route reuses the helper). Tests assert against this shape so
// drift on the route side surfaces as a typed failure.
type WireGroupRelationship = {
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setBy: string | null;
};

describe.skipIf(!TEST_DATABASE_URL)("admin relationships endpoints (Phase 11.7b-i)", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "GroupRelationship", "AuditEntry", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedTwoGroups(
    gameName: string,
    overrides: { aSoftDeleted?: boolean; bSoftDeleted?: boolean; bGameId?: string } = {},
  ) {
    const game = await createGame(gameName, prisma);
    const a = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "A",
        visibility: "invite-only",
        softDeletedAt: overrides.aSoftDeleted ? new Date() : null,
      },
    });
    const b = await prisma.group.create({
      data: {
        gameId: overrides.bGameId ?? game.id,
        kind: "guild",
        name: "B",
        visibility: "invite-only",
        softDeletedAt: overrides.bSoftDeleted ? new Date() : null,
      },
    });
    return { gameId: game.id, a, b };
  }

  function setRelationship(
    gameId: string,
    a: string,
    b: string,
    body: unknown,
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    return app.request(`/v1/admin/games/${gameId}/groups/${a}/relationships/${b}`, {
      method: "PUT",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function clearRelationship(
    gameId: string,
    a: string,
    b: string,
    query = "",
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    return app.request(`/v1/admin/games/${gameId}/groups/${a}/relationships/${b}${query}`, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  function getRelationship(gameId: string, a: string, b: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/groups/${a}/relationships/${b}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  function listRelationships(gameId: string, a: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/groups/${a}/relationships`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  describe("PUT /v1/admin/games/:gameId/groups/:a/relationships/:b", () => {
    it("creates a directed relationship and returns the wire shape", async () => {
      const seed = await seedTwoGroups("Alpha");

      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "ally" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGroupRelationship;
      expect(body.groupAId).toBe(seed.a.id);
      expect(body.groupBId).toBe(seed.b.id);
      expect(body.type).toBe("ally");
      expect(body.setBy).toBeNull();
      expect(typeof body.since).toBe("string");

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: seed.a.id, groupBId: seed.b.id } },
      });
      expect(stored?.type).toBe("ally");
      expect(stored?.setByUserId).toBeNull();
    });

    it("writes a group.relationship.set audit entry on the origin group", async () => {
      const seed = await seedTwoGroups("Alpha");

      await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "ally" });

      const entries = await prisma.auditEntry.findMany({ where: { groupId: seed.a.id } });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.action).toBe("group.relationship.set");
      expect(entry.targetId).toBe(seed.b.id);
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({
        groupAId: seed.a.id,
        groupBId: seed.b.id,
        type: "ally",
        mutual: false,
      });

      const otherEntries = await prisma.auditEntry.findMany({ where: { groupId: seed.b.id } });
      expect(otherEntries).toHaveLength(0);
    });

    it("writes both directions when mutual is true", async () => {
      const seed = await seedTwoGroups("Alpha");

      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, {
        type: "ally",
        mutual: true,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGroupRelationship;
      expect(body.groupAId).toBe(seed.a.id);
      expect(body.groupBId).toBe(seed.b.id);

      const both = await prisma.groupRelationship.findMany();
      expect(both).toHaveLength(2);
      expect(new Set(both.map((r) => r.type))).toEqual(new Set(["ally"]));

      const auditA = await prisma.auditEntry.findMany({ where: { groupId: seed.a.id } });
      expect(auditA).toHaveLength(1);
      expect(auditA[0]?.payload).toMatchObject({ mutual: true });
      const auditB = await prisma.auditEntry.findMany({ where: { groupId: seed.b.id } });
      expect(auditB).toHaveLength(1);
      expect(auditB[0]?.payload).toMatchObject({ mutual: true });
    });

    it("updates type and bumps `since` when row already exists with a different type", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "neutral", setByUserId: null },
      });

      const before = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: seed.a.id, groupBId: seed.b.id } },
      });
      if (!before) throw new Error("seeded row missing");

      await new Promise((r) => setTimeout(r, 5));
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "enemy" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGroupRelationship;
      expect(body.type).toBe("enemy");
      expect(new Date(body.since).getTime()).toBeGreaterThan(before.since.getTime());

      const entries = await prisma.auditEntry.findMany({ where: { groupId: seed.a.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.payload).toMatchObject({
        type: "enemy",
        before: { type: "neutral" },
      });
    });

    it("is idempotent when the type already matches (no audit, no since bump)", async () => {
      const seed = await seedTwoGroups("Alpha");
      const seeded = await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });

      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "ally" });
      expect(res.status).toBe(200);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: seed.a.id, groupBId: seed.b.id } },
      });
      expect(stored?.since.toISOString()).toBe(seeded.since.toISOString());
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it("writes only the missing direction on a partial-mutual update", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });

      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, {
        type: "ally",
        mutual: true,
      });
      expect(res.status).toBe(200);

      const both = await prisma.groupRelationship.findMany();
      expect(both).toHaveLength(2);

      const entries = await prisma.auditEntry.findMany();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.groupId).toBe(seed.b.id);
    });

    it("dispatches a group.relationship.changed JunjoEvent per changed direction", async () => {
      const seed = await seedTwoGroups("Alpha");

      const events: unknown[] = [];
      const { eventHub } = await import("../eventHub");
      const unsubA = eventHub.subscribe(seed.a.id as GroupId, (e) => events.push(e));
      const unsubB = eventHub.subscribe(seed.b.id as GroupId, (e) => events.push(e));
      try {
        const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, {
          type: "ally",
          mutual: true,
        });
        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(events).toHaveLength(2);
        for (const e of events) {
          const event = e as { type: string; gameId: string; relationship: { type: string } };
          expect(event.type).toBe("group.relationship.changed");
          expect(event.gameId).toBe(seed.gameId);
          expect(event.relationship.type).toBe("ally");
        }
      } finally {
        unsubA();
        unsubB();
      }
    });

    it("rejects a self-relationship with 400 bad_request", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, seed.a.id, seed.a.id, { type: "ally" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("bad_request");
    });

    it("rejects missing type with 400", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, {});
      expect(res.status).toBe(400);
    });

    it("rejects over-cap type with 400", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, {
        type: "x".repeat(65),
      });
      expect(res.status).toBe(400);
    });

    it("rejects non-string type with 400", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: 123 });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON with 400", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, "{ not json");
      expect(res.status).toBe(400);
    });

    it("returns 404 when group A is missing", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, "grp_missing", seed.b.id, { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B is missing", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(seed.gameId, seed.a.id, "grp_missing", { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group A is soft-deleted", async () => {
      const seed = await seedTwoGroups("Alpha", { aSoftDeleted: true });
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B is soft-deleted", async () => {
      const seed = await seedTwoGroups("Alpha", { bSoftDeleted: true });
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B belongs to a different game (cross-game)", async () => {
      const otherGame = await createGame("Other", prisma);
      const seed = await seedTwoGroups("Alpha", { bGameId: otherGame.id });
      const res = await setRelationship(seed.gameId, seed.a.id, seed.b.id, { type: "ally" });
      expect(res.status).toBe(404);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: seed.a.id, groupBId: seed.b.id } },
      });
      expect(stored).toBeNull();
    });

    it("returns 404 when the gameId does not match either group's game", async () => {
      const seed = await seedTwoGroups("Alpha");
      const otherGame = await createGame("Other", prisma);
      const res = await setRelationship(otherGame.id, seed.a.id, seed.b.id, { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 401 with no Authorization header", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.a.id}/relationships/${seed.b.id}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: "ally" }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with a wrong admin token", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await setRelationship(
        seed.gameId,
        seed.a.id,
        seed.b.id,
        { type: "ally" },
        "Bearer wrong",
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 when JUNJO_ADMIN_TOKEN is unset on the server", async () => {
      const noTokenApp = createApp({ prisma });
      const seed = await seedTwoGroups("Alpha");
      const res = await noTokenApp.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.a.id}/relationships/${seed.b.id}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ type: "ally" }),
        },
      );
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /v1/admin/games/:gameId/groups/:a/relationships/:b", () => {
    it("deletes the row and writes a group.relationship.cleared audit entry", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(204);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: seed.a.id, groupBId: seed.b.id } },
      });
      expect(stored).toBeNull();

      const entries = await prisma.auditEntry.findMany({ where: { groupId: seed.a.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("group.relationship.cleared");
      expect(entries[0]?.payload).toEqual({
        groupAId: seed.a.id,
        groupBId: seed.b.id,
        type: "ally",
        mutual: false,
      });
    });

    it("clears both directions when ?mutual=true is supplied", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: seed.b.id, groupBId: seed.a.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id, "?mutual=true");
      expect(res.status).toBe(204);

      const remaining = await prisma.groupRelationship.findMany();
      expect(remaining).toHaveLength(0);

      const entries = await prisma.auditEntry.findMany();
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((e) => e.groupId))).toEqual(new Set([seed.a.id, seed.b.id]));
    });

    it("is idempotent when the row does not exist (no audit, returns 204)", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(204);
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it("preserves the asymmetric counterpart when mutual is not set", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: seed.b.id, groupBId: seed.a.id, type: "neutral", setByUserId: null },
      });

      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(204);

      const remaining = await prisma.groupRelationship.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.groupAId).toBe(seed.b.id);
      expect(remaining[0]?.type).toBe("neutral");
    });

    it("dispatches a group.relationship.changed event with relationship: null per cleared direction", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });

      const events: unknown[] = [];
      const { eventHub } = await import("../eventHub");
      const unsub = eventHub.subscribe(seed.a.id as GroupId, (e) => events.push(e));
      try {
        const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id);
        expect(res.status).toBe(204);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(events).toHaveLength(1);
        const event = events[0] as { type: string; relationship: unknown };
        expect(event.type).toBe("group.relationship.changed");
        expect(event.relationship).toBeNull();
      } finally {
        unsub();
      }
    });

    it("rejects a self-relationship with 400 bad_request", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await clearRelationship(seed.gameId, seed.a.id, seed.a.id);
      expect(res.status).toBe(400);
    });

    it("rejects a malformed mutual query value", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id, "?mutual=yes");
      expect(res.status).toBe(400);
    });

    it("returns 404 when group B is missing", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await clearRelationship(seed.gameId, seed.a.id, "grp_missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B is in a different game and preserves the row", async () => {
      const otherGame = await createGame("Other", prisma);
      const seed = await seedTwoGroups("Alpha", { bGameId: otherGame.id });
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(404);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: seed.a.id, groupBId: seed.b.id } },
      });
      expect(stored).not.toBeNull();
    });

    it("returns 401 with no Authorization header", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.a.id}/relationships/${seed.b.id}`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with a wrong admin token", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await clearRelationship(seed.gameId, seed.a.id, seed.b.id, "", "Bearer wrong");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/admin/games/:gameId/groups/:a/relationships/:b", () => {
    it("returns the directed row when present", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });

      const res = await getRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGroupRelationship;
      expect(body.groupAId).toBe(seed.a.id);
      expect(body.groupBId).toBe(seed.b.id);
      expect(body.type).toBe("ally");
      expect(body.setBy).toBeNull();
    });

    it("returns 404 when no row exists for that direction (reverse only)", async () => {
      const seed = await seedTwoGroups("Alpha");
      await prisma.groupRelationship.create({
        data: { groupAId: seed.b.id, groupBId: seed.a.id, type: "ally", setByUserId: null },
      });

      const res = await getRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B is in a different game", async () => {
      const otherGame = await createGame("Other", prisma);
      const seed = await seedTwoGroups("Alpha", { bGameId: otherGame.id });
      const res = await getRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 on a self-relationship lookup", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await getRelationship(seed.gameId, seed.a.id, seed.a.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when either group is soft-deleted", async () => {
      const seed = await seedTwoGroups("Alpha", { bSoftDeleted: true });
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });
      const res = await getRelationship(seed.gameId, seed.a.id, seed.b.id);
      expect(res.status).toBe(404);
    });

    it("returns 401 with no Authorization header", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.a.id}/relationships/${seed.b.id}`,
      );
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/admin/games/:gameId/groups/:a/relationships", () => {
    it("returns an empty array when the group has no outgoing relationships", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await listRelationships(seed.gameId, seed.a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it("returns A-side rows sorted by groupBId asc and excludes reverse-direction rows", async () => {
      const seed = await seedTwoGroups("Alpha");
      const c = await prisma.group.create({
        data: { gameId: seed.gameId, kind: "guild", name: "C", visibility: "invite-only" },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: c.id, type: "enemy", setByUserId: null },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: seed.a.id, groupBId: seed.b.id, type: "ally", setByUserId: null },
      });
      // Reverse-direction row: should NOT appear in A's outgoing list.
      await prisma.groupRelationship.create({
        data: { groupAId: seed.b.id, groupBId: seed.a.id, type: "neutral", setByUserId: null },
      });

      const res = await listRelationships(seed.gameId, seed.a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireGroupRelationship[];
      expect(body).toHaveLength(2);
      const expectedOrder = [seed.b.id, c.id].sort();
      expect(body.map((r) => r.groupBId)).toEqual(expectedOrder);
    });

    it("returns 404 when the group is missing", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await listRelationships(game.id, "grp_missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the group is soft-deleted", async () => {
      const seed = await seedTwoGroups("Alpha", { aSoftDeleted: true });
      const res = await listRelationships(seed.gameId, seed.a.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when the group belongs to a different game", async () => {
      const seed = await seedTwoGroups("Alpha");
      const otherGame = await createGame("Other", prisma);
      const res = await listRelationships(otherGame.id, seed.a.id);
      expect(res.status).toBe(404);
    });

    it("returns 401 with no Authorization header", async () => {
      const seed = await seedTwoGroups("Alpha");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.a.id}/relationships`,
      );
      expect(res.status).toBe(401);
    });

    it("URL-decodes path-encoded gameId and groupId", async () => {
      const seed = await seedTwoGroups("Alpha");
      const encGame = encodeURIComponent(seed.gameId);
      const encA = encodeURIComponent(seed.a.id);
      const res = await app.request(`/v1/admin/games/${encGame}/groups/${encA}/relationships`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
    });
  });
});
