import type { GroupId, PermissionGrantedEvent, PermissionRevokedEvent } from "@junjo/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-aabbcc";

// Wire shapes mirror `WireAdminRole` and `WireAdminPermissionDef` from
// `routes/admin.ts`. Tests assert against these so a route-side drift
// surfaces as a typed test failure.
type WireAdminRole = {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  createdAt: string;
};

type WireAdminPermissionDef = {
  key: string;
  description: string | null;
  createdAt: string;
};

async function seedRole(
  prisma: PrismaClient,
  gameName: string,
  groupName: string,
  options: { softDeletedGroup?: boolean } = {},
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
  const role = await prisma.role.create({
    data: { groupId: group.id, name: "Officer", priority: 80 },
  });
  return { gameId: game.id, groupId: group.id, roleId: role.id };
}

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "RolePermission", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

describe.skipIf(!TEST_DATABASE_URL)(
  "POST /v1/admin/games/:gameId/roles/:roleId/permissions",
  () => {
    let prisma: PrismaClient;
    let hub: EventHub;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      hub = new EventHub();
      app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
    });

    beforeEach(async () => {
      hub.clear();
      await prisma.$executeRawUnsafe(TRUNCATE);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    function grantFetch(
      gameId: string,
      roleId: string,
      body: unknown,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      const init: RequestInit & { headers: Record<string, string> } = {
        method: "POST",
        headers: { authorization: header },
      };
      if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = typeof body === "string" ? body : JSON.stringify(body);
      }
      return app.request(`/v1/admin/games/${gameId}/roles/${roleId}/permissions`, init);
    }

    it("creates a RolePermission row, returns the role with the permission attached", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(seed.gameId, seed.roleId, { permission: "guild.invite_member" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminRole;
      expect(body.id).toBe(seed.roleId);
      expect(body.permissions).toEqual(["guild.invite_member"]);

      const stored = await prisma.rolePermission.findUnique({
        where: {
          roleId_permissionKey: {
            roleId: seed.roleId,
            permissionKey: "guild.invite_member",
          },
        },
      });
      expect(stored).not.toBeNull();
    });

    it("auto-registers the permission key into PermissionDef on first sight per game", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const before = await prisma.permissionDef.findMany({ where: { gameId: seed.gameId } });
      expect(before).toHaveLength(0);

      await grantFetch(seed.gameId, seed.roleId, { permission: "guild.invite_member" });

      const after = await prisma.permissionDef.findMany({ where: { gameId: seed.gameId } });
      expect(after).toHaveLength(1);
      expect(after[0]?.key).toBe("guild.invite_member");
    });

    it("does not duplicate the PermissionDef row across grants of the same key in the same game", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const second = await prisma.role.create({
        data: { groupId: seed.groupId, name: "Captain", priority: 50 },
      });

      await grantFetch(seed.gameId, seed.roleId, { permission: "guild.invite_member" });
      await grantFetch(seed.gameId, second.id, { permission: "guild.invite_member" });

      const defs = await prisma.permissionDef.findMany({ where: { gameId: seed.gameId } });
      expect(defs).toHaveLength(1);
    });

    it("writes a permission.granted audit entry per call", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      await grantFetch(seed.gameId, seed.roleId, { permission: "guild.kick_member" });

      const entries = await prisma.auditEntry.findMany({
        where: { groupId: seed.groupId, action: "permission.granted" },
      });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.targetId).toBe(seed.roleId);
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({
        roleId: seed.roleId,
        permission: "guild.kick_member",
      });
    });

    it("dispatches a permission.granted JunjoEvent", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const events: unknown[] = [];
      const unsubscribe = hub.subscribe(seed.groupId as GroupId, (e) => events.push(e));
      try {
        await grantFetch(seed.gameId, seed.roleId, { permission: "guild.invite_member" });
      } finally {
        unsubscribe();
      }
      expect(events).toHaveLength(1);
      const evt = events[0] as PermissionGrantedEvent;
      expect(evt.type).toBe("permission.granted");
      expect(evt.gameId).toBe(seed.gameId);
      expect(evt.groupId).toBe(seed.groupId);
      expect(evt.roleId).toBe(seed.roleId);
      expect(evt.permission).toBe("guild.invite_member");
    });

    it("is idempotent on already-granted permission (no second audit, no extra rows, no second event)", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const events: unknown[] = [];
      const unsubscribe = hub.subscribe(seed.groupId as GroupId, (e) => events.push(e));
      try {
        const first = await grantFetch(seed.gameId, seed.roleId, {
          permission: "guild.invite_member",
        });
        expect(first.status).toBe(200);
        const second = await grantFetch(seed.gameId, seed.roleId, {
          permission: "guild.invite_member",
        });
        expect(second.status).toBe(200);

        const body = (await second.json()) as WireAdminRole;
        expect(body.permissions).toEqual(["guild.invite_member"]);

        const rows = await prisma.rolePermission.findMany({ where: { roleId: seed.roleId } });
        expect(rows).toHaveLength(1);

        const entries = await prisma.auditEntry.findMany({
          where: { action: "permission.granted" },
        });
        expect(entries).toHaveLength(1);
      } finally {
        unsubscribe();
      }
      expect(events).toHaveLength(1);
    });

    it("returns the full permissions list (multiple distinct keys) sorted asc", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      await grantFetch(seed.gameId, seed.roleId, { permission: "guild.kick_member" });
      const res = await grantFetch(seed.gameId, seed.roleId, {
        permission: "guild.invite_member",
      });
      const body = (await res.json()) as WireAdminRole;
      expect(body.permissions).toEqual(["guild.invite_member", "guild.kick_member"]);
    });

    it("invalidates the permission cache for the role's group after grant", async () => {
      const { permissionCache } = await import("../permissionCache.js");
      const seed = await seedRole(prisma, "Alpha", "g1");
      permissionCache.set(seed.gameId, seed.groupId, "ext-user", "guild.invite_member", {
        allowed: true,
        source: "default",
      });
      expect(
        permissionCache.get(seed.gameId, seed.groupId, "ext-user", "guild.invite_member"),
      ).not.toBeNull();

      await grantFetch(seed.gameId, seed.roleId, { permission: "guild.invite_member" });

      expect(
        permissionCache.get(seed.gameId, seed.groupId, "ext-user", "guild.invite_member"),
      ).toBeNull();
    });

    it("rejects an empty permission key", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(seed.gameId, seed.roleId, { permission: "" });
      expect(res.status).toBe(400);
    });

    it("rejects a permission key over the 128-char cap", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(seed.gameId, seed.roleId, { permission: "x".repeat(129) });
      expect(res.status).toBe(400);
      const rows = await prisma.rolePermission.findMany({ where: { roleId: seed.roleId } });
      expect(rows).toHaveLength(0);
    });

    it("rejects a missing permission field with 400", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(seed.gameId, seed.roleId, {});
      expect(res.status).toBe(400);
    });

    it("rejects a non-string permission value with 400", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(seed.gameId, seed.roleId, { permission: 12 });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed JSON body with 400", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(seed.gameId, seed.roleId, "not json");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the role does not exist", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await grantFetch(game.id, "rol_missing", { permission: "guild.invite_member" });
      expect(res.status).toBe(404);

      const defs = await prisma.permissionDef.findMany({ where: { gameId: game.id } });
      expect(defs).toHaveLength(0);
    });

    it("returns 404 when the role's group is soft-deleted (no PermissionDef leak)", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1", { softDeletedGroup: true });
      const res = await grantFetch(seed.gameId, seed.roleId, { permission: "guild.invite_member" });
      expect(res.status).toBe(404);
      const defs = await prisma.permissionDef.findMany({ where: { gameId: seed.gameId } });
      expect(defs).toHaveLength(0);
    });

    it("returns 404 when the role belongs to a different game (no PermissionDef leak)", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const otherGame = await createGame("Beta", prisma);
      const res = await grantFetch(otherGame.id, seed.roleId, {
        permission: "guild.invite_member",
      });
      expect(res.status).toBe(404);

      const defs = await prisma.permissionDef.findMany({ where: { gameId: otherGame.id } });
      expect(defs).toHaveLength(0);
    });

    it("returns 401 without an Authorization header", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/roles/${seed.roleId}/permissions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permission: "guild.invite_member" }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1");
      const res = await grantFetch(
        seed.gameId,
        seed.roleId,
        { permission: "guild.invite_member" },
        "Bearer wrong",
      );
      expect(res.status).toBe(401);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)(
  "DELETE /v1/admin/games/:gameId/roles/:roleId/permissions/:permission",
  () => {
    let prisma: PrismaClient;
    let hub: EventHub;
    let app: Hono;

    beforeAll(() => {
      prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
      hub = new EventHub();
      app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
    });

    beforeEach(async () => {
      hub.clear();
      await prisma.$executeRawUnsafe(TRUNCATE);
    });

    afterAll(async () => {
      await prisma.$disconnect();
    });

    async function seedRoleWithPermissions(keys: string[]) {
      const seed = await seedRole(prisma, "Alpha", "g1");
      if (keys.length > 0) {
        await prisma.rolePermission.createMany({
          data: keys.map((k) => ({ roleId: seed.roleId, permissionKey: k })),
        });
        await prisma.permissionDef.createMany({
          data: keys.map((k) => ({ gameId: seed.gameId, key: k })),
        });
      }
      return seed;
    }

    function revokeFetch(
      gameId: string,
      roleId: string,
      permission: string,
      header = `Bearer ${ADMIN_TOKEN}`,
    ) {
      return app.request(
        `/v1/admin/games/${gameId}/roles/${roleId}/permissions/${encodeURIComponent(permission)}`,
        { method: "DELETE", headers: { authorization: header } },
      );
    }

    it("deletes the RolePermission row and returns the role with the permission removed", async () => {
      const seed = await seedRoleWithPermissions(["guild.invite_member", "guild.kick_member"]);
      const res = await revokeFetch(seed.gameId, seed.roleId, "guild.invite_member");
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminRole;
      expect(body.permissions).toEqual(["guild.kick_member"]);

      const stored = await prisma.rolePermission.findUnique({
        where: {
          roleId_permissionKey: {
            roleId: seed.roleId,
            permissionKey: "guild.invite_member",
          },
        },
      });
      expect(stored).toBeNull();
    });

    it("writes a permission.revoked audit entry with previous payload", async () => {
      const seed = await seedRoleWithPermissions(["guild.kick_member"]);
      await revokeFetch(seed.gameId, seed.roleId, "guild.kick_member");

      const entries = await prisma.auditEntry.findMany({
        where: { groupId: seed.groupId, action: "permission.revoked" },
      });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.targetId).toBe(seed.roleId);
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({
        roleId: seed.roleId,
        permission: "guild.kick_member",
      });
    });

    it("dispatches a permission.revoked JunjoEvent", async () => {
      const seed = await seedRoleWithPermissions(["guild.kick_member"]);
      const events: unknown[] = [];
      const unsubscribe = hub.subscribe(seed.groupId as GroupId, (e) => events.push(e));
      try {
        await revokeFetch(seed.gameId, seed.roleId, "guild.kick_member");
      } finally {
        unsubscribe();
      }
      expect(events).toHaveLength(1);
      const evt = events[0] as PermissionRevokedEvent;
      expect(evt.type).toBe("permission.revoked");
      expect(evt.gameId).toBe(seed.gameId);
      expect(evt.groupId).toBe(seed.groupId);
      expect(evt.roleId).toBe(seed.roleId);
      expect(evt.permission).toBe("guild.kick_member");
    });

    it("preserves the PermissionDef registry row when revoking", async () => {
      const seed = await seedRoleWithPermissions(["guild.invite_member"]);
      await revokeFetch(seed.gameId, seed.roleId, "guild.invite_member");
      const defs = await prisma.permissionDef.findMany({ where: { gameId: seed.gameId } });
      expect(defs).toHaveLength(1);
      expect(defs[0]?.key).toBe("guild.invite_member");
    });

    it("is a no-op when the role does not have the permission (no audit, no event)", async () => {
      const seed = await seedRoleWithPermissions(["guild.kick_member"]);
      const events: unknown[] = [];
      const unsubscribe = hub.subscribe(seed.groupId as GroupId, (e) => events.push(e));
      try {
        const res = await revokeFetch(seed.gameId, seed.roleId, "guild.invite_member");
        expect(res.status).toBe(200);
        const body = (await res.json()) as WireAdminRole;
        expect(body.permissions).toEqual(["guild.kick_member"]);

        const entries = await prisma.auditEntry.findMany({
          where: { action: "permission.revoked" },
        });
        expect(entries).toHaveLength(0);
      } finally {
        unsubscribe();
      }
      expect(events).toHaveLength(0);
    });

    it("is a no-op when the permission key is not registered at all", async () => {
      const seed = await seedRoleWithPermissions([]);
      const res = await revokeFetch(seed.gameId, seed.roleId, "guild.never_seen");
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminRole;
      expect(body.permissions).toEqual([]);

      const entries = await prisma.auditEntry.findMany({
        where: { action: "permission.revoked" },
      });
      expect(entries).toHaveLength(0);
    });

    it("invalidates the permission cache for the role's group after revoke", async () => {
      const { permissionCache } = await import("../permissionCache.js");
      const seed = await seedRoleWithPermissions(["guild.invite_member"]);
      permissionCache.set(seed.gameId, seed.groupId, "ext-user", "guild.invite_member", {
        allowed: true,
        source: "role",
      });
      expect(
        permissionCache.get(seed.gameId, seed.groupId, "ext-user", "guild.invite_member"),
      ).not.toBeNull();

      await revokeFetch(seed.gameId, seed.roleId, "guild.invite_member");

      expect(
        permissionCache.get(seed.gameId, seed.groupId, "ext-user", "guild.invite_member"),
      ).toBeNull();
    });

    it("returns 404 when the role does not exist (no audit / event)", async () => {
      const game = await createGame("Alpha", prisma);
      const res = await revokeFetch(game.id, "rol_missing", "guild.invite_member");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the role's group is soft-deleted (RolePermission row preserved)", async () => {
      const seed = await seedRole(prisma, "Alpha", "g1", { softDeletedGroup: true });
      await prisma.rolePermission.create({
        data: { roleId: seed.roleId, permissionKey: "guild.invite_member" },
      });
      const res = await revokeFetch(seed.gameId, seed.roleId, "guild.invite_member");
      expect(res.status).toBe(404);
      const stored = await prisma.rolePermission.findUnique({
        where: {
          roleId_permissionKey: {
            roleId: seed.roleId,
            permissionKey: "guild.invite_member",
          },
        },
      });
      expect(stored).not.toBeNull();
    });

    it("returns 404 when the role belongs to a different game (RolePermission row preserved)", async () => {
      const seed = await seedRoleWithPermissions(["guild.invite_member"]);
      const otherGame = await createGame("Beta", prisma);
      const res = await revokeFetch(otherGame.id, seed.roleId, "guild.invite_member");
      expect(res.status).toBe(404);
      const stored = await prisma.rolePermission.findUnique({
        where: {
          roleId_permissionKey: {
            roleId: seed.roleId,
            permissionKey: "guild.invite_member",
          },
        },
      });
      expect(stored).not.toBeNull();
    });

    it("URL-decodes the permission path parameter", async () => {
      const seed = await seedRoleWithPermissions(["scope/with-slash"]);
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/roles/${seed.roleId}/permissions/${encodeURIComponent("scope/with-slash")}`,
        { method: "DELETE", headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireAdminRole;
      expect(body.permissions).toEqual([]);
    });

    it("returns 401 without an Authorization header", async () => {
      const seed = await seedRoleWithPermissions(["guild.invite_member"]);
      const res = await app.request(
        `/v1/admin/games/${seed.gameId}/roles/${seed.roleId}/permissions/guild.invite_member`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(401);
    });

    it("returns 401 with the wrong admin token", async () => {
      const seed = await seedRoleWithPermissions(["guild.invite_member"]);
      const res = await revokeFetch(
        seed.gameId,
        seed.roleId,
        "guild.invite_member",
        "Bearer wrong",
      );
      expect(res.status).toBe(401);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/admin/games/:gameId/permissions", () => {
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

  function listFetch(gameId: string, header = `Bearer ${ADMIN_TOKEN}`) {
    return app.request(`/v1/admin/games/${gameId}/permissions`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty array when the game has no registered permission keys", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminPermissionDef[];
    expect(body).toEqual([]);
  });

  it("returns registered keys sorted by key ascending with full wire shape", async () => {
    const game = await createGame("Alpha", prisma);
    await prisma.permissionDef.createMany({
      data: [
        { gameId: game.id, key: "guild.kick_member" },
        { gameId: game.id, key: "guild.invite_member" },
        { gameId: game.id, key: "vault.withdraw" },
      ],
    });
    const res = await listFetch(game.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireAdminPermissionDef[];
    expect(body.map((d) => d.key)).toEqual([
      "guild.invite_member",
      "guild.kick_member",
      "vault.withdraw",
    ]);
    expect(body[0]?.description).toBeNull();
    expect(typeof body[0]?.createdAt).toBe("string");
    expect(new Date(body[0]?.createdAt ?? "").toISOString()).toBe(body[0]?.createdAt);
  });

  it("includes description when set", async () => {
    const game = await createGame("Alpha", prisma);
    await prisma.permissionDef.create({
      data: { gameId: game.id, key: "guild.invite_member", description: "Send group invites" },
    });
    const res = await listFetch(game.id);
    const body = (await res.json()) as WireAdminPermissionDef[];
    expect(body[0]?.description).toBe("Send group invites");
  });

  it("scopes to the requested game (cross-game keys are excluded)", async () => {
    const alpha = await createGame("Alpha", prisma);
    const beta = await createGame("Beta", prisma);
    await prisma.permissionDef.createMany({
      data: [
        { gameId: alpha.id, key: "alpha.only" },
        { gameId: beta.id, key: "beta.only" },
      ],
    });
    const res = await listFetch(alpha.id);
    const body = (await res.json()) as WireAdminPermissionDef[];
    expect(body.map((d) => d.key)).toEqual(["alpha.only"]);
  });

  it("returns 404 when the game does not exist", async () => {
    const res = await listFetch("game_missing");
    expect(res.status).toBe(404);
  });

  it("returns 401 without an Authorization header", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await app.request(`/v1/admin/games/${game.id}/permissions`, { method: "GET" });
    expect(res.status).toBe(401);
  });

  it("returns 401 with the wrong admin token", async () => {
    const game = await createGame("Alpha", prisma);
    const res = await listFetch(game.id, "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("returns 401 when the admin token is unset on the server", async () => {
    const localApp = createApp({ prisma });
    const game = await createGame("Alpha", prisma);
    const res = await localApp.request(`/v1/admin/games/${game.id}/permissions`, {
      method: "GET",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(401);
  });
});
