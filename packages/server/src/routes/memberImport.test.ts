import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { MEMBER_IMPORT_MAX_ROWS } from "./members.schema";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "GameBan", "BanHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "Invitation", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface ImportResult {
  created: number;
  reactivated: number;
  updated: number;
  unchanged: number;
  items: { userId: string; status: string; version: number }[];
}

interface RowError {
  index: number;
  userId: string;
  code: string;
  message: string;
}

interface Envelope {
  code: string;
  status: number;
  message: string;
  details?: { rows: RowError[] };
}

interface WireMember {
  status: string;
  roles: string[];
  metadata: Record<string, unknown>;
  version: number;
}

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/members/import", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let gameId: string;
  let groupId: string;
  let roleA: string;
  let roleB: string;
  let defaultRole: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Import", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma });
    const group = await prisma.group.create({
      data: { gameId, kind: "rank", name: "server", visibility: "invite-only", metadata: {} },
    });
    groupId = group.id;
    roleA = (await prisma.role.create({ data: { groupId, name: "a", priority: 1 } })).id;
    roleB = (await prisma.role.create({ data: { groupId, name: "b", priority: 2 } })).id;
    defaultRole = (await prisma.role.create({ data: { groupId, name: "member", priority: 0 } })).id;
    await prisma.group.update({ where: { id: groupId }, data: { defaultRoleId: defaultRole } });
  });

  function call(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { authorization: key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const importRows = (body: unknown) => call("POST", `/v1/groups/${groupId}/members/import`, body);

  async function member(userId: string): Promise<WireMember> {
    const res = await call("GET", `/v1/groups/${groupId}/members/${userId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as WireMember;
  }

  async function overridesOf(userId: string) {
    const res = await call("GET", `/v1/groups/${groupId}/members/${userId}/permissions`);
    return ((await res.json()) as { permission: string; grant: boolean }[]).map((o) => [
      o.permission,
      o.grant,
    ]);
  }

  it("creates members with roles, overrides and metadata", async () => {
    const res = await importRows({
      members: [
        {
          userId: "mc:alice",
          roleIds: [roleA, roleB],
          overrides: [{ permission: "fly", value: true }],
          metadata: { prefix: "[VIP]" },
        },
        { userId: "mc:bob" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResult;
    expect(body).toMatchObject({ created: 2, reactivated: 0, updated: 0, unchanged: 0 });
    expect(body.items).toEqual([
      { userId: "mc:alice", status: "created", version: 1 },
      { userId: "mc:bob", status: "created", version: 1 },
    ]);

    const alice = await member("mc:alice");
    expect(alice.status).toBe("active");
    expect([...alice.roles].sort()).toEqual([roleA, roleB].sort());
    expect(alice.metadata).toEqual({ prefix: "[VIP]" });
    expect(await overridesOf("mc:alice")).toEqual([["fly", true]]);

    // Without roleIds a new member holds no roles: the group's default
    // role is never assigned, as on the add route.
    expect((await member("mc:bob")).roles).toEqual([]);
  });

  it("replaces present fields and leaves absent ones untouched", async () => {
    await importRows({
      members: [
        {
          userId: "u1",
          roleIds: [roleA],
          overrides: [
            { permission: "fly", value: true },
            { permission: "build", value: false },
          ],
          metadata: { a: 1 },
        },
      ],
    });
    const res = await importRows({
      members: [
        { userId: "u1", roleIds: [roleB], overrides: [{ permission: "fly", value: false }] },
      ],
    });
    const body = (await res.json()) as ImportResult;
    expect(body.items).toEqual([{ userId: "u1", status: "updated", version: 2 }]);
    const m = await member("u1");
    expect(m.roles).toEqual([roleB]);
    expect(m.metadata).toEqual({ a: 1 });
    expect(await overridesOf("u1")).toEqual([["fly", false]]);

    // An empty list clears; metadata alone replaces only metadata.
    await importRows({ members: [{ userId: "u1", roleIds: [], overrides: [], metadata: {} }] });
    const cleared = await member("u1");
    expect(cleared.roles).toEqual([]);
    expect(cleared.metadata).toEqual({});
    expect(cleared.version).toBe(3);
    expect(await overridesOf("u1")).toEqual([]);
  });

  it("reactivates left, kicked and invited members, keeping roles unless roleIds is sent", async () => {
    for (const u of ["left1", "kicked1", "inv1"]) {
      await call("POST", `/v1/groups/${groupId}/members`, { userId: u });
    }
    await call("POST", `/v1/groups/${groupId}/members/left1/roles/${roleB}`);
    await call("POST", `/v1/groups/${groupId}/leave`, { userId: "left1" });
    await call("POST", `/v1/groups/${groupId}/members/kicked1/kick`);
    const inv = await prisma.externalIdentity.findFirstOrThrow({
      where: { externalUserId: "inv1" },
    });
    await prisma.groupMember.update({
      where: { groupId_junjoUserId: { groupId, junjoUserId: inv.junjoUserId } },
      data: { status: "invited" },
    });

    const res = await importRows({
      members: [{ userId: "left1" }, { userId: "kicked1" }, { userId: "inv1", roleIds: [roleA] }],
    });
    const body = (await res.json()) as ImportResult;
    expect(body.reactivated).toBe(3);
    expect(body.items.map((i) => [i.userId, i.status, i.version])).toEqual([
      ["left1", "reactivated", 4],
      ["kicked1", "reactivated", 3],
      ["inv1", "reactivated", 2],
    ]);
    expect((await member("left1")).status).toBe("active");
    expect((await member("left1")).roles).toEqual([roleB]);
    expect((await member("kicked1")).roles).toEqual([]);
    expect((await member("inv1")).roles).toEqual([roleA]);
  });

  it("reports an identical re-run as unchanged and writes nothing", async () => {
    const rows = {
      members: [
        { userId: "r1", roleIds: [roleA], overrides: [{ permission: "Fly", value: true }] },
        { userId: "r2", metadata: { b: { c: 1, d: 2 } } },
      ],
    };
    await importRows(rows);
    const audits = await prisma.auditEntry.count();
    const events = await prisma.eventLog.count();
    const res = await importRows({
      ...rows,
      // Same metadata with keys in another order is the same value.
      members: [rows.members[0], { userId: "r2", metadata: { b: { d: 2, c: 1 } } }],
    });
    const body = (await res.json()) as ImportResult;
    expect(body).toMatchObject({ created: 0, reactivated: 0, updated: 0, unchanged: 2 });
    expect(body.items.map((i) => i.version)).toEqual([1, 1]);
    expect(await prisma.auditEntry.count()).toBe(audits);
    expect(await prisma.eventLog.count()).toBe(events);
  });

  it("emits the single-call events and audit entries with one memberVersion per member", async () => {
    await call("POST", `/v1/groups/${groupId}/members`, { userId: "e1" });
    await prisma.eventLog.deleteMany({});
    await prisma.auditEntry.deleteMany({});

    await importRows({
      members: [
        {
          userId: "e1",
          roleIds: [roleA],
          metadata: { x: 1 },
          overrides: [{ permission: "p", value: true }],
        },
        { userId: "e2", roleIds: [roleB] },
      ],
      actorUserId: "mod",
    });
    const events = (
      await prisma.eventLog.findMany({ where: { gameId }, orderBy: { seq: "asc" } })
    ).map((r) => r.payload as Record<string, unknown>);
    const summary = events.map((e) => [e.type, e.userId, e.memberVersion]);
    expect(summary).toEqual([
      ["member.joined", "e2", 1],
      ["role.changed", "e1", 2],
      ["role.changed", "e2", 1],
      ["member.updated", "e1", 2],
    ]);
    const joined = events[0] as { member: { roles: string[]; version: number } };
    expect(joined.member).toMatchObject({ roles: [roleB], version: 1 });
    const e1Roles = events[1] as { added: string[]; removed: string[]; actorUserId: string };
    expect(e1Roles).toMatchObject({ added: [roleA], removed: [] });
    expect(e1Roles.actorUserId).toBe("mod");
    expect((events[3] as { changed: string[] }).changed).toEqual(["metadata", "overrides"]);

    const actions = (await prisma.auditEntry.findMany({ orderBy: { createdAt: "asc" } })).map(
      (a) => [a.action, a.targetId],
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        ["role.assigned", "e1"],
        ["permission.override.set", "e1"],
        ["member.metadata.updated", "e1"],
        ["member.joined", "e2"],
        ["role.assigned", "e2"],
      ]),
    );
    expect(actions).toHaveLength(5);
  });

  it("validates every row and reports every failure before writing", async () => {
    await call("POST", "/v1/bans", { userId: "banned1" });
    await prisma.game.update({
      where: { id: gameId },
      data: { config: { identity: { formats: { mc: "uuid" } } } },
    });
    const res = await importRows({
      members: [
        { userId: "ok1" },
        { userId: "mc:not-a-uuid" },
        { userId: "ok2", roleIds: ["role_missing"] },
        { userId: "ok1" },
        { userId: "ok3", overrides: [{ permission: "", value: true }] },
        { userId: "banned1" },
        { userId: "ok4", bogus: true },
        { roleIds: [] },
      ],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("bad_request");
    expect(body.details?.rows.map((r) => [r.index, r.userId, r.code])).toEqual([
      [1, "mc:not-a-uuid", "invalid_user_id"],
      [2, "ok2", "not_found"],
      [3, "ok1", "bad_request"],
      [4, "ok3", "bad_request"],
      [5, "banned1", "banned"],
      [6, "ok4", "bad_request"],
      [7, "", "bad_request"],
    ]);
    expect(await prisma.groupMember.count()).toBe(0);
    expect(await prisma.externalIdentity.count({ where: { externalUserId: "ok1" } })).toBe(0);
  });

  it("answers 403 banned when every failure is a ban", async () => {
    await call("POST", "/v1/bans", { userId: "gb" });
    await call("POST", `/v1/groups/${groupId}/members/grp/ban`);
    const res = await importRows({
      members: [{ userId: "fine" }, { userId: "gb" }, { userId: "grp" }],
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as Envelope;
    expect(body.code).toBe("banned");
    expect(body.details?.rows.map((r) => [r.index, r.code])).toEqual([
      [1, "banned"],
      [2, "banned"],
    ]);
  });

  it("rejects a role from another group", async () => {
    const other = await prisma.group.create({
      data: { gameId, kind: "rank", name: "other", visibility: "public", metadata: {} },
    });
    const foreign = await prisma.role.create({
      data: { groupId: other.id, name: "x", priority: 1 },
    });
    const res = await importRows({ members: [{ userId: "f1", roleIds: [foreign.id] }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).details?.rows[0]?.code).toBe("bad_request");
  });

  it("imports banned people with allowBanned without changing any ban", async () => {
    await call("POST", "/v1/bans", { userId: "gb" });
    await call("POST", `/v1/groups/${groupId}/members`, { userId: "grp" });
    await call("POST", `/v1/groups/${groupId}/members/grp/ban`);
    const res = await importRows({
      allowBanned: true,
      members: [
        { userId: "gb", roleIds: [roleA] },
        { userId: "grp", roleIds: [roleB], metadata: { note: "kept banned" } },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResult;
    expect(body.items.map((i) => [i.userId, i.status])).toEqual([
      ["gb", "created"],
      ["grp", "updated"],
    ]);
    expect((await member("gb")).status).toBe("active");
    const grp = await member("grp");
    expect(grp.status).toBe("banned");
    expect(grp.roles).toEqual([roleB]);
    expect((await call("GET", "/v1/bans/gb")).status).toBe(200);
    expect(await prisma.gameBan.count()).toBe(1);
  });

  it("refuses two ids of the same linked person in one import", async () => {
    await call("POST", `/v1/groups/${groupId}/members`, { userId: "web:1" });
    const person = await prisma.externalIdentity.findFirstOrThrow({
      where: { externalUserId: "web:1" },
    });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: person.junjoUserId, externalUserId: "mc:1" },
    });
    const res = await importRows({ members: [{ userId: "web:1" }, { userId: "mc:1" }] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).details?.rows.map((r) => r.index)).toEqual([1]);
  });

  it("enforces the row cap and the envelope shape", async () => {
    const tooMany = Array.from({ length: MEMBER_IMPORT_MAX_ROWS + 1 }, (_, i) => ({
      userId: `cap${i}`,
    }));
    const res = await importRows({ members: tooMany });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope).details).toBeUndefined();
    expect((await importRows({ members: [] })).status).toBe(400);
    expect((await importRows({ rows: [] })).status).toBe(400);
    expect(
      (
        await call("POST", "/v1/groups/group_missing/members/import", {
          members: [{ userId: "x" }],
        })
      ).status,
    ).toBe(404);
  });

  it("imports the full 500 rows in one call", async () => {
    const members = Array.from({ length: MEMBER_IMPORT_MAX_ROWS }, (_, i) => ({
      userId: `bulk${i}`,
      roleIds: [i % 2 === 0 ? roleA : roleB],
      overrides: [{ permission: `perm.${i % 7}`, value: i % 3 === 0 }],
      metadata: { n: i },
    }));
    const res = await importRows({ members });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ImportResult;
    expect(body.created).toBe(MEMBER_IMPORT_MAX_ROWS);
    expect(await prisma.groupMember.count({ where: { groupId } })).toBe(MEMBER_IMPORT_MAX_ROWS);
    expect(await prisma.eventLog.count({ where: { type: "member.joined" } })).toBe(
      MEMBER_IMPORT_MAX_ROWS,
    );

    const again = await importRows({ members });
    expect(((await again.json()) as ImportResult).unchanged).toBe(MEMBER_IMPORT_MAX_ROWS);
  }, 60_000);

  it("works with an Idempotency-Key", async () => {
    const send = () =>
      app.request(`/v1/groups/${groupId}/members/import`, {
        method: "POST",
        headers: {
          authorization: key,
          "content-type": "application/json",
          "idempotency-key": "import-1",
        },
        body: JSON.stringify({ members: [{ userId: "idem1" }] }),
      });
    const first = await send();
    const second = await send();
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });
});
