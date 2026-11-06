import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { MAX_ROLE_ENTRIES, MAX_ROLE_PARENTS } from "./roles.schema";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-role-graph";

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface WireRole {
  id: string;
  name: string;
  permissions: string[];
  entries: { permission: string; value: boolean }[];
  parents: string[];
  metadata: Record<string, unknown>;
}

describe.skipIf(!TEST_DATABASE_URL)("role entries, parents, metadata and permission modes", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let hub: EventHub;
  let key: string;
  let gameId: string;
  let groupId: string;
  let events: JunjoEvent[];

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Roles", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    hub = new EventHub();
    app = createApp({
      prisma,
      adminToken: ADMIN_TOKEN,
      events: { hub, heartbeatIntervalMs: 30_000 },
    });
    const group = await prisma.group.create({
      data: { gameId, kind: "network", name: "net", visibility: "public", metadata: {} },
    });
    groupId = group.id;
    events = [];
    hub.subscribe(group.id as GroupId, (e) => events.push(e));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function call(method: string, path: string, body?: unknown, auth = key) {
    return app.request(path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  const admin = `Bearer ${ADMIN_TOKEN}`;

  async function setMode(mode: "exact" | "nodes") {
    return call(
      "PATCH",
      `/v1/admin/games/${gameId}/config`,
      { config: { permissions: { mode } } },
      admin,
    );
  }

  async function createRole(name: string, priority = 10): Promise<WireRole> {
    const res = await call("POST", `/v1/groups/${groupId}/roles`, { name, priority });
    expect(res.status).toBe(201);
    return (await res.json()) as WireRole;
  }

  async function member(userId: string, roleIds: string[]) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: userId },
    });
    const m = await prisma.groupMember.create({
      data: { groupId, junjoUserId: user.id, status: "active" },
    });
    for (const roleId of roleIds)
      await prisma.memberRole.create({ data: { groupMemberId: m.id, roleId } });
    return m;
  }

  async function check(userId: string, permission: string) {
    const qs = new URLSearchParams({ userId, groupId, permission });
    const res = await call("GET", `/v1/permissions/check?${qs}`);
    expect(res.status).toBe(200);
    return (await res.json()) as { allowed: boolean; source: string; viaRoleId?: string };
  }

  async function auditActions() {
    const rows = await prisma.auditEntry.findMany({
      where: { gameId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.action);
  }

  describe("PUT /v1/roles/:id/entries", () => {
    it("replaces entries atomically with one audit entry carrying the diff", async () => {
      const role = await createRole("admin");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "keep" });
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "flip" });
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "gone" });
      events.length = 0;

      const res = await call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [
          { permission: "keep", value: true },
          { permission: "flip", value: false },
          { permission: "new", value: true },
        ],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireRole;
      expect(body.entries).toEqual([
        { permission: "flip", value: false },
        { permission: "keep", value: true },
        { permission: "new", value: true },
      ]);
      expect(body.permissions).toEqual(["keep", "new"]);

      const audit = await prisma.auditEntry.findMany({ where: { action: "role.entries.changed" } });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.payload).toMatchObject({
        added: [{ permission: "new", value: true }],
        removed: [{ permission: "gone", value: true }],
        changed: [{ permission: "flip", before: true, after: false }],
      });
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      expect(events[0]).toMatchObject({ roleId: role.id, changed: ["entries"] });
    });

    it("writes nothing when the list is unchanged", async () => {
      const role = await createRole("r");
      await call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [{ permission: "a", value: true }],
      });
      const before = await prisma.auditEntry.count();
      events.length = 0;
      const res = await call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [{ permission: "a", value: true }],
      });
      expect(res.status).toBe(200);
      expect(await prisma.auditEntry.count()).toBe(before);
      expect(events).toHaveLength(0);
    });

    it("rejects duplicate keys and lists over the cap", async () => {
      const role = await createRole("r");
      const dup = await call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [
          { permission: "a", value: true },
          { permission: "a", value: false },
        ],
      });
      expect(dup.status).toBe(400);
      const many = Array.from({ length: MAX_ROLE_ENTRIES + 1 }, (_, i) => ({
        permission: `k${i}`,
        value: true,
      }));
      const over = await call("PUT", `/v1/roles/${role.id}/entries`, { entries: many });
      expect(over.status).toBe(400);
    });

    it("accepts a full list at the cap", async () => {
      const role = await createRole("r");
      const entries = Array.from({ length: MAX_ROLE_ENTRIES }, (_, i) => ({
        permission: `node.k${i}`,
        value: i % 2 === 0,
      }));
      const res = await call("PUT", `/v1/roles/${role.id}/entries`, { entries });
      expect(res.status).toBe(200);
      expect(await prisma.rolePermission.count({ where: { roleId: role.id } })).toBe(
        MAX_ROLE_ENTRIES,
      );
    });

    it("invalidates cached answers", async () => {
      const role = await createRole("r");
      await member("u1", [role.id]);
      expect((await check("u1", "fly")).allowed).toBe(false);
      await call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [{ permission: "fly", value: true }],
      });
      expect(await check("u1", "fly")).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: role.id,
      });
    });

    it("is reachable through the admin route", async () => {
      const role = await createRole("r");
      const res = await call(
        "PUT",
        `/v1/admin/games/${gameId}/roles/${role.id}/entries`,
        { entries: [{ permission: "a", value: false }] },
        admin,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireRole).entries).toEqual([{ permission: "a", value: false }]);
    });
  });

  describe("single entry writes", () => {
    it("keeps the legacy events for grant-only changes", async () => {
      const role = await createRole("r");
      events.length = 0;
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "kick" });
      await call("DELETE", `/v1/roles/${role.id}/permissions/kick`);
      expect(events.map((e) => e.type)).toEqual(["permission.granted", "permission.revoked"]);
      expect(await auditActions()).toEqual([
        "role.created",
        "permission.granted",
        "permission.revoked",
      ]);
    });

    it("stores a deny entry and reports it through role.updated", async () => {
      const role = await createRole("r");
      await member("u1", [role.id]);
      events.length = 0;
      const res = await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "kick",
        value: false,
      });
      const body = (await res.json()) as WireRole;
      expect(body.entries).toEqual([{ permission: "kick", value: false }]);
      expect(body.permissions).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      expect(await check("u1", "kick")).toEqual({
        allowed: false,
        source: "role",
        viaRoleId: role.id,
      });
    });

    it("flipping a grant to a deny revokes and signals the update", async () => {
      const role = await createRole("r");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "kick" });
      events.length = 0;
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "kick", value: false });
      expect(events.map((e) => e.type)).toEqual(["permission.revoked", "role.updated"]);
    });

    it("removing a deny entry signals the update only", async () => {
      const role = await createRole("r");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "kick", value: false });
      events.length = 0;
      const res = await call("DELETE", `/v1/roles/${role.id}/permissions/kick`);
      expect(((await res.json()) as WireRole).entries).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
    });
  });

  describe("PUT /v1/roles/:id/parents", () => {
    it("sets parents, makes inherited entries apply, and audits", async () => {
      const base = await createRole("base", 0);
      const top = await createRole("top", 10);
      await call("POST", `/v1/roles/${base.id}/permissions`, { permission: "chat" });
      await member("u1", [top.id]);
      expect((await check("u1", "chat")).allowed).toBe(false);

      events.length = 0;
      const res = await call("PUT", `/v1/roles/${top.id}/parents`, { parents: [base.id] });
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireRole).parents).toEqual([base.id]);
      expect(events).toEqual([
        expect.objectContaining({ type: "role.updated", changed: ["parents"] }),
      ]);
      expect(await check("u1", "chat")).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: base.id,
      });
      const audit = await prisma.auditEntry.findFirst({ where: { action: "role.parents.set" } });
      expect(audit?.payload).toEqual({ roleId: top.id, before: [], after: [base.id] });
    });

    it("rejects cycles, self parents, other groups and too many parents", async () => {
      const a = await createRole("a");
      const b = await createRole("b");
      await call("PUT", `/v1/roles/${a.id}/parents`, { parents: [b.id] });

      const cycle = await call("PUT", `/v1/roles/${b.id}/parents`, { parents: [a.id] });
      expect(cycle.status).toBe(400);
      expect(((await cycle.json()) as { code: string }).code).toBe("parent_cycle");

      const self = await call("PUT", `/v1/roles/${a.id}/parents`, { parents: [a.id] });
      expect(((await self.json()) as { code: string }).code).toBe("parent_cycle");

      const other = await prisma.group.create({
        data: { gameId, kind: "network", name: "other", visibility: "public", metadata: {} },
      });
      const foreign = await prisma.role.create({
        data: { groupId: other.id, name: "f", priority: 1 },
      });
      const cross = await call("PUT", `/v1/roles/${a.id}/parents`, { parents: [foreign.id] });
      expect(((await cross.json()) as { code: string }).code).toBe("role_group_mismatch");

      const tooMany = await call("PUT", `/v1/roles/${a.id}/parents`, {
        parents: Array.from({ length: MAX_ROLE_PARENTS + 1 }, (_, i) => `r${i}`),
      });
      expect(tooMany.status).toBe(400);

      const missing = await call("PUT", `/v1/roles/${a.id}/parents`, { parents: ["nope"] });
      expect(missing.status).toBe(404);
    });

    it("rejects a chain deeper than the depth limit", async () => {
      const ids: string[] = [];
      for (let i = 0; i <= 101; i++) {
        const r = await prisma.role.create({ data: { groupId, name: `l${i}`, priority: i } });
        ids.push(r.id);
      }
      // l0 -> l1 -> ... -> l100 is 100 edges, the limit.
      await prisma.roleParent.createMany({
        data: ids
          .slice(0, 100)
          .map((id, i) => ({ roleId: id, parentRoleId: ids[i + 1] as string })),
      });
      const ok = await call("PUT", `/v1/roles/${ids[100]}/parents`, { parents: [] });
      expect(ok.status).toBe(200);
      const deep = await call("PUT", `/v1/roles/${ids[100]}/parents`, { parents: [ids[101]] });
      expect(deep.status).toBe(400);
    });

    it("deleting a parent role signals each child", async () => {
      const base = await createRole("base", 0);
      const top = await createRole("top", 10);
      await call("PUT", `/v1/roles/${top.id}/parents`, { parents: [base.id] });
      events.length = 0;
      const res = await call("DELETE", `/v1/roles/${base.id}`);
      expect(res.status).toBe(204);
      expect(events.map((e) => e.type).sort()).toEqual(["role.deleted", "role.updated"]);
      expect(await prisma.roleParent.count()).toBe(0);
    });
  });

  describe("role metadata and the role.updated event", () => {
    it("stores metadata on create and replaces it on update", async () => {
      const res = await call("POST", `/v1/groups/${groupId}/roles`, {
        name: "vip",
        priority: 5,
        metadata: { prefix: "[VIP]" },
      });
      const role = (await res.json()) as WireRole;
      expect(role.metadata).toEqual({ prefix: "[VIP]" });

      events.length = 0;
      const patched = await call("PATCH", `/v1/roles/${role.id}`, {
        metadata: { suffix: "!" },
        priority: 6,
      });
      expect(((await patched.json()) as WireRole).metadata).toEqual({ suffix: "!" });
      expect(events).toEqual([
        expect.objectContaining({ type: "role.updated", changed: ["priority", "metadata"] }),
      ]);
    });

    it("rejects oversized metadata", async () => {
      const res = await call("POST", `/v1/groups/${groupId}/roles`, {
        name: "big",
        priority: 1,
        metadata: { blob: "x".repeat(17 * 1024) },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("bulk reads", () => {
    it("returns the group's role graph", async () => {
      const base = await createRole("base", 0);
      const top = await createRole("top", 10);
      await call("PUT", `/v1/roles/${top.id}/entries`, {
        entries: [{ permission: "a", value: false }],
      });
      await call("PUT", `/v1/roles/${top.id}/parents`, { parents: [base.id] });
      await prisma.group.update({ where: { id: groupId }, data: { defaultRoleId: base.id } });

      const res = await call("GET", `/v1/groups/${groupId}/role-graph`);
      expect(res.status).toBe(200);
      const graph = (await res.json()) as {
        mode: string;
        defaultRoleId: string;
        roles: WireRole[];
      };
      expect(graph.mode).toBe("exact");
      expect(graph.defaultRoleId).toBe(base.id);
      expect(graph.roles.map((r) => r.name)).toEqual(["top", "base"]);
      expect(graph.roles[0]).toMatchObject({
        entries: [{ permission: "a", value: false }],
        parents: [base.id],
      });

      const adminRes = await call(
        "GET",
        `/v1/admin/games/${gameId}/groups/${groupId}/role-graph`,
        undefined,
        admin,
      );
      expect(await adminRes.json()).toEqual(graph);
    });

    it("returns one member's roles and overrides", async () => {
      const role = await createRole("r");
      await member("u1", [role.id]);
      await call("POST", `/v1/groups/${groupId}/members/u1/permissions/fly`, { grant: false });
      const res = await call("GET", `/v1/groups/${groupId}/members/u1/access`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        groupId,
        userId: "u1",
        status: "active",
        roleIds: [role.id],
        overrides: [{ permission: "fly", grant: false }],
      });
      const missing = await call("GET", `/v1/groups/${groupId}/members/nobody/access`);
      expect(missing.status).toBe(404);
    });
  });

  describe("nodes mode", () => {
    it("lowercases and validates keys on every write", async () => {
      expect((await setMode("nodes")).status).toBe(200);
      const role = await createRole("r");
      const res = await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "ChestShop.Shop.*",
      });
      expect(((await res.json()) as WireRole).permissions).toEqual(["chestshop.shop.*"]);

      for (const bad of ["a.*.b", "has space", "-neg", "a*"]) {
        const r = await call("POST", `/v1/roles/${role.id}/permissions`, { permission: bad });
        expect(r.status, bad).toBe(400);
      }
      const bulkBad = await call("PUT", `/v1/roles/${role.id}/entries`, {
        entries: [{ permission: "*.x", value: true }],
      });
      expect(bulkBad.status).toBe(400);

      await member("u1", [role.id]);
      await call("POST", `/v1/groups/${groupId}/members/u1/permissions/ESSENTIALS.FLY`, {
        grant: true,
      });
      const overrides = await prisma.memberPermissionOverride.findMany();
      expect(overrides.map((o) => o.permissionKey)).toEqual(["essentials.fly"]);
      expect((await check("u1", "Essentials.Fly")).source).toBe("override");

      const del = await call("DELETE", `/v1/roles/${role.id}/permissions/CHESTSHOP.SHOP.*`);
      expect(((await del.json()) as WireRole).permissions).toEqual([]);
      const keys = await prisma.permissionDef.findMany({ where: { gameId } });
      expect(keys.map((k) => k.key).sort()).toEqual(["chestshop.shop.*", "essentials.fly"]);
    });

    it("makes role names unique ignoring case", async () => {
      await setMode("nodes");
      await createRole("Admin");
      const clash = await call("POST", `/v1/groups/${groupId}/roles`, {
        name: "admin",
        priority: 1,
      });
      expect(clash.status).toBe(409);
      const other = await createRole("Mod");
      const rename = await call("PATCH", `/v1/roles/${other.id}`, { name: "ADMIN" });
      expect(rename.status).toBe(409);
    });

    it("exact mode keeps case-distinct role names", async () => {
      await createRole("Admin");
      await createRole("admin");
    });
  });

  describe("switching permission modes", () => {
    it("lowercases stored keys, merges the catalog, audits and drops cached answers", async () => {
      const role = await createRole("r");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "Essentials.Fly" });
      await prisma.permissionDef.create({
        data: { gameId, key: "essentials.FLY", description: "kept" },
      });
      await member("u1", [role.id]);
      await call("POST", `/v1/groups/${groupId}/members/u1/permissions/Chat.Color`, {
        grant: true,
      });
      expect((await check("u1", "essentials.fly")).allowed).toBe(false);

      const res = await setMode("nodes");
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { config: { permissions: { mode: string } } }).config.permissions
          .mode,
      ).toBe("nodes");
      expect((await prisma.rolePermission.findMany()).map((r) => r.permissionKey)).toEqual([
        "essentials.fly",
      ]);
      expect(
        (await prisma.memberPermissionOverride.findMany()).map((o) => o.permissionKey),
      ).toEqual(["chat.color"]);
      const defs = await prisma.permissionDef.findMany({
        where: { gameId },
        orderBy: { key: "asc" },
      });
      expect(defs.map((d) => [d.key, d.description])).toEqual([
        ["chat.color", null],
        ["essentials.fly", "kept"],
      ]);
      const audit = await prisma.auditEntry.findFirst({
        where: { action: "game.permissions.mode.set" },
      });
      expect(audit?.payload).toEqual({ before: "exact", after: "nodes", rewrittenKeys: 2 });

      expect((await check("u1", "essentials.fly")).allowed).toBe(true);
      expect((await check("u1", "Essentials.Fly")).allowed).toBe(true);
    });

    it("refuses when a stored key would change meaning", async () => {
      const role = await createRole("r");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "area.*" });
      const res = await setMode("nodes");
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string; message: string };
      expect(body.code).toBe("permission_mode_conflict");
      expect(body.message).toContain("area.*");
      const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
      expect(game.config).toEqual({});
    });

    it("refuses keys that collide once lowercased, and role names that differ only by case", async () => {
      const role = await createRole("r");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "Fly" });
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "fly" });
      expect((await setMode("nodes")).status).toBe(409);

      await call("DELETE", `/v1/roles/${role.id}/permissions/Fly`);
      await createRole("Admin");
      await createRole("admin");
      const names = await setMode("nodes");
      expect(names.status).toBe(409);
      expect(((await names.json()) as { message: string }).message).toContain("role names");
    });

    it("refuses switching back to exact while wildcards are stored", async () => {
      await setMode("nodes");
      const role = await createRole("r");
      await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "area.*" });
      expect((await setMode("exact")).status).toBe(409);
      await call("DELETE", `/v1/roles/${role.id}/permissions/area.*`);
      expect((await setMode("exact")).status).toBe(200);
    });
  });
});
