import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAdminAuditEntry` from `routes/admin.ts` (the
// per-game audit handler reuses the cross-game shape verbatim per the
// iter-059 / iter-076 boundary stance: small structural duplication is
// cheaper than coupling, and reusing the shape keeps both feeds parsable
// by the same dashboard helper).
type WireAdminAuditEntry = {
  id: string;
  action: string;
  gameId: string;
  gameName: string;
  groupId: string;
  groupName: string;
  groupSoftDeleted: boolean;
  actorUserId: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type WireAdminGameAuditPage = {
  items: WireAdminAuditEntry[];
  nextCursor: string | null;
};

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "Group", "ApiKey", "Game", "ExternalIdentity", "JunjoUser" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/audit", () => {
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
    gameName: string,
    groupName: string,
    options: { softDeleted?: boolean; gameId?: string } = {},
  ) {
    const gameId = options.gameId ?? (await createGame(gameName, prisma)).id;
    const group = await prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: groupName,
        visibility: "invite-only",
        softDeletedAt: options.softDeleted ? new Date() : null,
      },
    });
    return { gameId, groupId: group.id };
  }

  async function seedJunjoUser() {
    return prisma.junjoUser.create({ data: {} });
  }

  async function seedAudit(
    groupId: string,
    overrides: Partial<{
      action: string;
      actorUserId: string | null;
      targetId: string | null;
      payload: object;
      createdAt: Date;
    }> = {},
  ) {
    return prisma.auditEntry.create({
      data: {
        groupId,
        action: overrides.action ?? "group.created",
        actorUserId: overrides.actorUserId ?? null,
        targetId: overrides.targetId ?? null,
        payload: (overrides.payload ?? {}) as object,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  function listAudit(gameId: string, query = "", header = `Bearer ${ADMIN_TOKEN}`) {
    const path = query
      ? `/v1/admin/games/${gameId}/audit?${query}`
      : `/v1/admin/games/${gameId}/audit`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  it("returns an empty page when the game has no audit entries", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns entries newest first with full wire format populated (gameId, gameName, groupId, groupName, groupSoftDeleted)", async () => {
    const seed = await seedGroup("Alpha", "Guild Alpha");
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    await seedAudit(seed.groupId, { action: "group.created", createdAt: t0 });
    await seedAudit(seed.groupId, {
      action: "member.invited",
      createdAt: t1,
      targetId: "user_alice",
      payload: { invitationId: "inv_1", code: "abcd" },
    });

    const res = await listAudit(seed.gameId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["member.invited", "group.created"]);
    const [first] = body.items;
    expect(first?.gameId).toBe(seed.gameId);
    expect(first?.gameName).toBe("Alpha");
    expect(first?.groupId).toBe(seed.groupId);
    expect(first?.groupName).toBe("Guild Alpha");
    expect(first?.groupSoftDeleted).toBe(false);
    expect(first?.targetId).toBe("user_alice");
    expect(first?.actorUserId).toBeNull();
    expect(first?.payload).toEqual({ invitationId: "inv_1", code: "abcd" });
    expect(new Date(first?.createdAt as string).toISOString()).toBe(t1.toISOString());
    expect(body.nextCursor).toBeNull();
  });

  it("scopes results to the requested game (cross-game exclusion)", async () => {
    const a = await seedGroup("Alpha", "g1");
    const b = await seedGroup("Beta", "g2");
    await seedAudit(a.groupId, { action: "group.created" });
    await seedAudit(b.groupId, { action: "group.created" });
    await seedAudit(b.groupId, { action: "group.updated" });

    const res = await listAudit(a.gameId);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.groupId).toBe(a.groupId);
    expect(body.items[0]?.gameId).toBe(a.gameId);
  });

  it("fans in entries across multiple groups within the same game", async () => {
    const game = await createGame("Alpha", prisma);
    const g1 = await seedGroup("Alpha", "g1", { gameId: game.id });
    const g2 = await seedGroup("Alpha", "g2", { gameId: game.id });
    const g3 = await seedGroup("Alpha", "g3", { gameId: game.id });
    const t = (i: number) => new Date(Date.UTC(2026, 0, 1 + i));
    await seedAudit(g1.groupId, { action: "group.created", createdAt: t(0) });
    await seedAudit(g2.groupId, { action: "group.created", createdAt: t(1) });
    await seedAudit(g3.groupId, { action: "member.invited", createdAt: t(2) });

    const res = await listAudit(game.id);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(3);
    expect(body.items.map((i) => i.groupId)).toEqual([g3.groupId, g2.groupId, g1.groupId]);
  });

  it("includes audit entries from soft-deleted groups with groupSoftDeleted=true", async () => {
    const game = await createGame("Alpha", prisma);
    const live = await seedGroup("Alpha", "live", { gameId: game.id });
    const dead = await seedGroup("Alpha", "dead", { gameId: game.id, softDeleted: true });
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    await seedAudit(live.groupId, { action: "group.created", createdAt: tA });
    await seedAudit(dead.groupId, { action: "group.deleted", createdAt: tB });

    const res = await listAudit(game.id);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(2);
    const liveItem = body.items.find((i) => i.groupId === live.groupId);
    const deadItem = body.items.find((i) => i.groupId === dead.groupId);
    expect(liveItem?.groupSoftDeleted).toBe(false);
    expect(deadItem?.groupSoftDeleted).toBe(true);
  });

  it("filters by `before` (exclusive upper bound)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    await seedAudit(seed.groupId, { action: "group.created", createdAt: tA });
    await seedAudit(seed.groupId, { action: "group.updated", createdAt: tB });
    await seedAudit(seed.groupId, { action: "member.invited", createdAt: tC });

    const res = await listAudit(seed.gameId, `before=${encodeURIComponent(tC.toISOString())}`);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["group.updated", "group.created"]);
  });

  it("filters by `since` (inclusive lower bound)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    await seedAudit(seed.groupId, { action: "group.created", createdAt: tA });
    await seedAudit(seed.groupId, { action: "group.updated", createdAt: tB });
    await seedAudit(seed.groupId, { action: "member.invited", createdAt: tC });

    const res = await listAudit(seed.gameId, `since=${encodeURIComponent(tB.toISOString())}`);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["member.invited", "group.updated"]);
  });

  it("combines `since` and `before` for a date-range filter", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    const tD = new Date("2026-04-04T00:00:00Z");
    await seedAudit(seed.groupId, { action: "group.created", createdAt: tA });
    await seedAudit(seed.groupId, { action: "group.updated", createdAt: tB });
    await seedAudit(seed.groupId, { action: "member.invited", createdAt: tC });
    await seedAudit(seed.groupId, { action: "role.created", createdAt: tD });

    const res = await listAudit(
      seed.gameId,
      `since=${encodeURIComponent(tB.toISOString())}&before=${encodeURIComponent(tD.toISOString())}`,
    );
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["member.invited", "group.updated"]);
  });

  it("filters by a single `actions` value", async () => {
    const seed = await seedGroup("Alpha", "g1");
    await seedAudit(seed.groupId, { action: "group.created" });
    await seedAudit(seed.groupId, { action: "group.updated" });
    await seedAudit(seed.groupId, { action: "member.invited" });

    const res = await listAudit(seed.gameId, "actions=group.updated");
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["group.updated"]);
  });

  it("filters by multiple `actions` values (OR semantics)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    await seedAudit(seed.groupId, { action: "group.created" });
    await seedAudit(seed.groupId, { action: "group.updated" });
    await seedAudit(seed.groupId, { action: "member.invited" });
    await seedAudit(seed.groupId, { action: "role.created" });

    const res = await listAudit(seed.gameId, "actions=group.created&actions=role.created");
    const body = (await res.json()) as WireAdminGameAuditPage;
    const sorted = body.items.map((i) => i.action).sort();
    expect(sorted).toEqual(["group.created", "role.created"]);
  });

  it("filters by `actorUserId` (exact match)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const alice = await seedJunjoUser();
    const bob = await seedJunjoUser();
    await seedAudit(seed.groupId, { action: "member.joined", actorUserId: alice.id });
    await seedAudit(seed.groupId, { action: "member.left", actorUserId: alice.id });
    await seedAudit(seed.groupId, { action: "member.left", actorUserId: bob.id });
    await seedAudit(seed.groupId, { action: "group.created", actorUserId: null });

    const res = await listAudit(seed.gameId, `actorUserId=${alice.id}`);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(2);
    for (const entry of body.items) {
      expect(entry.actorUserId).toBe(alice.id);
    }
  });

  it("filters by `targetId` (exact match)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    await seedAudit(seed.groupId, { action: "member.invited", targetId: "user_alice" });
    await seedAudit(seed.groupId, { action: "member.invited", targetId: "user_bob" });
    await seedAudit(seed.groupId, { action: "group.created", targetId: null });

    const res = await listAudit(seed.gameId, "targetId=user_alice");
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.targetId).toBe("user_alice");
  });

  it("combines all filters together", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const alice = await seedJunjoUser();
    const other = await seedJunjoUser();
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    // matches: in date range, action match, actor match, target match
    await seedAudit(seed.groupId, {
      action: "member.invited",
      createdAt: tB,
      actorUserId: alice.id,
      targetId: "user_target",
    });
    // out of date range
    await seedAudit(seed.groupId, {
      action: "member.invited",
      createdAt: new Date("2026-03-01T00:00:00Z"),
      actorUserId: alice.id,
      targetId: "user_target",
    });
    // wrong actor
    await seedAudit(seed.groupId, {
      action: "member.invited",
      createdAt: tB,
      actorUserId: other.id,
      targetId: "user_target",
    });
    // wrong action
    await seedAudit(seed.groupId, {
      action: "group.updated",
      createdAt: tB,
      actorUserId: alice.id,
      targetId: "user_target",
    });

    const params = new URLSearchParams({
      since: tA.toISOString(),
      before: tC.toISOString(),
      actorUserId: alice.id,
      targetId: "user_target",
    });
    params.append("actions", "member.invited");
    const res = await listAudit(seed.gameId, params.toString());
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.actorUserId).toBe(alice.id);
    expect(body.items[0]?.targetId).toBe("user_target");
    expect(body.items[0]?.action).toBe("member.invited");
  });

  it("paginates via limit + nextCursor (consumer feeds nextCursor back as `before`)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    for (let i = 0; i < 5; i++) {
      await seedAudit(seed.groupId, {
        action: "group.updated",
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const first = await listAudit(seed.gameId, "limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as WireAdminGameAuditPage;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(firstBody.items[1]?.createdAt);

    const second = await listAudit(
      seed.gameId,
      `limit=2&before=${encodeURIComponent(firstBody.nextCursor as string)}`,
    );
    const secondBody = (await second.json()) as WireAdminGameAuditPage;
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.items.map((i) => i.createdAt)).not.toEqual(
      firstBody.items.map((i) => i.createdAt),
    );
    expect(secondBody.nextCursor).toBe(secondBody.items[1]?.createdAt);

    const third = await listAudit(
      seed.gameId,
      `limit=2&before=${encodeURIComponent(secondBody.nextCursor as string)}`,
    );
    const thirdBody = (await third.json()) as WireAdminGameAuditPage;
    expect(thirdBody.items).toHaveLength(1);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("uses default limit of 50 when no limit query supplied", async () => {
    const seed = await seedGroup("Alpha", "g1");
    for (let i = 0; i < 60; i++) {
      await seedAudit(seed.groupId, {
        action: "group.updated",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }

    const res = await listAudit(seed.gameId);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it("preserves audit `payload` verbatim across the wire", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const payload = {
      before: { name: "old", visibility: "secret" },
      after: { name: "new", visibility: "public" },
      reason: "renamed for clarity",
      counts: { added: 3, removed: 2 },
    };
    await seedAudit(seed.groupId, { action: "group.updated", payload });

    const res = await listAudit(seed.gameId);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items[0]?.payload).toEqual(payload);
  });

  it("rejects limit=0 with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "limit=101");
    expect(res.status).toBe(400);
  });

  it("rejects malformed `before` with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "before=not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects malformed `since` with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "since=not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects unknown action enum value with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "actions=group.notreal");
    expect(res.status).toBe(400);
  });

  it("rejects empty actorUserId with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "actorUserId=");
    expect(res.status).toBe(400);
  });

  it("rejects over-cap actorUserId with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const overCap = "a".repeat(256);
    const res = await listAudit(game.id, `actorUserId=${overCap}`);
    expect(res.status).toBe(400);
  });

  it("rejects empty targetId with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "targetId=");
    expect(res.status).toBe(400);
  });

  it("rejects over-cap targetId with 400", async () => {
    const game = await createGame("Alpha", prisma);
    const overCap = "a".repeat(256);
    const res = await listAudit(game.id, `targetId=${overCap}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown gameId", async () => {
    const res = await listAudit("ghost-game");
    expect(res.status).toBe(404);
  });

  it("does not 404 on a game with zero audit entries (returns 200 + empty array)", async () => {
    const game = await createGame("Alpha", prisma);
    // No groups, no audit entries.
    const res = await listAudit(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns 401 with no Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/audit`);
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listAudit(game.id, "", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the server has no admin token configured", async () => {
    const noAdmin = createApp({ prisma });
    const game = await createGame("Alpha", prisma);
    await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g", visibility: "invite-only" },
    });
    const res = await noAdmin.request(`/v1/admin/games/${game.id}/audit`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the gameId path parameter", async () => {
    const game = await createGame("Slash Game", prisma);
    const group = await prisma.group.create({
      data: { gameId: game.id, kind: "guild", name: "g", visibility: "invite-only" },
    });
    await seedAudit(group.id, { action: "group.created" });
    const res = await listAudit(encodeURIComponent(game.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(1);
  });

  it("preserves `(createdAt desc, id desc)` ordering across same-millisecond rows", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const sameTime = new Date("2026-04-01T00:00:00Z");
    const a = await seedAudit(seed.groupId, { action: "group.created", createdAt: sameTime });
    const b = await seedAudit(seed.groupId, { action: "group.updated", createdAt: sameTime });
    const c = await seedAudit(seed.groupId, { action: "member.invited", createdAt: sameTime });

    const res = await listAudit(seed.gameId);
    const body = (await res.json()) as WireAdminGameAuditPage;
    expect(body.items).toHaveLength(3);
    // Sort by id desc within the same timestamp.
    const sortedIds = [a.id, b.id, c.id].sort().reverse();
    expect(body.items.map((i) => i.id)).toEqual(sortedIds);
  });
});
