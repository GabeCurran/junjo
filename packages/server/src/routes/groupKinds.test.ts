import type { JunjoEvent } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { sweepIdleGroups } from "../groupKinds";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-kinds";
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RolePermission", "GroupMember", "GameBan", "BanHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "Invitation", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface Envelope {
  code: string;
  status: number;
  message: string;
  details?: { rows?: { index: number; userId: string; code: string }[] };
}

describe.skipIf(!TEST_DATABASE_URL)("group kind limits", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let hub: EventHub;
  let key: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Kinds", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    hub = new EventHub();
    app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
  });

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    return app.request(path, {
      method,
      headers: { authorization: key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function patchConfig(config: unknown): Promise<Response> {
    return app.request(`/v1/admin/games/${gameId}/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ config }),
    });
  }

  async function setKinds(kinds: Record<string, unknown>): Promise<void> {
    const res = await patchConfig({ groups: { kinds } });
    expect(res.status).toBe(200);
  }

  async function makeGroup(kind: string, name = kind): Promise<string> {
    const res = await call("POST", "/v1/groups", { kind, name, visibility: "public" });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  const join = (groupId: string, userId: string) =>
    call("POST", `/v1/groups/${groupId}/join`, { userId });
  const add = (groupId: string, userId: string) =>
    call("POST", `/v1/groups/${groupId}/members`, { userId });

  async function invite(groupId: string): Promise<string> {
    const res = await call("POST", `/v1/groups/${groupId}/invitations`, {});
    expect(res.status).toBe(201);
    return ((await res.json()) as { code: string }).code;
  }

  const accept = (code: string, userId: string) =>
    call("POST", `/v1/invitations/${code}/accept`, { userId });

  async function code(res: Response): Promise<string> {
    return ((await res.json()) as Envelope).code;
  }

  async function loggedTypes(): Promise<string[]> {
    const rows = await prisma.eventLog.findMany({ where: { gameId }, orderBy: { seq: "asc" } });
    return rows.map((r) => r.type);
  }

  describe("config", () => {
    it("stores kinds, reads them back and replaces the map as a whole", async () => {
      const first = await patchConfig({
        groups: { kinds: { party: { maxMembers: 8, maxPerUser: 1, deleteWhenEmpty: true } } },
      });
      expect(first.status).toBe(200);
      expect(((await first.json()) as { config: { groups: unknown } }).config.groups).toEqual({
        kinds: { party: { maxMembers: 8, maxPerUser: 1, deleteWhenEmpty: true } },
      });
      const second = await patchConfig({ groups: { kinds: { raid: { idleDeleteHours: 24 } } } });
      expect(((await second.json()) as { config: { groups: unknown } }).config.groups).toEqual({
        kinds: { raid: { idleDeleteHours: 24 } },
      });
      // Other branches stay untouched by a groups patch, and vice versa.
      const third = await patchConfig({ blocks: { enabled: false } });
      expect(((await third.json()) as { config: { groups: unknown } }).config.groups).toEqual({
        kinds: { raid: { idleDeleteHours: 24 } },
      });
    });

    it("defaults to no kinds", async () => {
      const res = await app.request(`/v1/admin/games/${gameId}/config`, {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(((await res.json()) as { config: { groups: unknown } }).config.groups).toEqual({
        kinds: {},
      });
    });

    it("rejects out-of-range values, unknown fields, long kind names and too many kinds", async () => {
      const bad = [
        { party: { maxMembers: 0 } },
        { party: { maxMembers: 100_001 } },
        { party: { maxPerUser: 0 } },
        { party: { maxPerUser: 1001 } },
        { party: { idleDeleteHours: 0 } },
        { party: { idleDeleteHours: 8761 } },
        { party: { maxMembers: 1.5 } },
        { party: { deleteWhenEmpty: "yes" } },
        { party: { other: 1 } },
        { ["k".repeat(65)]: { maxMembers: 1 } },
        { "": { maxMembers: 1 } },
        Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`kind${i}`, {}])),
      ];
      for (const kinds of bad) {
        const res = await patchConfig({ groups: { kinds } });
        expect(res.status, JSON.stringify(kinds).slice(0, 80)).toBe(400);
      }
      const ok = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`kind${i}`, {}]));
      expect((await patchConfig({ groups: { kinds: ok } })).status).toBe(200);
    });
  });

  describe("maxMembers", () => {
    beforeEach(async () => {
      await setKinds({ party: { maxMembers: 2 } });
    });

    it("applies on join, add and invitation accept", async () => {
      const party = await makeGroup("party");
      expect((await join(party, "a")).status).toBe(201);
      expect((await add(party, "b")).status).toBe(201);
      const full = await join(party, "c");
      expect(full.status).toBe(409);
      expect(await code(full)).toBe("group_full");
      expect(await code(await add(party, "c"))).toBe("group_full");
      const inviteCode = await invite(party);
      const accepted = await accept(inviteCode, "c");
      expect(accepted.status).toBe(409);
      expect(await code(accepted)).toBe("group_full");
      // The refused accept leaves the invitation unused.
      const inv = await prisma.invitation.findUniqueOrThrow({ where: { code: inviteCode } });
      expect(inv.usedAt).toBeNull();
      // Re-adding an active member is not a new activation.
      expect((await add(party, "a")).status).toBe(200);
      // Room frees up when someone leaves.
      expect((await call("POST", `/v1/groups/${party}/leave`, { userId: "a" })).status).toBe(200);
      expect((await accept(inviteCode, "c")).status).toBe(201);
    });

    it("fails import rows beyond the cap with group_full in details.rows", async () => {
      const party = await makeGroup("party");
      await join(party, "a");
      const res = await call("POST", `/v1/groups/${party}/members/import`, {
        members: [{ userId: "a" }, { userId: "b" }, { userId: "c" }, { userId: "d" }],
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("group_full");
      expect(body.details?.rows?.map((r) => [r.index, r.userId, r.code])).toEqual([
        [2, "c", "group_full"],
        [3, "d", "group_full"],
      ]);
      expect(await prisma.groupMember.count({ where: { groupId: party } })).toBe(1);
      const ok = await call("POST", `/v1/groups/${party}/members/import`, {
        members: [{ userId: "a" }, { userId: "b" }],
      });
      expect(ok.status).toBe(200);
    });

    it("answers 400 when import failures mix codes", async () => {
      const party = await makeGroup("party");
      await join(party, "a");
      await join(party, "b");
      const res = await call("POST", `/v1/groups/${party}/members/import`, {
        members: [{ userId: "c" }, { userId: "d", roleIds: ["missing"] }],
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.details?.rows?.map((r) => r.code)).toEqual(["group_full", "not_found"]);
    });

    it("admits exactly the cap under concurrent joins", async () => {
      await setKinds({ party: { maxMembers: 1 } });
      const party = await makeGroup("party");
      const results = await Promise.all(["a", "b", "c", "d"].map((u) => join(party, u)));
      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
      expect(await prisma.groupMember.count({ where: { groupId: party, status: "active" } })).toBe(
        1,
      );
    });

    it("leaves kinds that are not listed unlimited", async () => {
      const guild = await makeGroup("guild");
      for (const u of ["a", "b", "c", "d"]) expect((await join(guild, u)).status).toBe(201);
    });
  });

  describe("maxPerUser", () => {
    beforeEach(async () => {
      await setKinds({ party: { maxPerUser: 1 } });
    });

    it("applies on join, add, invitation accept, import and creation with a creator", async () => {
      const p1 = await makeGroup("party", "p1");
      const p2 = await makeGroup("party", "p2");
      expect((await join(p1, "a")).status).toBe(201);
      const second = await join(p2, "a");
      expect(second.status).toBe(409);
      expect(await code(second)).toBe("group_limit_reached");
      expect(await code(await add(p2, "a"))).toBe("group_limit_reached");
      expect(await code(await accept(await invite(p2), "a"))).toBe("group_limit_reached");

      const imported = await call("POST", `/v1/groups/${p2}/members/import`, {
        members: [{ userId: "a" }, { userId: "b" }],
      });
      expect(imported.status).toBe(409);
      const body = (await imported.json()) as Envelope;
      expect(body.code).toBe("group_limit_reached");
      expect(body.details?.rows?.map((r) => [r.index, r.code])).toEqual([
        [0, "group_limit_reached"],
      ]);

      const created = await call("POST", "/v1/groups", {
        kind: "party",
        name: "p3",
        creatorUserId: "a",
      });
      expect(created.status).toBe(409);
      expect(await code(created)).toBe("group_limit_reached");
      expect(await prisma.group.count({ where: { name: "p3" } })).toBe(0);
    });

    it("counts only live groups of the same kind", async () => {
      const p1 = await makeGroup("party", "p1");
      const p2 = await makeGroup("party", "p2");
      const guild = await makeGroup("guild");
      await join(p1, "a");
      expect((await join(guild, "a")).status).toBe(201);
      expect((await call("DELETE", `/v1/groups/${p1}`)).status).toBe(200);
      expect((await join(p2, "a")).status).toBe(201);
    });

    it("lets a person rejoin after leaving", async () => {
      const p1 = await makeGroup("party", "p1");
      const p2 = await makeGroup("party", "p2");
      await join(p1, "a");
      await call("POST", `/v1/groups/${p1}/leave`, { userId: "a" });
      expect((await join(p2, "a")).status).toBe(201);
    });

    it("admits one of two concurrent joins of one person to two groups", async () => {
      const p1 = await makeGroup("party", "p1");
      const p2 = await makeGroup("party", "p2");
      const [r1, r2] = await Promise.all([join(p1, "a"), join(p2, "a")]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
    });
  });

  describe("deleteWhenEmpty", () => {
    beforeEach(async () => {
      await setKinds({ party: { deleteWhenEmpty: true } });
    });

    async function isDeleted(groupId: string): Promise<boolean> {
      const g = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
      return g.softDeletedAt !== null;
    }

    it("soft-deletes the group when the last member leaves and stages group.deleted", async () => {
      const party = await makeGroup("party");
      await join(party, "a");
      await join(party, "b");
      const seen: JunjoEvent[] = [];
      hub.subscribe(party as never, (e) => seen.push(e));
      await call("POST", `/v1/groups/${party}/leave`, { userId: "a" });
      expect(await isDeleted(party)).toBe(false);
      const res = await call("POST", `/v1/groups/${party}/leave`, { userId: "b" });
      expect(res.status).toBe(200);
      expect(await isDeleted(party)).toBe(true);
      expect((await loggedTypes()).slice(-2)).toEqual(["member.left", "group.deleted"]);
      expect(seen.map((e) => e.type)).toEqual(["member.left", "member.left", "group.deleted"]);
      const audit = await prisma.auditEntry.findFirstOrThrow({
        where: { groupId: party, action: "group.deleted" },
      });
      expect(audit.payload).toMatchObject({ kind: "soft", reason: "empty" });
    });

    it("applies on kick and on ban of the last active member", async () => {
      const kicked = await makeGroup("party", "k");
      await join(kicked, "a");
      expect((await call("POST", `/v1/groups/${kicked}/members/a/kick`, {})).status).toBe(200);
      expect(await isDeleted(kicked)).toBe(true);

      const banned = await makeGroup("party", "b");
      await join(banned, "a");
      expect((await call("POST", `/v1/groups/${banned}/members/a/ban`, {})).status).toBe(200);
      expect(await isDeleted(banned)).toBe(true);
    });

    it("applies on the admin kick", async () => {
      const party = await makeGroup("party");
      await join(party, "a");
      const res = await app.request(`/v1/admin/games/${gameId}/groups/${party}/members/a/kick`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(await isDeleted(party)).toBe(true);
    });

    it("does not delete when the write removed no active member", async () => {
      const party = await makeGroup("party");
      // Banning someone who was never a member leaves the (empty) group.
      expect((await call("POST", `/v1/groups/${party}/members/z/ban`, {})).status).toBe(200);
      expect(await isDeleted(party)).toBe(false);
    });

    it("leaves kinds without the flag alone", async () => {
      const guild = await makeGroup("guild");
      await join(guild, "a");
      await call("POST", `/v1/groups/${guild}/leave`, { userId: "a" });
      expect(await isDeleted(guild)).toBe(false);
    });
  });

  describe("idle sweeper", () => {
    const HOUR = 60 * 60 * 1000;

    it("bumps memberActivityAt on membership changes but not on group edits", async () => {
      const guild = await makeGroup("guild");
      const old = new Date(Date.now() - 10 * HOUR);
      await prisma.group.update({ where: { id: guild }, data: { memberActivityAt: old } });
      await call("PATCH", `/v1/groups/${guild}`, { name: "renamed" });
      let g = await prisma.group.findUniqueOrThrow({ where: { id: guild } });
      expect(g.memberActivityAt.getTime()).toBe(old.getTime());
      await join(guild, "a");
      g = await prisma.group.findUniqueOrThrow({ where: { id: guild } });
      expect(Date.now() - g.memberActivityAt.getTime()).toBeLessThan(60_000);
    });

    it("soft-deletes idle live groups of kinds that set idleDeleteHours", async () => {
      await setKinds({ party: { idleDeleteHours: 24 } });
      const idle = await makeGroup("party", "idle");
      await makeGroup("party", "fresh");
      const guild = await makeGroup("guild", "guild");
      await join(idle, "a");
      const old = new Date(Date.now() - 25 * HOUR);
      await prisma.group.updateMany({
        where: { id: { in: [idle, guild] } },
        data: { memberActivityAt: old },
      });

      const sweepHub = new EventHub();
      const published: JunjoEvent[] = [];
      sweepHub.subscribeGame(gameId, (e) => published.push(e));
      expect(await sweepIdleGroups(prisma, sweepHub)).toBe(1);

      const rows = await prisma.group.findMany({ orderBy: { name: "asc" } });
      expect(rows.map((r) => [r.name, r.softDeletedAt !== null])).toEqual([
        ["fresh", false],
        ["guild", false],
        ["idle", true],
      ]);
      expect(published.map((e) => [e.type, "groupId" in e ? e.groupId : null])).toEqual([
        ["group.deleted", idle],
      ]);
      expect(await loggedTypes()).toContain("group.deleted");
      const audit = await prisma.auditEntry.findFirstOrThrow({
        where: { groupId: idle, action: "group.deleted" },
      });
      expect(audit.payload).toMatchObject({ reason: "idle" });
      // A second pass finds nothing more.
      expect(await sweepIdleGroups(prisma, sweepHub)).toBe(0);
    });

    it("gives a restored group a fresh idle period", async () => {
      await setKinds({ party: { idleDeleteHours: 1 } });
      const party = await makeGroup("party");
      await prisma.group.update({
        where: { id: party },
        data: { memberActivityAt: new Date(Date.now() - 2 * HOUR) },
      });
      expect(await sweepIdleGroups(prisma, new EventHub())).toBe(1);
      expect((await call("POST", `/v1/groups/${party}/restore`)).status).toBe(200);
      expect(await sweepIdleGroups(prisma, new EventHub())).toBe(0);
    });
  });

  describe("merges and restores", () => {
    async function link(issuer: string, redeemer: string): Promise<Response> {
      const issued = await call("POST", `/v1/users/${encodeURIComponent(issuer)}/link-codes`);
      expect(issued.status).toBeLessThan(300);
      const { code: linkCode } = (await issued.json()) as { code: string };
      return call("POST", "/v1/link-codes/redeem", { code: linkCode, userId: redeemer });
    }

    it("refuses a link whose merged person would exceed maxPerUser", async () => {
      await setKinds({ party: { maxPerUser: 1 } });
      const a = await makeGroup("party", "A");
      const b = await makeGroup("party", "B");
      expect((await join(a, "mc:one")).status).toBe(201);
      expect((await join(b, "web:one")).status).toBe(201);
      const res = await link("mc:one", "web:one");
      expect(res.status).toBe(409);
      const body = (await res.json()) as Envelope & { details?: Record<string, unknown> };
      expect(body.code).toBe("link_refused");
      expect(body.details).toEqual({ reason: "group_limit_reached", kinds: ["party"] });
      // Nothing moved: each id still names its own person.
      const ids = await call("GET", "/v1/users/mc%3Aone/identities");
      expect(((await ids.json()) as { items: unknown[] }).items).toHaveLength(1);
    });

    it("allows the link when both sides share the group or the kind has room", async () => {
      await setKinds({ party: { maxPerUser: 2 }, raid: { maxPerUser: 1 } });
      const a = await makeGroup("party", "A");
      const b = await makeGroup("party", "B");
      const r = await makeGroup("raid", "R");
      expect((await join(a, "mc:two")).status).toBe(201);
      expect((await join(b, "web:two")).status).toBe(201);
      expect((await join(r, "mc:two")).status).toBe(201);
      expect((await join(r, "web:two")).status).toBe(201);
      // party: two groups against a cap of 2; raid: one shared group.
      expect((await link("mc:two", "web:two")).status).toBeLessThan(300);
    });

    it("refuses a restore that would put a member over maxPerUser", async () => {
      await setKinds({ party: { maxPerUser: 1 } });
      const a = await makeGroup("party", "A");
      expect((await join(a, "p1")).status).toBe(201);
      expect((await call("DELETE", `/v1/groups/${a}`)).status).toBeLessThan(300);
      const b = await makeGroup("party", "B");
      expect((await join(b, "p1")).status).toBe(201);
      const res = await call("POST", `/v1/groups/${a}/restore`);
      expect(res.status).toBe(409);
      expect(await code(res)).toBe("group_limit_reached");
      const row = await prisma.group.findUniqueOrThrow({ where: { id: a } });
      expect(row.softDeletedAt).not.toBeNull();
      // Once the member leaves the other group the restore goes through.
      expect((await call("POST", `/v1/groups/${b}/leave`, { userId: "p1" })).status).toBe(200);
      expect((await call("POST", `/v1/groups/${a}/restore`)).status).toBe(200);
    });
  });
});
