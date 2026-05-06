import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/audit", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
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

  function listAudit(groupId: string, query = "", header: string = authHeader) {
    const path = query ? `/v1/groups/${groupId}/audit?${query}` : `/v1/groups/${groupId}/audit`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  it("returns an empty page when no audit entries exist", async () => {
    const group = await seedGroup();
    const res = await listAudit(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns entries newest first with the wire format populated", async () => {
    const group = await seedGroup();
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");
    await seedAudit(group.id, { action: "group.created", createdAt: t0 });
    await seedAudit(group.id, {
      action: "group.updated",
      createdAt: t1,
      payload: { before: { name: "old" }, after: { name: "new" } },
    });
    await seedAudit(group.id, {
      action: "member.invited",
      createdAt: t2,
      targetId: "user_alice",
    });

    const res = await listAudit(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        groupId: string;
        action: string;
        actorUserId: string | null;
        targetId: string | null;
        payload: Record<string, unknown>;
        createdAt: string;
      }>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.action)).toEqual([
      "member.invited",
      "group.updated",
      "group.created",
    ]);
    const [first, second] = body.items;
    expect(first?.groupId).toBe(group.id);
    expect(first?.targetId).toBe("user_alice");
    expect(first?.actorUserId).toBeNull();
    expect(first?.payload).toEqual({});
    expect(new Date(first?.createdAt as string).toISOString()).toBe(t2.toISOString());
    expect(second?.payload).toEqual({ before: { name: "old" }, after: { name: "new" } });
    expect(body.nextCursor).toBeNull();
  });

  it("filters out entries belonging to a different group", async () => {
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    await seedAudit(groupA.id, { action: "group.created" });
    await seedAudit(groupB.id, { action: "group.created" });
    await seedAudit(groupB.id, { action: "group.updated" });

    const res = await listAudit(groupA.id);
    const body = (await res.json()) as { items: Array<{ groupId: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.groupId).toBe(groupA.id);
  });

  it("filters by `before` (exclusive timestamp bound)", async () => {
    const group = await seedGroup();
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    await seedAudit(group.id, { action: "group.created", createdAt: tA });
    await seedAudit(group.id, { action: "group.updated", createdAt: tB });
    await seedAudit(group.id, { action: "member.invited", createdAt: tC });

    const res = await listAudit(group.id, `before=${encodeURIComponent(tC.toISOString())}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ action: string }> };
    expect(body.items.map((i) => i.action)).toEqual(["group.updated", "group.created"]);
  });

  it("filters by a single `actions` value", async () => {
    const group = await seedGroup();
    await seedAudit(group.id, { action: "group.created" });
    await seedAudit(group.id, { action: "group.updated" });
    await seedAudit(group.id, { action: "member.invited" });

    const res = await listAudit(group.id, "actions=group.updated");
    const body = (await res.json()) as { items: Array<{ action: string }> };
    expect(body.items.map((i) => i.action)).toEqual(["group.updated"]);
  });

  it("filters by multiple `actions` values (OR semantics)", async () => {
    const group = await seedGroup();
    await seedAudit(group.id, { action: "group.created" });
    await seedAudit(group.id, { action: "group.updated" });
    await seedAudit(group.id, { action: "member.invited" });
    await seedAudit(group.id, { action: "role.created" });

    const res = await listAudit(group.id, "actions=group.created&actions=role.created");
    const body = (await res.json()) as { items: Array<{ action: string }> };
    const sorted = body.items.map((i) => i.action).sort();
    expect(sorted).toEqual(["group.created", "role.created"]);
  });

  it("combines `before` and `actions` filters", async () => {
    const group = await seedGroup();
    const tA = new Date("2026-04-01T00:00:00Z");
    const tB = new Date("2026-04-02T00:00:00Z");
    const tC = new Date("2026-04-03T00:00:00Z");
    await seedAudit(group.id, { action: "group.created", createdAt: tA });
    await seedAudit(group.id, { action: "group.updated", createdAt: tB });
    await seedAudit(group.id, { action: "group.updated", createdAt: tC });

    const res = await listAudit(
      group.id,
      `before=${encodeURIComponent(tC.toISOString())}&actions=group.updated`,
    );
    const body = (await res.json()) as { items: Array<{ action: string; createdAt: string }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.action).toBe("group.updated");
    expect(new Date(body.items[0]?.createdAt as string).toISOString()).toBe(tB.toISOString());
  });

  it("paginates via limit + nextCursor (consumer feeds nextCursor back as `before`)", async () => {
    const group = await seedGroup();
    for (let i = 0; i < 5; i++) {
      await seedAudit(group.id, {
        action: "group.updated",
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const first = await listAudit(group.id, "limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ createdAt: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(firstBody.items[1]?.createdAt);

    const second = await listAudit(
      group.id,
      `limit=2&before=${encodeURIComponent(firstBody.nextCursor as string)}`,
    );
    const secondBody = (await second.json()) as {
      items: Array<{ createdAt: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.nextCursor).toBe(secondBody.items[1]?.createdAt);
    expect(secondBody.items.map((i) => i.createdAt)).not.toEqual(
      firstBody.items.map((i) => i.createdAt),
    );

    const third = await listAudit(
      group.id,
      `limit=2&before=${encodeURIComponent(secondBody.nextCursor as string)}`,
    );
    const thirdBody = (await third.json()) as {
      items: Array<{ createdAt: string }>;
      nextCursor: string | null;
    };
    expect(thirdBody.items).toHaveLength(1);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("defaults to limit=50 when no limit is supplied", async () => {
    const group = await seedGroup();
    for (let i = 0; i < 60; i++) {
      await seedAudit(group.id, {
        action: "group.updated",
        createdAt: new Date(2026, 0, 1, 0, 0, i),
      });
    }
    const res = await listAudit(group.id);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it("rejects an out-of-range limit", async () => {
    const group = await seedGroup();
    const res = await listAudit(group.id, "limit=0");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a non-int limit", async () => {
    const group = await seedGroup();
    const res = await listAudit(group.id, "limit=abc");
    expect(res.status).toBe(400);
  });

  it("rejects a malformed `before` value", async () => {
    const group = await seedGroup();
    const res = await listAudit(group.id, "before=not-a-date");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects an unknown `actions` value", async () => {
    const group = await seedGroup();
    const res = await listAudit(group.id, "actions=not.an.action");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listAudit("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedAudit(group.id, { action: "group.created" });
    const res = await listAudit(group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    await seedAudit(group.id, { action: "group.created" });
    const res = await listAudit(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/audit`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});
