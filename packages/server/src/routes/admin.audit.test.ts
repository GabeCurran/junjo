import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shape mirrors `WireAuditEntry` from `routes/audit.ts` (the admin
// handler reuses it verbatim). Tests assert against this shape so a
// route-side drift surfaces as a typed test failure.
type WireAuditEntry = {
  id: string;
  groupId: string;
  actorUserId: string | null;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type WireAuditPage = {
  items: WireAuditEntry[];
  nextCursor: string | null;
};

const TRUNCATE = 'TRUNCATE TABLE "AuditEntry", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/groups/:groupId/audit", () => {
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
    options: { softDeleted?: boolean } = {},
  ) {
    const game = await createGame(gameName, prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: groupName,
        visibility: "invite-only",
        softDeletedAt: options.softDeleted ? new Date() : null,
      },
    });
    return { gameId: game.id, groupId: group.id };
  }

  async function seedAudit(
    gameId: string,
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
        gameId,
        groupId,
        action: overrides.action ?? "group.created",
        actorUserId: overrides.actorUserId ?? null,
        targetId: overrides.targetId ?? null,
        payload: (overrides.payload ?? {}) as object,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  function listAudit(
    gameId: string,
    groupId: string,
    query = "",
    header = `Bearer ${ADMIN_TOKEN}`,
  ) {
    const path = query
      ? `/v1/admin/games/${gameId}/groups/${groupId}/audit?${query}`
      : `/v1/admin/games/${gameId}/groups/${groupId}/audit`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  it("returns an empty page when no audit entries exist", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, seed.groupId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAuditPage;
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns entries newest first with full wire format populated", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");
    await seedAudit(seed.gameId, seed.groupId, { action: "group.created", createdAt: t0 });
    await seedAudit(seed.gameId, seed.groupId, {
      action: "group.updated",
      createdAt: t1,
      payload: { before: { name: "old" }, after: { name: "new" } },
    });
    await seedAudit(seed.gameId, seed.groupId, {
      action: "member.invited",
      createdAt: t2,
      targetId: "user_alice",
    });

    const res = await listAudit(seed.gameId, seed.groupId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAuditPage;
    expect(body.items.map((i) => i.action)).toEqual([
      "member.invited",
      "group.updated",
      "group.created",
    ]);
    const [first, second] = body.items;
    expect(first?.groupId).toBe(seed.groupId);
    expect(first?.targetId).toBe("user_alice");
    expect(first?.actorUserId).toBeNull();
    expect(first?.payload).toEqual({});
    expect(new Date(first?.createdAt as string).toISOString()).toBe(t2.toISOString());
    expect(second?.payload).toEqual({ before: { name: "old" }, after: { name: "new" } });
    expect(body.nextCursor).toBeNull();
  });

  it("filters entries to the requested group only", async () => {
    const a = await seedGroup("Alpha", "g1");
    const b = await seedGroup("Alpha-Other", "g2");
    await seedAudit(a.gameId, a.groupId, { action: "group.created" });
    await seedAudit(b.gameId, b.groupId, { action: "group.created" });
    await seedAudit(b.gameId, b.groupId, { action: "group.updated" });

    const res = await listAudit(a.gameId, a.groupId);
    const body = (await res.json()) as WireAuditPage;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.groupId).toBe(a.groupId);
  });

  it("filters by `before` (exclusive timestamp bound)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    await seedAudit(seed.gameId, seed.groupId, { action: "group.created", createdAt: tA });
    await seedAudit(seed.gameId, seed.groupId, { action: "group.updated", createdAt: tB });
    await seedAudit(seed.gameId, seed.groupId, { action: "member.invited", createdAt: tC });

    const res = await listAudit(
      seed.gameId,
      seed.groupId,
      `before=${encodeURIComponent(tC.toISOString())}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["group.updated", "group.created"]);
  });

  it("filters by a single `actions` value", async () => {
    const seed = await seedGroup("Alpha", "g1");
    await seedAudit(seed.gameId, seed.groupId, { action: "group.created" });
    await seedAudit(seed.gameId, seed.groupId, { action: "group.updated" });
    await seedAudit(seed.gameId, seed.groupId, { action: "member.invited" });

    const res = await listAudit(seed.gameId, seed.groupId, "actions=group.updated");
    const body = (await res.json()) as WireAuditPage;
    expect(body.items.map((i) => i.action)).toEqual(["group.updated"]);
  });

  it("filters by multiple `actions` values (OR semantics)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    await seedAudit(seed.gameId, seed.groupId, { action: "group.created" });
    await seedAudit(seed.gameId, seed.groupId, { action: "group.updated" });
    await seedAudit(seed.gameId, seed.groupId, { action: "member.invited" });
    await seedAudit(seed.gameId, seed.groupId, { action: "role.created" });

    const res = await listAudit(
      seed.gameId,
      seed.groupId,
      "actions=group.created&actions=role.created",
    );
    const body = (await res.json()) as WireAuditPage;
    const sorted = body.items.map((i) => i.action).sort();
    expect(sorted).toEqual(["group.created", "role.created"]);
  });

  it("paginates via limit + nextCursor (consumer feeds nextCursor back as `before`)", async () => {
    const seed = await seedGroup("Alpha", "g1");
    for (let i = 0; i < 5; i++) {
      await seedAudit(seed.gameId, seed.groupId, {
        action: "group.updated",
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const first = await listAudit(seed.gameId, seed.groupId, "limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as WireAuditPage;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(firstBody.items[1]?.id);

    const second = await listAudit(
      seed.gameId,
      seed.groupId,
      `limit=2&before=${encodeURIComponent(firstBody.nextCursor as string)}`,
    );
    const secondBody = (await second.json()) as WireAuditPage;
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.items.map((i) => i.createdAt)).not.toEqual(
      firstBody.items.map((i) => i.createdAt),
    );
    expect(secondBody.nextCursor).toBe(secondBody.items[1]?.id);

    const third = await listAudit(
      seed.gameId,
      seed.groupId,
      `limit=2&before=${encodeURIComponent(secondBody.nextCursor as string)}`,
    );
    const thirdBody = (await third.json()) as WireAuditPage;
    expect(thirdBody.items).toHaveLength(1);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("uses default limit of 50 when no limit query supplied", async () => {
    const seed = await seedGroup("Alpha", "g1");
    for (let i = 0; i < 60; i++) {
      await seedAudit(seed.gameId, seed.groupId, {
        action: "group.updated",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }

    const res = await listAudit(seed.gameId, seed.groupId);
    const body = (await res.json()) as WireAuditPage;
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it("rejects limit=0 with 400", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, seed.groupId, "limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects limit > 100 with 400", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, seed.groupId, "limit=101");
    expect(res.status).toBe(400);
  });

  it("rejects malformed `before` with 400", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, seed.groupId, "before=not-a-date");
    expect(res.status).toBe(400);
  });

  it("rejects unknown action enum value with 400", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, seed.groupId, "actions=group.notreal");
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown groupId", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, "ghost-group");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const seed = await seedGroup("Alpha", "g1", { softDeleted: true });
    await seedAudit(seed.gameId, seed.groupId, { action: "group.created" });
    const res = await listAudit(seed.gameId, seed.groupId);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game (cross-game scope)", async () => {
    const a = await seedGroup("Alpha", "g1");
    const b = await seedGroup("Beta", "g2");
    await seedAudit(b.gameId, b.groupId, { action: "group.created" });
    // Hit Alpha's gameId with Beta's groupId.
    const res = await listAudit(a.gameId, b.groupId);
    expect(res.status).toBe(404);
    // Sanity: Beta's own gameId resolves the same group.
    const ok = await listAudit(b.gameId, b.groupId);
    expect(ok.status).toBe(200);
  });

  it("returns 401 with no Authorization header", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await app.request(`/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/audit`);
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong admin token", async () => {
    const seed = await seedGroup("Alpha", "g1");
    const res = await listAudit(seed.gameId, seed.groupId, "", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the server has no admin token configured", async () => {
    const noAdmin = createApp({ prisma });
    const seed = await seedGroup("Alpha", "g1");
    await seedAudit(seed.gameId, seed.groupId, { action: "group.created" });
    const res = await noAdmin.request(
      `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/audit`,
      { method: "GET", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    );
    expect(res.status).toBe(401);
  });

  it("URL-decodes path parameters", async () => {
    const game = await createGame("Slash Game", prisma);
    const group = await prisma.group.create({
      data: {
        gameId: game.id,
        kind: "guild",
        name: "Slashy",
        visibility: "invite-only",
      },
    });
    await seedAudit(game.id, group.id, { action: "group.created" });
    const res = await listAudit(encodeURIComponent(game.id), encodeURIComponent(group.id));
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAuditPage;
    expect(body.items).toHaveLength(1);
  });
});
