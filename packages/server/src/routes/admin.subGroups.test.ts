import type { GroupId } from "@junjo-io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminGroup` from `routes/admin.ts` (the parent
// + children handlers reuse it). Tests assert against this shape so
// drift on the route side surfaces as a typed failure.
type WireAdminGroup = {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
};

describe.skipIf(!TEST_DATABASE_URL)("admin sub-group endpoints", () => {
  let prisma: PrismaClient;
  let app: Hono;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createGroup(
    gameId: string,
    name: string,
    overrides: { parentGroupId?: string | null; softDeletedAt?: Date | null } = {},
  ) {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        parentGroupId: overrides.parentGroupId ?? null,
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  function setParent(
    gameId: string,
    groupId: string,
    body: unknown,
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/parent`, {
      method: "PUT",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function listChildren(gameId: string, groupId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/children`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  describe("PUT /v1/admin/games/:gameId/groups/:groupId/parent", () => {
    it("sets the parent and returns the updated group with full wire shape", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup;
      expect(body.id).toBe(child.id);
      expect(body.gameId).toBe(game.id);
      expect(body.kind).toBe("guild");
      expect(body.name).toBe("Child");
      expect(body.visibility).toBe("invite-only");
      expect(body.parentGroupId).toBe(parent.id);
      expect(body.memberCount).toBe(0);
      expect(typeof body.createdAt).toBe("string");
      expect(typeof body.updatedAt).toBe("string");

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBe(parent.id);
    });

    it("writes a group.parent.set audit entry with payload { before, after }", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      await setParent(game.id, child.id, { parentGroupId: parent.id });

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.action).toBe("group.parent.set");
      expect(entry.targetId).toBe(parent.id);
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({ before: null, after: parent.id });
    });

    it("clears the parent when parentGroupId is null and writes group.parent.cleared audit", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const child = await createGroup(game.id, "Child", { parentGroupId: parent.id });

      const res = await setParent(game.id, child.id, { parentGroupId: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup;
      expect(body.parentGroupId).toBeNull();

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.action).toBe("group.parent.cleared");
      expect(entry.targetId).toBeNull();
      expect(entry.payload).toEqual({ before: parent.id, after: null });
    });

    it("re-parents from one parent to another with audit before/after", async () => {
      const game = await createGame("Alpha", prisma);
      const oldParent = await createGroup(game.id, "OldParent");
      const newParent = await createGroup(game.id, "NewParent");
      const child = await createGroup(game.id, "Child", { parentGroupId: oldParent.id });

      const res = await setParent(game.id, child.id, { parentGroupId: newParent.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup;
      expect(body.parentGroupId).toBe(newParent.id);

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("group.parent.set");
      expect(entries[0]?.payload).toEqual({ before: oldParent.id, after: newParent.id });
    });

    it("is idempotent when parentGroupId already matches stored value (no audit, no updatedAt bump)", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const child = await createGroup(game.id, "Child", { parentGroupId: parent.id });
      const beforeUpdated = child.updatedAt;

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup;
      expect(body.parentGroupId).toBe(parent.id);

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(0);

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.updatedAt.getTime()).toBe(beforeUpdated.getTime());
    });

    it("is idempotent on already-null parent (no audit)", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, { parentGroupId: null });
      expect(res.status).toBe(200);

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(0);
    });

    it("dispatches a group.updated JunjoEvent after the transaction commits", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const events: unknown[] = [];
      const { eventHub } = await import("../eventHub");
      const unsub = eventHub.subscribe(child.id as GroupId, (e) => events.push(e));
      try {
        const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(events).toHaveLength(1);
        const event = events[0] as {
          type: string;
          gameId: string;
          group: { id: string; parentGroupId: string | null };
        };
        expect(event.type).toBe("group.updated");
        expect(event.gameId).toBe(game.id);
        expect(event.group.id).toBe(child.id);
        expect(event.group.parentGroupId).toBe(parent.id);
      } finally {
        unsub();
      }
    });

    it("does not dispatch a JunjoEvent on no-op (parentGroupId already matches)", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const child = await createGroup(game.id, "Child", { parentGroupId: parent.id });

      const events: unknown[] = [];
      const { eventHub } = await import("../eventHub");
      const unsub = eventHub.subscribe(child.id as GroupId, (e) => events.push(e));
      try {
        const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(events).toHaveLength(0);
      } finally {
        unsub();
      }
    });

    it("rejects a self-parent with 400 parent_cycle and preserves the row", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, { parentGroupId: child.id });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("parent_cycle");

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("rejects a deep cycle with 400 parent_cycle", async () => {
      // a -> b -> c chain; trying to make a's parent c (c's grandparent)
      // would create a cycle (a -> c -> b -> a). The walk runs from c
      // upward and finds a in the chain.
      const game = await createGame("Alpha", prisma);
      const a = await createGroup(game.id, "A");
      const b = await createGroup(game.id, "B", { parentGroupId: a.id });
      const c = await createGroup(game.id, "C", { parentGroupId: b.id });

      const res = await setParent(game.id, a.id, { parentGroupId: c.id });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("parent_cycle");

      const stored = await prisma.group.findUnique({ where: { id: a.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("allows direct child as parent of a sibling (no false-positive cycle)", async () => {
      const game = await createGame("Alpha", prisma);
      const a = await createGroup(game.id, "A");
      const b = await createGroup(game.id, "B", { parentGroupId: a.id });
      const sibling = await createGroup(game.id, "Sibling");

      const res = await setParent(game.id, sibling.id, { parentGroupId: b.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup;
      expect(body.parentGroupId).toBe(b.id);
    });

    it("rejects a missing parentGroupId field with 400", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("bad_request");
    });

    it("rejects an empty-string parentGroupId with 400", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, { parentGroupId: "" });
      expect(res.status).toBe(400);
    });

    it("rejects a non-string non-null parentGroupId with 400", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, { parentGroupId: 123 });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON with 400", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, "{not json");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the child group is missing", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");

      const res = await setParent(game.id, "grp_missing", { parentGroupId: parent.id });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("not_found");
    });

    it("returns 404 when the child group is soft-deleted", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const child = await createGroup(game.id, "Child", { softDeletedAt: new Date() });

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the candidate parent group is missing", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");

      const res = await setParent(game.id, child.id, { parentGroupId: "grp_missing" });
      expect(res.status).toBe(404);

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("returns 404 when the candidate parent is in a different game", async () => {
      const game = await createGame("Alpha", prisma);
      const otherGame = await createGame("Beta", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(otherGame.id, "Parent");

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("returns 404 when the candidate parent is soft-deleted", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent", { softDeletedAt: new Date() });

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the child group is in a different game (cross-game scope)", async () => {
      const game = await createGame("Alpha", prisma);
      const otherGame = await createGame("Beta", prisma);
      const child = await createGroup(otherGame.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id }, "");
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const res = await setParent(game.id, child.id, { parentGroupId: parent.id }, "Bearer wrong");
      expect(res.status).toBe(401);
    });

    it("returns 401 when the admin token is unset on the server", async () => {
      const localApp = createApp({ prisma });
      const game = await createGame("AlphaUnset", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const res = await localApp.request(`/v1/admin/games/${game.id}/groups/${child.id}/parent`, {
        method: "PUT",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ parentGroupId: parent.id }),
      });
      expect(res.status).toBe(401);
    });

    it("URL-decodes path parameters", async () => {
      const game = await createGame("Alpha", prisma);
      const child = await createGroup(game.id, "Child");
      const parent = await createGroup(game.id, "Parent");

      const res = await app.request(
        `/v1/admin/games/${encodeURIComponent(game.id)}/groups/${encodeURIComponent(child.id)}/parent`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ parentGroupId: parent.id }),
        },
      );
      expect(res.status).toBe(200);
    });
  });

  describe("GET /v1/admin/games/:gameId/groups/:groupId/children", () => {
    it("returns an empty array when the group has no children", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup[];
      expect(body).toEqual([]);
    });

    it("returns direct children sorted by createdAt desc with full wire shape", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const a = await createGroup(game.id, "ChildA", { parentGroupId: parent.id });
      await new Promise((r) => setTimeout(r, 5));
      const b = await createGroup(game.id, "ChildB", { parentGroupId: parent.id });
      await new Promise((r) => setTimeout(r, 5));
      const c = await createGroup(game.id, "ChildC", { parentGroupId: parent.id });

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup[];
      expect(body.map((g) => g.id)).toEqual([c.id, b.id, a.id]);
      const [first] = body;
      if (!first) throw new Error("expected at least one child");
      expect(first.gameId).toBe(game.id);
      expect(first.parentGroupId).toBe(parent.id);
      expect(first.kind).toBe("guild");
      expect(first.name).toBe("ChildC");
      expect(first.memberCount).toBe(0);
    });

    it("excludes soft-deleted children", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const live = await createGroup(game.id, "Live", { parentGroupId: parent.id });
      const dead = await createGroup(game.id, "Dead", {
        parentGroupId: parent.id,
        softDeletedAt: new Date(),
      });

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup[];
      expect(body.map((g) => g.id)).toEqual([live.id]);
      expect(body.map((g) => g.id)).not.toContain(dead.id);
    });

    it("does not recurse into grandchildren (direct children only)", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const child = await createGroup(game.id, "Child", { parentGroupId: parent.id });
      const grandchild = await createGroup(game.id, "Grand", { parentGroupId: child.id });

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup[];
      expect(body.map((g) => g.id)).toEqual([child.id]);
      expect(body.map((g) => g.id)).not.toContain(grandchild.id);
    });

    it("populates memberCount per child via batched groupBy", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");
      const childA = await createGroup(game.id, "ChildA", { parentGroupId: parent.id });
      const childB = await createGroup(game.id, "ChildB", { parentGroupId: parent.id });

      // Seed 2 active members in childA, 1 active + 1 left in childB.
      const u1 = await prisma.junjoUser.create({ data: {} });
      const u2 = await prisma.junjoUser.create({ data: {} });
      const u3 = await prisma.junjoUser.create({ data: {} });
      const u4 = await prisma.junjoUser.create({ data: {} });
      await prisma.groupMember.createMany({
        data: [
          { groupId: childA.id, junjoUserId: u1.id, status: "active" },
          { groupId: childA.id, junjoUserId: u2.id, status: "active" },
          { groupId: childB.id, junjoUserId: u3.id, status: "active" },
          { groupId: childB.id, junjoUserId: u4.id, status: "left", leftAt: new Date() },
        ],
      });

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroup[];
      const counts = new Map(body.map((g) => [g.id, g.memberCount]));
      expect(counts.get(childA.id)).toBe(2);
      expect(counts.get(childB.id)).toBe(1);
    });

    it("returns 404 when the parent group is missing", async () => {
      const game = await createGame("Alpha", prisma);

      const res = await listChildren(game.id, "grp_missing");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("not_found");
    });

    it("returns 404 when the parent group is soft-deleted", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent", { softDeletedAt: new Date() });

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when the parent group is in a different game (cross-game scope)", async () => {
      const game = await createGame("Alpha", prisma);
      const otherGame = await createGame("Beta", prisma);
      const parent = await createGroup(otherGame.id, "Parent");

      const res = await listChildren(game.id, parent.id);
      expect(res.status).toBe(404);
    });

    it("returns 401 without an Authorization header", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");

      const res = await listChildren(game.id, parent.id, "");
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");

      const res = await listChildren(game.id, parent.id, "Bearer wrong");
      expect(res.status).toBe(401);
    });

    it("URL-decodes path parameters", async () => {
      const game = await createGame("Alpha", prisma);
      const parent = await createGroup(game.id, "Parent");

      const res = await app.request(
        `/v1/admin/games/${encodeURIComponent(game.id)}/groups/${encodeURIComponent(parent.id)}/children`,
        { method: "GET", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
      );
      expect(res.status).toBe(200);
    });
  });
});
