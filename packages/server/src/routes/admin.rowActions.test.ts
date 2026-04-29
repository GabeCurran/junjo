import { type Prisma, PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire types mirror `WireAdminGroupMember` and the new
// `WireAdminMemberPermissionOverride` from `routes/admin.ts`. The dashboard
// owns its own copy in `lib/admin.ts`; tests assert against this shape so a
// drift on the route side surfaces as a typed test failure.
type WireAdminMemberRole = {
  id: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
};

type WireAdminGroupMember = {
  id: string;
  groupId: string;
  externalUserId: string;
  junjoUserId: string;
  status: string;
  metadata: Record<string, unknown>;
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: string;
  leftAt: string | null;
  roles: WireAdminMemberRole[];
};

type WireAdminMemberPermissionOverride = {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  setAt: string;
  setBy: string | null;
};

// Shared seed helper: creates a Game, a Group, and one member with a known
// external user id, returning everything callers need to invoke the
// row-action endpoints. The fixture mirrors the existing 11.5a admin test
// shape but is local to this file so the row-action tests can run
// independently of the read-side describe blocks.
async function seedGroupWithMember(
  prisma: PrismaClient,
  gameName: string,
  groupName: string,
  externalUserId: string,
  options: {
    status?: "active" | "left" | "kicked" | "invited";
    notesPublic?: string;
    notesPrivate?: string;
    metadata?: Record<string, unknown>;
    softDeletedGroup?: boolean;
  } = {},
) {
  const game = await createGame(gameName, prisma);
  const group = await prisma.group.create({
    data: {
      gameId: game.id,
      kind: "guild",
      name: groupName,
      visibility: "invite-only",
      softDeletedAt: options.softDeletedGroup ? new Date() : null,
    },
  });
  const user = await prisma.junjoUser.create({ data: {} });
  await prisma.externalIdentity.create({
    data: { gameId: game.id, junjoUserId: user.id, externalUserId },
  });
  const member = await prisma.groupMember.create({
    data: {
      groupId: group.id,
      junjoUserId: user.id,
      status: options.status ?? "active",
      notesPublic: options.notesPublic ?? null,
      notesPrivate: options.notesPrivate ?? null,
      metadata: (options.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
  return {
    gameId: game.id,
    groupId: group.id,
    junjoUserId: user.id,
    externalUserId,
    memberId: member.id,
  };
}

describe.skipIf(!TEST_DATABASE_URL)(
  "POST /v1/admin/games/:gameId/groups/:groupId/members/:userId/kick",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function kickFetch(
      gameId: string,
      groupId: string,
      userId: string,
      body: unknown = undefined,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      const init: RequestInit & { headers: Record<string, string> } = {
        method: "POST",
        headers: { authorization: header },
      };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
      }
      return app.request(
        `/v1/admin/games/${gameId}/groups/${groupId}/members/${userId}/kick`,
        init,
      );
    }

    it("kicks an active member, stamps leftAt, and returns the post-state row", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_alice");
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        reason: "broke the rules",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroupMember;
      expect(body.id).toBe(seed.memberId);
      expect(body.status).toBe("kicked");
      expect(body.externalUserId).toBe("user_alice");
      expect(body.junjoUserId).toBe(seed.junjoUserId);
      expect(body.leftAt).not.toBeNull();
      expect(body.roles).toEqual([]);

      const stored = await prisma.groupMember.findUnique({ where: { id: seed.memberId } });
      expect(stored?.status).toBe("kicked");
      expect(stored?.leftAt).toBeInstanceOf(Date);

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.kicked" },
      });
      expect(audit).not.toBeNull();
      expect(audit?.actorUserId).toBeNull();
      expect(audit?.targetId).toBe("user_alice");
      const payload = audit?.payload as { memberId: string; reason: string | null };
      expect(payload.memberId).toBe(seed.memberId);
      expect(payload.reason).toBe("broke the rules");
    });

    it("accepts a missing body and stores reason as null", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId);
      expect(res.status).toBe(200);
      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.kicked" },
      });
      const payload = audit?.payload as { reason: string | null };
      expect(payload.reason).toBeNull();
    });

    it("accepts an empty object body and stores reason as null", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId, {});
      expect(res.status).toBe(200);
      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.kicked" },
      });
      const payload = audit?.payload as { reason: string | null };
      expect(payload.reason).toBeNull();
    });

    it("is idempotent on already-kicked members (no audit entry, leftAt unchanged)", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", { status: "kicked" });
      const before = await prisma.groupMember.findUnique({ where: { id: seed.memberId } });
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId, { reason: "x" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroupMember;
      expect(body.status).toBe("kicked");
      const after = await prisma.groupMember.findUnique({ where: { id: seed.memberId } });
      expect(after?.leftAt?.getTime()).toBe(before?.leftAt?.getTime());
      const audits = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "member.kicked" },
      });
      expect(audits).toBe(0);
    });

    it("is idempotent on left members (no transition, no audit)", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", { status: "left" });
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId, {});
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroupMember;
      expect(body.status).toBe("left");
      const audits = await prisma.auditEntry.count({ where: { groupId: seed.groupId } });
      expect(audits).toBe(0);
    });

    it("returns 404 when the group does not exist", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await kickFetch(game.id, "missing-group", "user_a", {});
      expect(res.status).toBe(404);
    });

    it("returns 404 when the group is soft-deleted", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", {
        softDeletedGroup: true,
      });
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId, {});
      expect(res.status).toBe(404);
    });

    it("returns 404 when the group belongs to a different game (cross-game)", async () => {
      const a = await createGame("Alpha", prisma);
      const seed = await seedGroupWithMember(prisma, "Beta", "g1", "user_a");
      const res = await kickFetch(a.id, seed.groupId, seed.externalUserId, {});
      expect(res.status).toBe(404);
    });

    it("returns 404 when no ExternalIdentity exists for the user", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await prisma.group.create({
        data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
      });
      const res = await kickFetch(game.id, group.id, "no_such_user", {});
      expect(res.status).toBe(404);
    });

    it("returns 404 when the user has no GroupMember row in this group", async () => {
      const game = await createGame("Alpha", prisma);
      const group = await prisma.group.create({
        data: { gameId: game.id, kind: "guild", name: "g1", visibility: "invite-only" },
      });
      const u = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId: game.id, junjoUserId: u.id, externalUserId: "user_a" },
      });
      const res = await kickFetch(game.id, group.id, "user_a", {});
      expect(res.status).toBe(404);
    });

    it("rejects reason longer than 500 chars with 400", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await kickFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        reason: "x".repeat(501),
      });
      expect(res.status).toBe(400);
    });

    it("URL-decodes path-encoded user ids", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user with spaces");
      const encoded = encodeURIComponent(seed.externalUserId);
      const res = await kickFetch(seed.gameId, seed.groupId, encoded, {});
      expect(res.status).toBe(200);
      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.kicked" },
      });
      expect(audit?.targetId).toBe("user with spaces");
    });

    it("rejects requests with no Authorization header", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/members/${seed.externalUserId}/kick`,
        { method: "POST" },
      );
      expect(res.status).toBe(401);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)(
  "PATCH /v1/admin/games/:gameId/groups/:groupId/members/:userId",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function patchFetch(
      gameId: string,
      groupId: string,
      userId: string,
      body: unknown,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      return app.request(`/v1/admin/games/${gameId}/groups/${groupId}/members/${userId}`, {
        method: "PATCH",
        headers: { authorization: header, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("updates notesPublic only with audit entry containing only changed field", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        notesPublic: "Welcome!",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroupMember;
      expect(body.notesPublic).toBe("Welcome!");
      expect(body.notesPrivate).toBeNull();

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.notes.updated" },
      });
      expect(audit).not.toBeNull();
      const payload = audit?.payload as {
        before: Record<string, unknown>;
        after: Record<string, unknown>;
      };
      expect(payload.before).toEqual({ notesPublic: null });
      expect(payload.after).toEqual({ notesPublic: "Welcome!" });
    });

    it("clears notesPublic when supplied as null", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", {
        notesPublic: "old",
      });
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        notesPublic: null,
      });
      expect(res.status).toBe(200);
      const stored = await prisma.groupMember.findUnique({ where: { id: seed.memberId } });
      expect(stored?.notesPublic).toBeNull();
    });

    it("updates metadata wholesale and writes a metadata audit entry", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", {
        metadata: { old: "value" },
      });
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        metadata: { new: "value" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminGroupMember;
      expect(body.metadata).toEqual({ new: "value" });

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "member.metadata.updated" },
      });
      const payload = audit?.payload as {
        before: { metadata: Record<string, unknown> };
        after: { metadata: Record<string, unknown> };
      };
      expect(payload.before.metadata).toEqual({ old: "value" });
      expect(payload.after.metadata).toEqual({ new: "value" });
    });

    it("writes a metadata audit even when the supplied metadata equals the stored value", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", {
        metadata: { same: "value" },
      });
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        metadata: { same: "value" },
      });
      expect(res.status).toBe(200);
      const audits = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "member.metadata.updated" },
      });
      expect(audits).toBe(1);
    });

    it("writes both audit entries when metadata and notes change in one PATCH", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        metadata: { tier: "vip" },
        notesPrivate: "Officer note",
      });
      expect(res.status).toBe(200);
      const meta = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "member.metadata.updated" },
      });
      const notes = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "member.notes.updated" },
      });
      expect(meta).toBe(1);
      expect(notes).toBe(1);
    });

    it("writes no audit entries on a fully no-op notes PATCH", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", {
        notesPublic: "same",
      });
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        notesPublic: "same",
      });
      expect(res.status).toBe(200);
      const audits = await prisma.auditEntry.count({ where: { groupId: seed.groupId } });
      expect(audits).toBe(0);
    });

    it("updates members in any status (terminal lifecycle states are editable)", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a", {
        status: "kicked",
      });
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        notesPrivate: "post-kick note",
      });
      expect(res.status).toBe(200);
      const stored = await prisma.groupMember.findUnique({ where: { id: seed.memberId } });
      expect(stored?.notesPrivate).toBe("post-kick note");
      expect(stored?.status).toBe("kicked");
    });

    it("rejects empty body with 400", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {});
      expect(res.status).toBe(400);
    });

    it("rejects notesPublic over 5000 chars with 400", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        notesPublic: "x".repeat(5001),
      });
      expect(res.status).toBe(400);
    });

    it("returns 404 when the group does not exist / soft-deleted / cross-game", async () => {
      const game = await createGame("Alpha", prisma);
      const r1 = await patchFetch(game.id, "missing", "user_a", { notesPublic: "x" });
      expect(r1.status).toBe(404);

      const seed = await seedGroupWithMember(prisma, "Beta", "g2", "user_a", {
        softDeletedGroup: true,
      });
      const r2 = await patchFetch(seed.gameId, seed.groupId, seed.externalUserId, {
        notesPublic: "x",
      });
      expect(r2.status).toBe(404);

      const seed3 = await seedGroupWithMember(prisma, "Gamma", "g3", "user_a");
      const r3 = await patchFetch(game.id, seed3.groupId, seed3.externalUserId, {
        notesPublic: "x",
      });
      expect(r3.status).toBe(404);
    });

    it("rejects requests with no Authorization header", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/members/${seed.externalUserId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ notesPublic: "x" }),
        },
      );
      expect(res.status).toBe(401);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)(
  "POST /v1/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function setFetch(
      gameId: string,
      groupId: string,
      userId: string,
      permission: string,
      body: unknown,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      return app.request(
        `/v1/admin/games/${gameId}/groups/${groupId}/members/${userId}/permissions/${permission}`,
        {
          method: "POST",
          headers: { authorization: header, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
    }

    it("creates a grant override and writes audit + auto-registers PermissionDef", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await setFetch(
        seed.gameId,
        seed.groupId,
        seed.externalUserId,
        "guild.invite_member",
        { grant: true },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminMemberPermissionOverride;
      expect(body.groupId).toBe(seed.groupId);
      expect(body.userId).toBe("user_a");
      expect(body.permission).toBe("guild.invite_member");
      expect(body.grant).toBe(true);
      expect(body.setBy).toBeNull();
      expect(body.setAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: seed.memberId,
            permissionKey: "guild.invite_member",
          },
        },
      });
      expect(stored?.grant).toBe(true);

      const def = await prisma.permissionDef.findUnique({
        where: { gameId_key: { gameId: seed.gameId, key: "guild.invite_member" } },
      });
      expect(def).not.toBeNull();

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "permission.override.set" },
      });
      const payload = audit?.payload as {
        memberId: string;
        permission: string;
        grant: boolean;
        before?: { grant: boolean };
      };
      expect(payload.memberId).toBe(seed.memberId);
      expect(payload.permission).toBe("guild.invite_member");
      expect(payload.grant).toBe(true);
      expect(payload.before).toBeUndefined();
    });

    it("flips an existing override and writes audit with before", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "raid.start", {
        grant: true,
      });
      const auditsBefore = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "permission.override.set" },
      });
      const res = await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "raid.start", {
        grant: false,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminMemberPermissionOverride;
      expect(body.grant).toBe(false);

      const audits = await prisma.auditEntry.findMany({
        where: { groupId: seed.groupId, action: "permission.override.set" },
        orderBy: { createdAt: "asc" },
      });
      expect(audits.length).toBe(auditsBefore + 1);
      const lastPayload = audits[audits.length - 1]?.payload as {
        before?: { grant: boolean };
        grant: boolean;
      };
      expect(lastPayload.before).toEqual({ grant: true });
      expect(lastPayload.grant).toBe(false);

      const defCount = await prisma.permissionDef.count({
        where: { gameId: seed.gameId, key: "raid.start" },
      });
      expect(defCount).toBe(1);
    });

    it("is idempotent on matching grant (no audit, no setAt bump)", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "vault.withdraw", {
        grant: true,
      });
      const firstStored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: seed.memberId,
            permissionKey: "vault.withdraw",
          },
        },
      });
      const firstAuditCount = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "permission.override.set" },
      });
      const res = await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "vault.withdraw", {
        grant: true,
      });
      expect(res.status).toBe(200);
      const secondStored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: seed.memberId,
            permissionKey: "vault.withdraw",
          },
        },
      });
      expect(secondStored?.setAt.getTime()).toBe(firstStored?.setAt.getTime());
      const secondAuditCount = await prisma.auditEntry.count({
        where: { groupId: seed.groupId, action: "permission.override.set" },
      });
      expect(secondAuditCount).toBe(firstAuditCount);
    });

    it("rejects empty permission key path with non-2xx", async () => {
      // The trailing-slash URL does not match the typed route's
      // `:permission` placeholder, so Hono falls through to the per-game
      // `apiKeyMiddleware` registered on `*`, which 401s the request
      // because no game-API-key header is present. The contract for the
      // dashboard is "do not POST with an empty permission key"; the
      // exact non-2xx code is incidental.
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/members/${seed.externalUserId}/permissions/`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${ADMIN_TOKEN}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ grant: true }),
        },
      );
      expect(res.status).not.toBe(200);
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it("rejects permission key over 128 chars with 400", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await setFetch(
        seed.gameId,
        seed.groupId,
        seed.externalUserId,
        encodeURIComponent("x".repeat(129)),
        { grant: true },
      );
      expect(res.status).toBe(400);
    });

    it("rejects missing or non-boolean grant with 400", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const r1 = await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "x", {});
      expect(r1.status).toBe(400);
      const r2 = await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "x", {
        grant: "yes",
      });
      expect(r2.status).toBe(400);
    });

    it("returns 404 when the group does not exist / soft-deleted / cross-game / no member", async () => {
      const game = await createGame("Alpha", prisma);
      const r1 = await setFetch(game.id, "missing", "user_a", "x", { grant: true });
      expect(r1.status).toBe(404);

      const seed = await seedGroupWithMember(prisma, "Beta", "g1", "user_a", {
        softDeletedGroup: true,
      });
      const r2 = await setFetch(seed.gameId, seed.groupId, seed.externalUserId, "x", {
        grant: true,
      });
      expect(r2.status).toBe(404);

      const r3 = await setFetch(game.id, seed.groupId, seed.externalUserId, "x", { grant: true });
      expect(r3.status).toBe(404);

      const defs = await prisma.permissionDef.count();
      expect(defs).toBe(0);
    });

    it("URL-decodes permission paths with namespacing dots and dashes", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await setFetch(
        seed.gameId,
        seed.groupId,
        seed.externalUserId,
        "guild.invite-link",
        { grant: true },
      );
      expect(res.status).toBe(200);
      const stored = await prisma.memberPermissionOverride.findFirst({
        where: { groupMemberId: seed.memberId, permissionKey: "guild.invite-link" },
      });
      expect(stored).not.toBeNull();
    });

    it("rejects requests with no Authorization header", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/members/${seed.externalUserId}/permissions/x`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: true }),
        },
      );
      expect(res.status).toBe(401);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)(
  "DELETE /v1/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function deleteFetch(
      gameId: string,
      groupId: string,
      userId: string,
      permission: string,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      return app.request(
        `/v1/admin/games/${gameId}/groups/${groupId}/members/${userId}/permissions/${permission}`,
        { method: "DELETE", headers: { authorization: header } },
      );
    }

    async function seedOverride(
      seedRef: { gameId: string; memberId: string },
      permission: string,
      grant: boolean,
    ) {
      await prisma.permissionDef.upsert({
        where: { gameId_key: { gameId: seedRef.gameId, key: permission } },
        create: { gameId: seedRef.gameId, key: permission },
        update: {},
      });
      await prisma.memberPermissionOverride.create({
        data: {
          groupMemberId: seedRef.memberId,
          permissionKey: permission,
          grant,
        },
      });
    }

    it("deletes an existing override, writes audit, preserves PermissionDef", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      await seedOverride(seed, "guild.kick", true);
      const res = await deleteFetch(seed.gameId, seed.groupId, seed.externalUserId, "guild.kick");
      expect(res.status).toBe(204);

      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: seed.memberId,
            permissionKey: "guild.kick",
          },
        },
      });
      expect(stored).toBeNull();

      const def = await prisma.permissionDef.findUnique({
        where: { gameId_key: { gameId: seed.gameId, key: "guild.kick" } },
      });
      expect(def).not.toBeNull();

      const audit = await prisma.auditEntry.findFirst({
        where: { groupId: seed.groupId, action: "permission.override.cleared" },
      });
      const payload = audit?.payload as {
        memberId: string;
        permission: string;
        grant: boolean;
      };
      expect(payload.permission).toBe("guild.kick");
      expect(payload.grant).toBe(true);
    });

    it("is a no-op (204, no audit) when the override does not exist", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await deleteFetch(seed.gameId, seed.groupId, seed.externalUserId, "missing.key");
      expect(res.status).toBe(204);
      const audits = await prisma.auditEntry.count({ where: { groupId: seed.groupId } });
      expect(audits).toBe(0);
    });

    it("preserves other overrides on the same member", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      await seedOverride(seed, "perm.a", true);
      await seedOverride(seed, "perm.b", false);
      const res = await deleteFetch(seed.gameId, seed.groupId, seed.externalUserId, "perm.a");
      expect(res.status).toBe(204);
      const remaining = await prisma.memberPermissionOverride.findMany({
        where: { groupMemberId: seed.memberId },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.permissionKey).toBe("perm.b");
    });

    it("returns 404 when the group does not exist / soft-deleted / cross-game / no member", async () => {
      const game = await createGame("Alpha", prisma);
      const r1 = await deleteFetch(game.id, "missing", "user_a", "x");
      expect(r1.status).toBe(404);

      const seed = await seedGroupWithMember(prisma, "Beta", "g1", "user_a", {
        softDeletedGroup: true,
      });
      const r2 = await deleteFetch(seed.gameId, seed.groupId, seed.externalUserId, "x");
      expect(r2.status).toBe(404);

      const r3 = await deleteFetch(game.id, seed.groupId, seed.externalUserId, "x");
      expect(r3.status).toBe(404);
    });

    it("rejects requests with no Authorization header", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/members/${seed.externalUserId}/permissions/x`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(401);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)(
  "GET /v1/admin/games/:gameId/groups/:groupId/members/:userId/permissions",
  () => {
    let prisma: PrismaClient;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
      );
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function listFetch(
      gameId: string,
      groupId: string,
      userId: string,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      return app.request(
        `/v1/admin/games/${gameId}/groups/${groupId}/members/${userId}/permissions`,
        { method: "GET", headers: { authorization: header } },
      );
    }

    it("returns an empty array when the member has no overrides", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await listFetch(seed.gameId, seed.groupId, seed.externalUserId);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminMemberPermissionOverride[];
      expect(body).toEqual([]);
    });

    it("returns overrides sorted by permissionKey ascending", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      for (const key of ["zeta", "alpha", "mu"]) {
        await prisma.memberPermissionOverride.create({
          data: { groupMemberId: seed.memberId, permissionKey: key, grant: true },
        });
      }
      const res = await listFetch(seed.gameId, seed.groupId, seed.externalUserId);
      const body = (await res.json()) as WireAdminMemberPermissionOverride[];
      expect(body.map((o) => o.permission)).toEqual(["alpha", "mu", "zeta"]);
      for (const o of body) {
        expect(o.userId).toBe("user_a");
        expect(o.groupId).toBe(seed.groupId);
        expect(o.setBy).toBeNull();
      }
    });

    it("isolates overrides to a single member", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const u2 = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId: seed.gameId, junjoUserId: u2.id, externalUserId: "user_b" },
      });
      const m2 = await prisma.groupMember.create({
        data: { groupId: seed.groupId, junjoUserId: u2.id, status: "active" },
      });
      await prisma.memberPermissionOverride.create({
        data: { groupMemberId: m2.id, permissionKey: "x", grant: true },
      });
      await prisma.memberPermissionOverride.create({
        data: { groupMemberId: seed.memberId, permissionKey: "y", grant: false },
      });
      const res = await listFetch(seed.gameId, seed.groupId, seed.externalUserId);
      const body = (await res.json()) as WireAdminMemberPermissionOverride[];
      expect(body).toHaveLength(1);
      expect(body[0]?.permission).toBe("y");
    });

    it("returns 404 when the group does not exist / soft-deleted / cross-game / no member", async () => {
      const game = await createGame("Alpha", prisma);
      const r1 = await listFetch(game.id, "missing", "user_a");
      expect(r1.status).toBe(404);

      const seed = await seedGroupWithMember(prisma, "Beta", "g1", "user_a", {
        softDeletedGroup: true,
      });
      const r2 = await listFetch(seed.gameId, seed.groupId, seed.externalUserId);
      expect(r2.status).toBe(404);

      const r3 = await listFetch(game.id, seed.groupId, seed.externalUserId);
      expect(r3.status).toBe(404);
    });

    it("rejects requests with no Authorization header", async () => {
      const seed = await seedGroupWithMember(prisma, "Alpha", "g1", "user_a");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/groups/${seed.groupId}/members/${seed.externalUserId}/permissions`,
        { method: "GET" },
      );
      expect(res.status).toBe(401);
    });
  },
);
