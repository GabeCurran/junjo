import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { PermissionCache, permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-permission-contexts";

const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

type Context = Record<string, string>;

interface WireEntry {
  permission: string;
  value: boolean;
  context?: Context;
}

interface WireRole {
  id: string;
  permissions: string[];
  entries: WireEntry[];
}

interface CheckResult {
  allowed: boolean;
  source: string;
  viaRoleId?: string;
  viaGroupId?: string;
  context?: Context;
}

describe.skipIf(!TEST_DATABASE_URL)("permission contexts", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let hub: EventHub;
  let key: string;
  let gameId: string;
  let groupId: string;
  let events: JunjoEvent[];
  const admin = `Bearer ${ADMIN_TOKEN}`;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Contexts", prisma);
    gameId = game.id;
    const apiKey = await createApiKey(game.id, prisma);
    await prisma.apiKey.update({ where: { id: apiKey.apiKey.id }, data: { canExport: true } });
    key = `Bearer ${apiKey.raw.full}`;
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

  async function patchConfig(config: unknown) {
    return call("PATCH", `/v1/admin/games/${gameId}/config`, { config }, admin);
  }

  async function createRole(name: string, priority = 10): Promise<WireRole> {
    const res = await call("POST", `/v1/groups/${groupId}/roles`, { name, priority });
    expect(res.status).toBe(201);
    return (await res.json()) as WireRole;
  }

  async function putEntries(roleId: string, entries: unknown) {
    return call("PUT", `/v1/roles/${roleId}/entries`, { entries });
  }

  async function member(userId: string, roleIds: string[] = []) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: userId },
    });
    const m = await prisma.groupMember.create({
      data: { groupId, junjoUserId: user.id, status: "active" },
    });
    for (const roleId of roleIds) {
      await prisma.memberRole.create({ data: { groupMemberId: m.id, roleId } });
    }
    return m;
  }

  function contextQuery(context: Context = {}): string {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(context)) qs.set(`context.${k}`, v);
    const s = qs.toString();
    return s ? `?${s}` : "";
  }

  async function check(
    userId: string,
    permission: string,
    context: Context = {},
    extra: Record<string, string> = {},
  ): Promise<CheckResult> {
    const qs = new URLSearchParams({ userId, groupId, permission, ...extra });
    for (const [k, v] of Object.entries(context)) qs.set(`context.${k}`, v);
    const res = await call("GET", `/v1/permissions/check?${qs}`);
    expect(res.status).toBe(200);
    return (await res.json()) as CheckResult;
  }

  describe("role entries", () => {
    it("PUT stores global and contextual entries side by side, folded", async () => {
      const role = await createRole("admin");
      const res = await putEntries(role.id, [
        { permission: "essentials.fly", value: false },
        { permission: "essentials.fly", value: true, context: { world: "Creative" } },
        { permission: "essentials.fly", value: true, context: { world: "creative", server: "EU" } },
        { permission: "kit.vip", value: true, context: {} },
      ]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as WireRole;
      expect(body.entries).toEqual([
        { permission: "essentials.fly", value: false },
        { permission: "essentials.fly", value: true, context: { server: "eu", world: "creative" } },
        { permission: "essentials.fly", value: true, context: { world: "creative" } },
        { permission: "kit.vip", value: true },
      ]);
      // The legacy granted-keys list names global grants only.
      expect(body.permissions).toEqual(["kit.vip"]);

      const rows = await prisma.rolePermission.findMany({
        where: { roleId: role.id },
        orderBy: [{ permissionKey: "asc" }, { contextKey: "asc" }],
      });
      expect(rows.map((r) => [r.permissionKey, r.contextKey, r.context])).toEqual([
        ["essentials.fly", "", null],
        [
          "essentials.fly",
          '[["server","eu"],["world","creative"]]',
          { server: "eu", world: "creative" },
        ],
        ["essentials.fly", '[["world","creative"]]', { world: "creative" }],
        ["kit.vip", "", null],
      ]);
    });

    it("PUT refuses a repeated (permission, context) pair, including after folding", async () => {
      const role = await createRole("admin");
      const dup = await putEntries(role.id, [
        { permission: "fly", value: true, context: { world: "Nether" } },
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      expect(dup.status).toBe(400);
      expect(((await dup.json()) as { message: string }).message).toContain("duplicate permission");

      const globalDup = await putEntries(role.id, [
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: {} },
      ]);
      expect(globalDup.status).toBe(400);
    });

    it("PUT diffs by (permission, context) and emits only role.updated", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "fly", value: true },
        { permission: "fly", value: true, context: { world: "a" } },
      ]);
      events.length = 0;
      const res = await putEntries(role.id, [
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: { world: "a" } },
        { permission: "fly", value: true, context: { world: "b" } },
      ]);
      expect(res.status).toBe(200);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      const audit = await prisma.auditEntry.findFirst({
        where: { gameId, action: "role.entries.changed" },
        orderBy: { createdAt: "desc" },
      });
      expect(audit?.payload).toMatchObject({
        added: [{ permission: "fly", value: true, context: { world: "b" } }],
        changed: [{ permission: "fly", before: true, after: false, context: { world: "a" } }],
        removed: [],
      });
    });

    it("refuses invalid contexts with 400 bad_request", async () => {
      const role = await createRole("admin");
      const bad: unknown[] = [
        { World: "x" },
        { "1world": "x" },
        { world: "" },
        { world: "x".repeat(65) },
        { world: "a\u0001b" },
        { world: "a", server: "b", region: "c" },
        { world: 5 },
        ["world"],
      ];
      for (const context of bad) {
        const res = await putEntries(role.id, [{ permission: "fly", value: true, context }]);
        expect(res.status, JSON.stringify(context)).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("bad_request");
      }
      const ok = await putEntries(role.id, [
        { permission: "fly", value: true, context: { world_2: "x".repeat(64) } },
      ]);
      expect(ok.status).toBe(200);
    });

    it("counts contextual entries toward the per-role cap", async () => {
      const role = await createRole("admin");
      await prisma.rolePermission.createMany({
        data: Array.from({ length: 4999 }, (_, i) => ({
          roleId: role.id,
          permissionKey: `k${i}`,
          value: true,
          context: { world: "a" },
          contextKey: '[["world","a"]]',
        })),
      });
      const fill = await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "k0",
        context: { world: "b" },
      });
      expect(fill.status).toBe(200);
      const over = await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "k0",
        context: { world: "c" },
      });
      expect(over.status).toBe(400);
    });

    it("POST and DELETE target a contextual entry by context, the global one without", async () => {
      const role = await createRole("admin");
      events.length = 0;
      let res = await call("POST", `/v1/roles/${role.id}/permissions`, { permission: "fly" });
      expect(events.map((e) => e.type)).toEqual(["permission.granted"]);
      events.length = 0;

      res = await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "fly",
        value: false,
        context: { world: "Nether" },
      });
      expect(res.status).toBe(200);
      let body = (await res.json()) as WireRole;
      expect(body.entries).toEqual([
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      expect(events[0]).toMatchObject({ changed: ["entries"] });
      events.length = 0;

      // A contextual grant is not a legacy grant.
      res = await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "build",
        context: { world: "creative" },
      });
      body = (await res.json()) as WireRole;
      expect(body.permissions).toEqual(["fly"]);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      events.length = 0;

      // Repeating it is a no-op.
      await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "build",
        context: { world: "CREATIVE" },
      });
      expect(events).toEqual([]);

      res = await call(
        "DELETE",
        `/v1/roles/${role.id}/permissions/build${contextQuery({ world: "Creative" })}`,
      );
      expect(res.status).toBe(200);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      events.length = 0;

      // Without a context the DELETE removes the global entry only.
      res = await call("DELETE", `/v1/roles/${role.id}/permissions/fly`);
      body = (await res.json()) as WireRole;
      expect(body.entries).toEqual([
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      expect(events.map((e) => e.type)).toEqual(["permission.revoked"]);
      events.length = 0;

      res = await call(
        "DELETE",
        `/v1/roles/${role.id}/permissions/fly${contextQuery({ world: "nether" })}`,
      );
      body = (await res.json()) as WireRole;
      expect(body.entries).toEqual([]);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
    });

    it("DELETE refuses an invalid or repeated context query", async () => {
      const role = await createRole("admin");
      const badKey = await call("DELETE", `/v1/roles/${role.id}/permissions/fly?context.World=x`);
      expect(badKey.status).toBe(400);
      const repeated = await call(
        "DELETE",
        `/v1/roles/${role.id}/permissions/fly?context.world=a&context.world=b`,
      );
      expect(repeated.status).toBe(400);
    });

    it("the role graph returns entries with their context", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "fly", value: true, context: { world: "a" } },
        { permission: "walk", value: true },
      ]);
      const res = await call("GET", `/v1/groups/${groupId}/role-graph`);
      expect(res.status).toBe(200);
      const graph = (await res.json()) as { roles: WireRole[] };
      expect(graph.roles[0]?.entries).toEqual([
        { permission: "fly", value: true, context: { world: "a" } },
        { permission: "walk", value: true },
      ]);
      expect(graph.roles[0]?.permissions).toEqual(["walk"]);
    });
  });

  describe("checks", () => {
    it("answers from contextual entries and reports the deciding context", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "essentials.fly", value: false },
        { permission: "essentials.fly", value: true, context: { world: "creative" } },
      ]);
      await member("alice", [role.id]);

      expect(await check("alice", "essentials.fly", { world: "Creative" })).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: role.id,
        context: { world: "creative" },
      });
      expect(await check("alice", "essentials.fly")).toEqual({
        allowed: false,
        source: "role",
        viaRoleId: role.id,
      });
      expect(await check("alice", "essentials.fly", { world: "survival" })).toEqual({
        allowed: false,
        source: "role",
        viaRoleId: role.id,
      });
      expect(
        await check("alice", "essentials.fly", { world: "creative" }, { inherit: "true" }),
      ).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: role.id,
        viaGroupId: groupId,
        context: { world: "creative" },
      });
    });

    it("keeps cached answers per context", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      await member("alice", [role.id]);
      expect((await check("alice", "fly")).allowed).toBe(true);
      expect((await check("alice", "fly", { world: "nether" })).allowed).toBe(false);
      expect((await check("alice", "fly", { world: "Nether" })).allowed).toBe(false);
      expect((await check("alice", "fly")).allowed).toBe(true);
      expect((await check("alice", "fly", { world: "end" })).allowed).toBe(true);
    });

    it("keys the cache on the canonical context", () => {
      const cache = new PermissionCache();
      cache.set("g", "grp", "u", "p", { allowed: true, source: "role" });
      cache.set("g", "grp", "u", "p", { allowed: false, source: "role" }, { context: "x" });
      expect(cache.get("g", "grp", "u", "p")?.allowed).toBe(true);
      expect(cache.get("g", "grp", "u", "p", { context: "" })?.allowed).toBe(true);
      expect(cache.get("g", "grp", "u", "p", { context: "x" })?.allowed).toBe(false);
      expect(cache.get("g", "grp", "u", "p", { context: "y" })).toBeNull();
      cache.invalidateGroup("grp");
      expect(cache.get("g", "grp", "u", "p", { context: "x" })).toBeNull();
    });

    it("drops cached contextual answers when an entry changes", async () => {
      const role = await createRole("admin");
      await member("alice", [role.id]);
      expect((await check("alice", "fly", { world: "a" })).source).toBe("default");
      await call("POST", `/v1/roles/${role.id}/permissions`, {
        permission: "fly",
        context: { world: "a" },
      });
      expect((await check("alice", "fly", { world: "a" })).allowed).toBe(true);
    });

    it("check-batch takes a context per entry", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      await member("alice", [role.id]);
      const res = await call("POST", "/v1/permissions/check-batch", {
        checks: [
          { userId: "alice", groupId, permission: "fly" },
          { userId: "alice", groupId, permission: "fly", context: { world: "NETHER" } },
          { userId: "alice", groupId, permission: "fly", context: {} },
        ],
      });
      expect(res.status).toBe(200);
      const { results } = (await res.json()) as { results: CheckResult[] };
      expect(results).toEqual([
        { allowed: true, source: "role", viaRoleId: role.id },
        { allowed: false, source: "role", viaRoleId: role.id, context: { world: "nether" } },
        { allowed: true, source: "role", viaRoleId: role.id },
      ]);

      const bad = await call("POST", "/v1/permissions/check-batch", {
        checks: [{ userId: "alice", groupId, permission: "fly", context: { World: "x" } }],
      });
      expect(bad.status).toBe(400);
    });

    it("refuses an invalid check context", async () => {
      await member("alice");
      const base = `/v1/permissions/check?userId=alice&groupId=${groupId}&permission=fly`;
      for (const suffix of [
        "&context.World=x",
        "&context.world=",
        "&context.a=1&context.b=2&context.c=3",
        "&context.world=a&context.world=b",
        `&context.world=${"x".repeat(65)}`,
      ]) {
        const res = await call("GET", `${base}${suffix}`);
        expect(res.status, suffix).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("bad_request");
      }
    });

    it("applies inherited contexts from the game config", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "home", value: true, context: { world: "world" } },
        { permission: "pvp", value: true, context: { world: "world" } },
        { permission: "pvp", value: false, context: { world: "pvpworld" } },
      ]);
      await member("alice", [role.id]);
      expect((await check("alice", "home", { world: "pvpworld" })).source).toBe("default");

      const res = await patchConfig({
        permissions: { contexts: { world: { inherit: { PvPWorld: ["World"] } } } },
      });
      expect(res.status).toBe(200);
      expect(
        ((await res.json()) as { config: { permissions: unknown } }).config.permissions,
      ).toEqual({ mode: "exact", contexts: { world: { inherit: { pvpworld: ["world"] } } } });

      // The config change drops the cached answer above.
      expect(await check("alice", "home", { world: "pvpworld" })).toMatchObject({
        allowed: true,
        context: { world: "world" },
      });
      expect(await check("alice", "pvp", { world: "pvpworld" })).toMatchObject({
        allowed: false,
        context: { world: "pvpworld" },
      });
    });

    it("the admin check mirror takes context query parameters", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [{ permission: "fly", value: true, context: { world: "a" } }]);
      await member("alice", [role.id]);
      const qs = new URLSearchParams({ userId: "alice", groupId, permission: "fly" });
      const plain = await call(
        "GET",
        `/v1/admin/games/${gameId}/permissions/check?${qs}`,
        undefined,
        admin,
      );
      expect(((await plain.json()) as CheckResult).source).toBe("default");
      qs.set("context.world", "A");
      const scoped = await call(
        "GET",
        `/v1/admin/games/${gameId}/permissions/check?${qs}`,
        undefined,
        admin,
      );
      expect(await scoped.json()).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: role.id,
        context: { world: "a" },
      });
    });
  });

  describe("member overrides", () => {
    it("POST and DELETE target a contextual override by context", async () => {
      const role = await createRole("player");
      await putEntries(role.id, [{ permission: "chat", value: true }]);
      await member("alice", [role.id]);
      const path = `/v1/groups/${groupId}/members/alice/permissions/chat`;
      events.length = 0;

      let res = await call("POST", path, { grant: false, context: { world: "Hub" } });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        permission: "chat",
        grant: false,
        context: { world: "hub" },
      });
      expect(events.map((e) => e.type)).toEqual(["member.updated"]);
      expect(events[0]).toMatchObject({ changed: ["overrides"] });
      events.length = 0;

      res = await call("POST", path, { grant: true });
      expect(((await res.json()) as { context?: unknown }).context).toBeUndefined();

      const list = await call("GET", `/v1/groups/${groupId}/members/alice/permissions`);
      expect(
        ((await list.json()) as { permission: string; grant: boolean; context?: Context }[]).map(
          (o) => [o.permission, o.grant, o.context],
        ),
      ).toEqual([
        ["chat", true, undefined],
        ["chat", false, { world: "hub" }],
      ]);

      const access = await call("GET", `/v1/groups/${groupId}/members/alice/access`);
      expect(
        ((await access.json()) as { overrides: { context?: Context }[] }).overrides.map(
          (o) => o.context,
        ),
      ).toEqual([undefined, { world: "hub" }]);

      expect(await check("alice", "chat", { world: "hub" })).toEqual({
        allowed: false,
        source: "override",
        context: { world: "hub" },
      });
      expect(await check("alice", "chat", { world: "spawn" })).toEqual({
        allowed: true,
        source: "override",
      });

      events.length = 0;
      res = await call("DELETE", `${path}${contextQuery({ world: "hub" })}`);
      expect(res.status).toBe(204);
      expect(events.map((e) => e.type)).toEqual(["member.updated"]);
      expect(await check("alice", "chat", { world: "hub" })).toEqual({
        allowed: true,
        source: "override",
      });

      res = await call("DELETE", path);
      expect(res.status).toBe(204);
      expect(await prisma.memberPermissionOverride.count()).toBe(0);
    });

    it("a contextual override that does not apply falls through to roles", async () => {
      const role = await createRole("player");
      await putEntries(role.id, [{ permission: "chat", value: true }]);
      await member("alice", [role.id]);
      await call("POST", `/v1/groups/${groupId}/members/alice/permissions/chat`, {
        grant: false,
        context: { world: "hub" },
      });
      expect(await check("alice", "chat")).toEqual({
        allowed: true,
        source: "role",
        viaRoleId: role.id,
      });
    });

    it("the admin mirrors take context on set, list and clear", async () => {
      await member("alice");
      const path = `/v1/admin/games/${gameId}/groups/${groupId}/members/alice/permissions/chat`;
      let res = await call("POST", path, { grant: false, context: { world: "Hub" } }, admin);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ grant: false, context: { world: "hub" } });
      await call("POST", path, { grant: true }, admin);
      const list = await call(
        "GET",
        `/v1/admin/games/${gameId}/groups/${groupId}/members/alice/permissions`,
        undefined,
        admin,
      );
      expect(
        ((await list.json()) as { grant: boolean; context?: Context }[]).map((o) => [
          o.grant,
          o.context,
        ]),
      ).toEqual([
        [true, undefined],
        [false, { world: "hub" }],
      ]);
      res = await call("DELETE", `${path}?context.world=hub`, undefined, admin);
      expect(res.status).toBe(204);
      const left = await prisma.memberPermissionOverride.findMany();
      expect(left.map((o) => o.contextKey)).toEqual([""]);
    });

    it("the admin role mirrors take context on grant and revoke", async () => {
      const role = await createRole("admin");
      const path = `/v1/admin/games/${gameId}/roles/${role.id}/permissions`;
      events.length = 0;
      let res = await call(
        "POST",
        path,
        { permission: "fly", value: false, context: { world: "a" } },
        admin,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as WireRole).entries).toEqual([
        { permission: "fly", value: false, context: { world: "a" } },
      ]);
      expect(events.map((e) => e.type)).toEqual(["role.updated"]);
      res = await call("DELETE", `${path}/fly?context.world=a`, undefined, admin);
      expect(((await res.json()) as WireRole).entries).toEqual([]);
    });
  });

  describe("import", () => {
    it("imports contextual overrides beside global ones", async () => {
      const res = await call("POST", `/v1/groups/${groupId}/members/import`, {
        members: [
          {
            userId: "alice",
            overrides: [
              { permission: "fly", value: true },
              { permission: "fly", value: false, context: { world: "Nether" } },
            ],
          },
        ],
      });
      expect(res.status).toBe(200);
      const rows = await prisma.memberPermissionOverride.findMany({
        orderBy: { contextKey: "asc" },
      });
      expect(rows.map((r) => [r.permissionKey, r.grant, r.contextKey, r.context])).toEqual([
        ["fly", true, "", null],
        ["fly", false, '[["world","nether"]]', { world: "nether" }],
      ]);

      // Re-importing the same overrides changes nothing; dropping the
      // contextual one clears only it.
      const same = await call("POST", `/v1/groups/${groupId}/members/import`, {
        members: [
          {
            userId: "alice",
            overrides: [
              { permission: "fly", value: true },
              { permission: "fly", value: false, context: { world: "nether" } },
            ],
          },
        ],
      });
      expect(((await same.json()) as { unchanged: number }).unchanged).toBe(1);
      const drop = await call("POST", `/v1/groups/${groupId}/members/import`, {
        members: [{ userId: "alice", overrides: [{ permission: "fly", value: true }] }],
      });
      expect(((await drop.json()) as { updated: number }).updated).toBe(1);
      expect((await prisma.memberPermissionOverride.findMany()).map((r) => r.contextKey)).toEqual([
        "",
      ]);
    });

    it("refuses a row repeating a (permission, context) pair or an invalid context", async () => {
      const res = await call("POST", `/v1/groups/${groupId}/members/import`, {
        members: [
          {
            userId: "alice",
            overrides: [
              { permission: "fly", value: true, context: { world: "a" } },
              { permission: "fly", value: false, context: { world: "A" } },
            ],
          },
          {
            userId: "bob",
            overrides: [{ permission: "fly", value: true, context: { World: "a" } }],
          },
        ],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { details?: { rows: { index: number; code: string }[] } };
      expect(body.details?.rows.map((r) => [r.index, r.code])).toEqual([
        [0, "bad_request"],
        [1, "bad_request"],
      ]);
    });
  });

  describe("export", () => {
    it("includes contexts on role entries and member overrides", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      await member("alice", [role.id]);
      await call("POST", `/v1/groups/${groupId}/members/alice/permissions/chat`, {
        grant: true,
        context: { world: "hub" },
      });
      const res = await call("GET", "/v1/export");
      expect(res.status).toBe(200);
      const lines = (await res.text())
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const roleLine = lines.find((l) => l.kind === "role");
      expect(roleLine?.entries).toEqual([
        { permission: "fly", value: true },
        { permission: "fly", value: false, context: { world: "nether" } },
      ]);
      const memberLine = lines.find((l) => l.kind === "member");
      expect(memberLine?.overrides).toEqual([
        expect.objectContaining({ permission: "chat", value: true, context: { world: "hub" } }),
      ]);
    });
  });

  describe("config", () => {
    it("refuses cycles, deep chains and oversized maps", async () => {
      const chain = (n: number) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`w${i}`, [`w${i + 1}`]]));
      const bad: unknown[] = [
        { world: { inherit: { a: ["b"], b: ["a"] } } },
        { world: { inherit: { a: ["A"] } } },
        { world: { inherit: chain(17) } },
        { world: { inherit: { a: Array.from({ length: 9 }, (_, i) => `p${i}`) } } },
        {
          world: {
            inherit: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`v${i}`, ["r"]])),
          },
        },
        { World: { inherit: {} } },
        { world: { inherit: { a: [""] } } },
        { world: { inherit: { a: ["b"] }, extra: true } },
        { world: { parents: { a: ["b"] } } },
        { world: [] },
      ];
      for (const contexts of bad) {
        const res = await patchConfig({ permissions: { contexts } });
        expect(res.status, JSON.stringify(contexts).slice(0, 80)).toBe(400);
        expect(((await res.json()) as { code: string }).code).toBe("bad_request");
      }
      const ok = await patchConfig({
        permissions: { contexts: { world: { inherit: chain(16) } } },
      });
      expect(ok.status).toBe(200);
    });

    it("replaces permissions.contexts as a whole and keeps it across other patches", async () => {
      const first = await patchConfig({
        permissions: {
          contexts: {
            world: { inherit: { pvpworld: ["world"] } },
            server: { inherit: { eu2: ["eu"] } },
          },
        },
      });
      expect(first.status).toBe(200);
      await patchConfig({ permissions: { mode: "nodes" } });
      const read = await call("GET", `/v1/admin/games/${gameId}/config`, undefined, admin);
      const readBody = (await read.json()) as { config: { permissions: unknown } };
      expect(readBody.config.permissions).toEqual({
        mode: "nodes",
        contexts: {
          server: { inherit: { eu2: ["eu"] } },
          world: { inherit: { pvpworld: ["world"] } },
        },
      });

      const replaced = await patchConfig({
        permissions: { contexts: { world: { inherit: { nether: ["world"] } } } },
      });
      const replacedBody = (await replaced.json()) as { config: { permissions: unknown } };
      expect(replacedBody.config.permissions).toEqual({
        mode: "nodes",
        contexts: { world: { inherit: { nether: ["world"] } } },
      });

      const cleared = await patchConfig({ permissions: { contexts: {} } });
      const clearedBody = (await cleared.json()) as { config: { permissions: unknown } };
      expect(clearedBody.config.permissions).toEqual({ mode: "nodes", contexts: {} });
    });

    it("a mode switch keeps contextual entries and treats each context separately", async () => {
      const role = await createRole("admin");
      await putEntries(role.id, [
        { permission: "Fly", value: true },
        { permission: "fly", value: false, context: { world: "a" } },
      ]);
      const res = await patchConfig({ permissions: { mode: "nodes" } });
      expect(res.status).toBe(200);
      const rows = await prisma.rolePermission.findMany({ orderBy: { contextKey: "asc" } });
      expect(rows.map((r) => [r.permissionKey, r.contextKey])).toEqual([
        ["fly", ""],
        ["fly", '[["world","a"]]'],
      ]);
    });
  });
});
