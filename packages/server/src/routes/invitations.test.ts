import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/invitations/:code", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(softDeletedAt: Date | null = null) {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt,
      },
    });
  }

  async function seedInvite(
    groupId: string,
    code: string,
    overrides: Record<string, unknown> = {},
  ) {
    return prisma.invitation.create({
      data: { groupId, code, targetUserId: null, ...overrides },
    });
  }

  it("returns the invitation by code without requiring an API key", async () => {
    const group = await seedGroup();
    const inv = await seedInvite(group.id, "abcd1234abcd1234", {
      roleId: "role_recruit",
      targetUserId: "user_alice",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
    });

    const res = await app.request("/v1/invitations/abcd1234abcd1234", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: inv.id,
      groupId: group.id,
      code: "abcd1234abcd1234",
      roleId: "role_recruit",
      targetUserId: "user_alice",
      createdBy: null,
      usedAt: null,
      usedBy: null,
    });
    expect(body.expiresAt).toBe("2026-12-01T00:00:00.000Z");
    expect(typeof body.createdAt).toBe("string");
  });

  it("returns 404 when the invitation does not exist", async () => {
    const res = await app.request("/v1/invitations/missing__________", { method: "GET" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the invitation's group is soft-deleted", async () => {
    const group = await seedGroup(new Date());
    await seedInvite(group.id, "deletedgroupcode");

    const res = await app.request("/v1/invitations/deletedgroupcode", { method: "GET" });
    expect(res.status).toBe(404);
  });

  it("returns the invitation even when an unrelated API key is presented", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "withauthcode____");
    const otherGame = await createGame("Other Game", prisma);
    const otherKey = await createApiKey(otherGame.id, prisma);

    const res = await app.request("/v1/invitations/withauthcode____", {
      method: "GET",
      headers: { authorization: `Bearer ${otherKey.raw.full}` },
    });
    expect(res.status).toBe(200);
  });

  it("URL-decodes the path parameter", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "weird/code");

    const res = await app.request("/v1/invitations/weird%2Fcode", { method: "GET" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("weird/code");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/invitations/:code", () => {
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
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedGroup(overrides: Partial<{ gameId: string }> = {}) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
      },
    });
  }

  async function seedInvite(
    groupId: string,
    code: string,
    overrides: Record<string, unknown> = {},
  ) {
    return prisma.invitation.create({
      data: { groupId, code, targetUserId: null, ...overrides },
    });
  }

  it("deletes an unused invitation and returns 204", async () => {
    const group = await seedGroup();
    const inv = await seedInvite(group.id, "unusedcode______");

    const res = await app.request("/v1/invitations/unusedcode______", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(204);
    const stored = await prisma.invitation.findUnique({ where: { id: inv.id } });
    expect(stored).toBeNull();
  });

  it("returns 404 on a second revoke (the row is gone)", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "revokemetwice___");
    const first = await app.request("/v1/invitations/revokemetwice___", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(first.status).toBe(204);
    const second = await app.request("/v1/invitations/revokemetwice___", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(second.status).toBe(404);
  });

  it("is idempotent on already-used invitations (preserves the row, returns 204)", async () => {
    const group = await seedGroup();
    const inv = await seedInvite(group.id, "usedcode________", {
      usedAt: new Date(),
      usedByUserId: "user_alice",
    });

    const first = await app.request("/v1/invitations/usedcode________", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(first.status).toBe(204);
    const second = await app.request("/v1/invitations/usedcode________", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(second.status).toBe(204);

    const stored = await prisma.invitation.findUnique({ where: { id: inv.id } });
    expect(stored).not.toBeNull();
    expect(stored?.usedAt).not.toBeNull();
  });

  it("returns 404 when the invitation does not exist", async () => {
    const res = await app.request("/v1/invitations/nosuchcode______", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the invitation belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await seedGroup({ gameId: otherGame.id });
    await seedInvite(otherGroup.id, "crossgamecode___");

    const res = await app.request("/v1/invitations/crossgamecode___", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "noauthcode______");
    const res = await app.request("/v1/invitations/noauthcode______", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the path parameter", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "weird/code");

    const res = await app.request("/v1/invitations/weird%2Fcode", {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(204);
  });
});
