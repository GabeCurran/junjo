import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/invitations/:code", () => {
  let app: Hono;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
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
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
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

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/invitations/:code/accept", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedGroup(overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {}) {
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

  async function seedInvite(
    groupId: string,
    code: string,
    overrides: Record<string, unknown> = {},
  ) {
    return prisma.invitation.create({
      data: { groupId, code, targetUserId: null, ...overrides },
    });
  }

  function postAccept(code: string, body: unknown, header = authHeader) {
    return app.request(`/v1/invitations/${code}/accept`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a member, marks the invitation used, and writes a member.joined audit entry", async () => {
    const group = await seedGroup();
    const inv = await seedInvite(group.id, "openinvitecode__");

    const res = await postAccept("openinvitecode__", { userId: "user_alice" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      groupId: group.id,
      userId: "user_alice",
      status: "active",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.joinedAt).toBe("string");

    const ext = await prisma.externalIdentity.findUnique({
      where: { gameId_externalUserId: { gameId, externalUserId: "user_alice" } },
    });
    expect(ext).not.toBeNull();
    const member = await prisma.groupMember.findUnique({
      where: { id: body.id as string },
    });
    expect(member?.junjoUserId).toBe(ext?.junjoUserId);
    expect(member?.status).toBe("active");

    const updatedInv = await prisma.invitation.findUnique({ where: { id: inv.id } });
    expect(updatedInv?.usedAt).not.toBeNull();
    expect(updatedInv?.usedByUserId).toBe(ext?.junjoUserId);

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.action).toBe("member.joined");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBe(ext?.junjoUserId);
    expect(entry.payload).toMatchObject({
      memberId: body.id,
      invitationId: inv.id,
      code: "openinvitecode__",
    });
  });

  it("reuses an existing JunjoUser when ExternalIdentity already exists", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "preregisteredcd_");
    const existingUser = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: existingUser.id, externalUserId: "user_bob" },
    });

    const res = await postAccept("preregisteredcd_", { userId: "user_bob" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    const member = await prisma.groupMember.findUnique({ where: { id: body.id } });
    expect(member?.junjoUserId).toBe(existingUser.id);
    const allUsers = await prisma.junjoUser.count();
    expect(allUsers).toBe(1);
  });

  it("enforces the targetUserId on direct invitations and lets the right user accept", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "directcode______", { targetUserId: "user_alice" });

    const wrong = await postAccept("directcode______", { userId: "user_bob" });
    expect(wrong.status).toBe(403);
    const wrongBody = (await wrong.json()) as { code: string };
    expect(wrongBody.code).toBe("permission_denied");

    const ok = await postAccept("directcode______", { userId: "user_alice" });
    expect(ok.status).toBe(201);
  });

  it("returns 410 invitation_used when the invitation is already used", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "alreadyusedcode_", {
      usedAt: new Date(),
      usedByUserId: "user_someone",
    });

    const res = await postAccept("alreadyusedcode_", { userId: "user_alice" });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invitation_used");
  });

  it("returns 410 invitation_expired when the invitation expired", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "expiredcode_____", {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await postAccept("expiredcode_____", { userId: "user_alice" });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invitation_expired");
  });

  it("returns 409 already_member when the user is already in the group", async () => {
    const group = await seedGroup();
    const existingUser = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: existingUser.id, externalUserId: "user_alice" },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: existingUser.id, status: "active" },
    });
    await seedInvite(group.id, "secondinvitecd__");

    const res = await postAccept("secondinvitecd__", { userId: "user_alice" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("already_member");

    const stored = await prisma.invitation.findUnique({
      where: { code: "secondinvitecd__" },
    });
    expect(stored?.usedAt).toBeNull();
  });

  it.each(["left", "kicked"] as const)(
    "reactivates a %s member when they accept an invite",
    async (status) => {
      const group = await seedGroup();
      const existingUser = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: existingUser.id, externalUserId: "user_alice" },
      });
      const existingMember = await prisma.groupMember.create({
        data: {
          groupId: group.id,
          junjoUserId: existingUser.id,
          status,
          leftAt: new Date(),
        },
      });
      const code = status === "left" ? "leftinvitecode__" : "kickedinvite____";
      const inv = await seedInvite(group.id, code);

      const res = await postAccept(code, { userId: "user_alice" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string; status: string };
      expect(body.id).toBe(existingMember.id);
      expect(body.status).toBe("active");

      const storedMember = await prisma.groupMember.findUnique({
        where: { id: existingMember.id },
      });
      expect(storedMember?.status).toBe("active");
      expect(storedMember?.leftAt).toBeNull();

      const storedInvite = await prisma.invitation.findUnique({ where: { id: inv.id } });
      expect(storedInvite?.usedAt).not.toBeNull();
      expect(storedInvite?.usedByUserId).toBe(existingUser.id);
    },
  );

  it("returns 404 when the invitation does not exist", async () => {
    const res = await postAccept("nosuchcode______", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the invitation belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await seedGroup({ gameId: otherGame.id });
    await seedInvite(otherGroup.id, "crossgamecode___");

    const res = await postAccept("crossgamecode___", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the invitation's group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedInvite(group.id, "softdeletedcode_");

    const res = await postAccept("softdeletedcode_", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("rejects a body missing userId", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "missingbodycode_");

    const res = await postAccept("missingbodycode_", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "noauthcode______");
    const res = await app.request("/v1/invitations/noauthcode______/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_alice" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/invitations/:code/decline", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Invitation", "AuditEntry", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedGroup(overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {}) {
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

  async function seedInvite(
    groupId: string,
    code: string,
    overrides: Record<string, unknown> = {},
  ) {
    return prisma.invitation.create({
      data: { groupId, code, targetUserId: null, ...overrides },
    });
  }

  function postDecline(code: string, body: unknown = undefined, header = authHeader) {
    return app.request(`/v1/invitations/${code}/decline`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("marks the invitation used without creating a member or audit entry", async () => {
    const group = await seedGroup();
    const inv = await seedInvite(group.id, "declineme_______");

    const res = await postDecline("declineme_______", { userId: "user_alice" });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-length") ?? "0").toBe("0");

    const updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
    expect(updated?.usedAt).not.toBeNull();
    const ext = await prisma.externalIdentity.findUnique({
      where: { gameId_externalUserId: { gameId, externalUserId: "user_alice" } },
    });
    expect(updated?.usedByUserId).toBe(ext?.junjoUserId);

    const members = await prisma.groupMember.count();
    expect(members).toBe(0);
    const audit = await prisma.auditEntry.count();
    expect(audit).toBe(0);
  });

  it("accepts an empty body and stores usedByUserId as null", async () => {
    const group = await seedGroup();
    const inv = await seedInvite(group.id, "anonymousdecline");

    const res = await postDecline("anonymousdecline");
    expect(res.status).toBe(204);

    const updated = await prisma.invitation.findUnique({ where: { id: inv.id } });
    expect(updated?.usedAt).not.toBeNull();
    expect(updated?.usedByUserId).toBeNull();

    const usersAfter = await prisma.junjoUser.count();
    expect(usersAfter).toBe(0);
  });

  it("enforces targetUserId on direct invites when a userId is supplied", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "directdeclinecd_", { targetUserId: "user_alice" });

    const wrong = await postDecline("directdeclinecd_", { userId: "user_bob" });
    expect(wrong.status).toBe(403);
    const wrongBody = (await wrong.json()) as { code: string };
    expect(wrongBody.code).toBe("permission_denied");

    const ok = await postDecline("directdeclinecd_", { userId: "user_alice" });
    expect(ok.status).toBe(204);
  });

  it("returns 410 invitation_used when the invitation is already used", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "doubledecline___", { usedAt: new Date() });

    const res = await postDecline("doubledecline___", { userId: "user_alice" });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invitation_used");
  });

  it("returns 410 invitation_expired when the invitation expired", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "expireddecline__", {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await postDecline("expireddecline__", { userId: "user_alice" });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("invitation_expired");
  });

  it("returns 404 when the invitation does not exist", async () => {
    const res = await postDecline("nosuchdecline___", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the invitation belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherGroup = await seedGroup({ gameId: otherGame.id });
    await seedInvite(otherGroup.id, "crossgamedecline");

    const res = await postDecline("crossgamedecline", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the invitation's group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedInvite(group.id, "softdeletedclipd");

    const res = await postDecline("softdeletedclipd", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, "noauthdeclinecd_");
    const res = await app.request("/v1/invitations/noauthdeclinecd_/decline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_alice" }),
    });
    expect(res.status).toBe(401);
  });
});
