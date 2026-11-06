import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { loggedEvents } from "../testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-safe-writes";
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "GameBan", "BanHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "Invitation", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface WireMember {
  id: string;
  userId: string;
  status: string;
  roles: string[];
  version: number;
}

interface Envelope {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

describe.skipIf(!TEST_DATABASE_URL)("versions and conditional writes", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let gameId: string;
  let groupId: string;
  let roleId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Safe writes", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    const group = await prisma.group.create({
      data: { gameId, kind: "guild", name: "g", visibility: "public", metadata: {} },
    });
    groupId = group.id;
    const role = await prisma.role.create({ data: { groupId, name: "vip", priority: 5 } });
    roleId = role.id;
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; ifMatch?: string; auth?: string } = {},
  ) {
    const headers: Record<string, string> = {
      authorization: opts.auth ?? key,
      "content-type": "application/json",
    };
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    return app.request(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  async function addMember(userId: string): Promise<WireMember> {
    const res = await call("POST", `/v1/groups/${groupId}/members`, { body: { userId } });
    expect(res.status).toBe(201);
    return (await res.json()) as WireMember;
  }

  async function version(userId: string): Promise<number> {
    const res = await call("GET", `/v1/groups/${groupId}/members/${userId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WireMember;
    expect(res.headers.get("etag")).toBe(`"${body.version}"`);
    return body.version;
  }

  // Each member-scoped route with If-Match: the request that changes the
  // member, given the member's userId.
  const memberRoutes: {
    name: string;
    send: (userId: string, ifMatch?: string) => Promise<Response>;
    // The route answers with a Member body.
    returnsMember: boolean;
  }[] = [
    {
      name: "PATCH member",
      send: (u, m) =>
        call("PATCH", `/v1/groups/${groupId}/members/${u}`, {
          body: { notesPublic: `n-${Math.random()}` },
          ifMatch: m,
        }),
      returnsMember: true,
    },
    {
      name: "role assign",
      send: (u, m) =>
        call("POST", `/v1/groups/${groupId}/members/${u}/roles/${roleId}`, { ifMatch: m }),
      returnsMember: true,
    },
    {
      name: "override set",
      send: (u, m) =>
        call("POST", `/v1/groups/${groupId}/members/${u}/permissions/fly`, {
          body: { grant: true },
          ifMatch: m,
        }),
      returnsMember: false,
    },
    {
      name: "kick",
      send: (u, m) => call("POST", `/v1/groups/${groupId}/members/${u}/kick`, { ifMatch: m }),
      returnsMember: true,
    },
    {
      name: "group ban",
      send: (u, m) => call("POST", `/v1/groups/${groupId}/members/${u}/ban`, { ifMatch: m }),
      returnsMember: true,
    },
  ];

  describe("member versions", () => {
    it("starts at 1 and appears on reads, lists, access and the member by id", async () => {
      const added = await addMember("alice");
      expect(added.version).toBe(1);
      expect(await version("alice")).toBe(1);

      const list = await call("GET", `/v1/groups/${groupId}/members`);
      const items = ((await list.json()) as { items: WireMember[] }).items;
      expect(items[0]?.version).toBe(1);

      const access = await call("GET", `/v1/groups/${groupId}/members/alice/access`);
      expect(access.headers.get("etag")).toBe('"1"');
      expect(((await access.json()) as { version: number }).version).toBe(1);

      const byId = await call("GET", `/v1/members/${added.id}`);
      expect(byId.headers.get("etag")).toBe('"1"');
      expect(((await byId.json()) as WireMember).version).toBe(1);

      const forUser = await call("GET", "/v1/users/alice/members");
      expect(((await forUser.json()) as WireMember[])[0]?.version).toBe(1);
    });

    for (const route of memberRoutes) {
      it(`${route.name} bumps the version by one and sets ETag`, async () => {
        await addMember("bob");
        const res = await route.send("bob");
        expect(res.status).toBe(200);
        expect(res.headers.get("etag")).toBe('"2"');
        if (route.returnsMember) expect(((await res.json()) as WireMember).version).toBe(2);
        expect(await version("bob")).toBe(2);
      });

      it(`${route.name} answers 412 on a stale If-Match and writes nothing`, async () => {
        await addMember("carol");
        const before = await prisma.auditEntry.count();
        const res = await route.send("carol", '"7"');
        expect(res.status).toBe(412);
        expect(((await res.json()) as Envelope).code).toBe("precondition_failed");
        expect(await version("carol")).toBe(1);
        expect(await prisma.auditEntry.count()).toBe(before);
      });

      it(`${route.name} accepts a matching quoted or bare If-Match`, async () => {
        await addMember("dave");
        await addMember("erin");
        expect((await route.send("dave", '"1"')).status).toBe(200);
        expect((await route.send("erin", "1")).status).toBe(200);
        expect(await version("dave")).toBe(2);
        expect(await version("erin")).toBe(2);
      });
    }

    it("role unassign, override clear and group unban honour If-Match and bump", async () => {
      await addMember("frank");
      await call("POST", `/v1/groups/${groupId}/members/frank/roles/${roleId}`);
      await call("POST", `/v1/groups/${groupId}/members/frank/permissions/fly`, {
        body: { grant: true },
      });
      expect(await version("frank")).toBe(3);

      const stale = await call("DELETE", `/v1/groups/${groupId}/members/frank/roles/${roleId}`, {
        ifMatch: '"1"',
      });
      expect(stale.status).toBe(412);
      const unassign = await call("DELETE", `/v1/groups/${groupId}/members/frank/roles/${roleId}`, {
        ifMatch: '"3"',
      });
      expect(unassign.status).toBe(200);
      expect(unassign.headers.get("etag")).toBe('"4"');

      expect(
        (
          await call("DELETE", `/v1/groups/${groupId}/members/frank/permissions/fly`, {
            ifMatch: "3",
          })
        ).status,
      ).toBe(412);
      const clear = await call("DELETE", `/v1/groups/${groupId}/members/frank/permissions/fly`, {
        ifMatch: "4",
      });
      expect(clear.status).toBe(204);
      expect(clear.headers.get("etag")).toBe('"5"');

      await call("POST", `/v1/groups/${groupId}/members/frank/ban`);
      expect(await version("frank")).toBe(6);
      expect(
        (await call("DELETE", `/v1/groups/${groupId}/members/frank/ban`, { ifMatch: '"5"' }))
          .status,
      ).toBe(412);
      const unban = await call("DELETE", `/v1/groups/${groupId}/members/frank/ban`, {
        ifMatch: '"6"',
      });
      expect(unban.status).toBe(200);
      expect(((await unban.json()) as WireMember).version).toBe(7);
    });

    it("leaves the version alone on no-op writes", async () => {
      await addMember("gina");
      await call("POST", `/v1/groups/${groupId}/members/gina/roles/${roleId}`);
      await call("POST", `/v1/groups/${groupId}/members/gina/permissions/fly`, {
        body: { grant: true },
      });
      expect(await version("gina")).toBe(3);

      // Repeats of the same changes, and removals of things not held.
      const noops = [
        call("POST", `/v1/groups/${groupId}/members/gina/roles/${roleId}`),
        call("POST", `/v1/groups/${groupId}/members/gina/permissions/fly`, {
          body: { grant: true },
        }),
        call("DELETE", `/v1/groups/${groupId}/members/gina/permissions/build`),
        call("DELETE", `/v1/groups/${groupId}/members/gina/roles/role_missing`),
        call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "gina" } }),
      ];
      for (const res of await Promise.all(noops)) expect(res.status).toBeLessThan(300);
      expect(await version("gina")).toBe(3);

      await call("POST", `/v1/groups/${groupId}/members/gina/kick`);
      expect(await version("gina")).toBe(4);
      await call("POST", `/v1/groups/${groupId}/members/gina/kick`);
      expect(await version("gina")).toBe(4);
    });

    it("checks If-Match on no-op paths too", async () => {
      await addMember("hal");
      await call("POST", `/v1/groups/${groupId}/members/hal/kick`);
      const res = await call("POST", `/v1/groups/${groupId}/members/hal/kick`, { ifMatch: '"1"' });
      expect(res.status).toBe(412);
      const ok = await call("POST", `/v1/groups/${groupId}/members/hal/kick`, { ifMatch: '"2"' });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("etag")).toBe('"2"');
    });

    it("bumps on join, leave, rejoin, add with a role and invitation accept", async () => {
      const join = await call("POST", `/v1/groups/${groupId}/join`, { body: { userId: "ivy" } });
      expect(((await join.json()) as WireMember).version).toBe(1);
      const leave = await call("POST", `/v1/groups/${groupId}/leave`, { body: { userId: "ivy" } });
      expect(((await leave.json()) as WireMember).version).toBe(2);
      const rejoin = await call("POST", `/v1/groups/${groupId}/join`, { body: { userId: "ivy" } });
      expect(((await rejoin.json()) as WireMember).version).toBe(3);

      // Already active: adding a role is one change.
      const add = await call("POST", `/v1/groups/${groupId}/members`, {
        body: { userId: "ivy", roleId },
      });
      expect(((await add.json()) as WireMember).version).toBe(4);

      // A new member with a role in one call is still one version.
      const fresh = await call("POST", `/v1/groups/${groupId}/members`, {
        body: { userId: "jay", roleId },
      });
      expect(((await fresh.json()) as WireMember).version).toBe(1);

      await call("POST", `/v1/groups/${groupId}/leave`, { body: { userId: "jay" } });
      const inv = await call("POST", `/v1/groups/${groupId}/invitations`, { body: {} });
      const { code } = (await inv.json()) as { code: string };
      const accept = await call("POST", `/v1/invitations/${code}/accept`, {
        body: { userId: "jay" },
      });
      expect(accept.status).toBe(201);
      expect(accept.headers.get("etag")).toBe('"3"');
      expect(((await accept.json()) as WireMember).version).toBe(3);
    });

    it("bumps on dashboard kick, member PATCH and override writes", async () => {
      await addMember("kim");
      const admin = `Bearer ${ADMIN_TOKEN}`;
      const base = `/v1/admin/games/${gameId}/groups/${groupId}/members/kim`;
      await call("PATCH", base, { body: { notesPrivate: "x" }, auth: admin });
      expect(await version("kim")).toBe(2);
      await call("POST", `${base}/permissions/fly`, { body: { grant: false }, auth: admin });
      expect(await version("kim")).toBe(3);
      await call("DELETE", `${base}/permissions/fly`, { auth: admin });
      expect(await version("kim")).toBe(4);
      await call("POST", `${base}/kick`, { auth: admin });
      expect(await version("kim")).toBe(5);
    });

    it("does not bump on role-level edits", async () => {
      await addMember("lee");
      await call("POST", `/v1/groups/${groupId}/members/lee/roles/${roleId}`);
      expect(await version("lee")).toBe(2);
      await call("POST", `/v1/roles/${roleId}/permissions`, { body: { permission: "chat" } });
      await call("PATCH", `/v1/roles/${roleId}`, { body: { priority: 9 } });
      expect(await version("lee")).toBe(2);
    });

    it("rejects malformed If-Match with 400", async () => {
      await addMember("max");
      for (const bad of ['W/"1"', "*", '"1", "2"', '"abc"', "-1", '"1']) {
        const res = await call("PATCH", `/v1/groups/${groupId}/members/max`, {
          body: { notesPublic: "x" },
          ifMatch: bad,
        });
        expect(res.status).toBe(400);
        expect(((await res.json()) as Envelope).code).toBe("bad_request");
      }
      expect(await version("max")).toBe(1);
    });

    it("answers 404, not 412, for a missing member", async () => {
      const res = await call("PATCH", `/v1/groups/${groupId}/members/nobody`, {
        body: { notesPublic: "x" },
        ifMatch: '"1"',
      });
      expect(res.status).toBe(404);
    });

    it("accepts `value` as an alias of `grant` on override set", async () => {
      await addMember("ned");
      const res = await call("POST", `/v1/groups/${groupId}/members/ned/permissions/fly`, {
        body: { value: false },
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as { grant: boolean }).grant).toBe(false);
      const clash = await call("POST", `/v1/groups/${groupId}/members/ned/permissions/fly`, {
        body: { value: false, grant: true },
      });
      expect(clash.status).toBe(400);
      const none = await call("POST", `/v1/groups/${groupId}/members/ned/permissions/fly`, {
        body: {},
      });
      expect(none.status).toBe(400);
    });
  });

  describe("memberVersion on events", () => {
    it("carries the version after the write on every member event", async () => {
      await addMember("olga");
      await call("POST", `/v1/groups/${groupId}/members/olga/roles/${roleId}`);
      await call("PATCH", `/v1/groups/${groupId}/members/olga`, { body: { metadata: { a: 1 } } });
      await call("POST", `/v1/groups/${groupId}/members/olga/ban`);
      await call("DELETE", `/v1/groups/${groupId}/members/olga/ban`);
      await call("POST", `/v1/groups/${groupId}/join`, { body: { userId: "olga" } });
      await call("POST", `/v1/groups/${groupId}/leave`, { body: { userId: "olga" } });

      const seen = (await loggedEvents(prisma, gameId)).map((e) => [e.type, e.memberVersion]);
      expect(seen).toEqual([
        ["member.joined", 1],
        ["role.changed", 2],
        ["member.updated", 3],
        ["member.banned", 4],
        ["member.unbanned", 5],
        ["member.joined", 6],
        ["member.left", 7],
      ]);
      const joined = (await loggedEvents(prisma, gameId, "member.joined"))[1] as {
        member: { version: number };
      };
      expect(joined.member.version).toBe(6);
    });

    it("shares one memberVersion across the events of one add, and the snapshot is complete", async () => {
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "pat" } });
      await call("POST", `/v1/groups/${groupId}/leave`, { body: { userId: "pat" } });
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "pat", roleId } });
      const tail = (await loggedEvents(prisma, gameId)).slice(-2) as {
        type: string;
        memberVersion: number;
        member?: { roles: string[]; version: number };
      }[];
      expect(tail.map((e) => [e.type, e.memberVersion])).toEqual([
        ["member.joined", 3],
        ["role.changed", 3],
      ]);
      expect(tail[0]?.member?.roles).toEqual([roleId]);
      expect(tail[0]?.member?.version).toBe(3);
    });

    it("carries memberVersion on override and kick events", async () => {
      await addMember("quinn");
      await call("POST", `/v1/groups/${groupId}/members/quinn/permissions/fly`, {
        body: { grant: true },
      });
      await call("POST", `/v1/groups/${groupId}/members/quinn/kick`);
      const seen = (await loggedEvents(prisma, gameId)).map((e) => [e.type, e.memberVersion]);
      expect(seen).toEqual([
        ["member.joined", 1],
        ["member.updated", 2],
        ["member.left", 3],
      ]);
    });
  });

  describe("moderation version", () => {
    async function moderation(userId: string) {
      const res = await call("GET", `/v1/users/${userId}/moderation`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        userId: string;
        version: number;
        ban: { reason: string | null; version: number; issuer: string | null } | null;
      };
      expect(res.headers.get("etag")).toBe(`"${body.version}"`);
      return body;
    }

    it("answers version 0 and no ban for unknown and never-moderated people", async () => {
      expect(await moderation("ghost")).toEqual({
        userId: "ghost",
        version: 0,
        ban: null,
        sanctions: [],
      });
      await addMember("rita");
      expect(await moderation("rita")).toEqual({
        userId: "rita",
        version: 0,
        ban: null,
        sanctions: [],
      });
    });

    it("bumps on ban create, change and lift, and shows it on ban objects and events", async () => {
      const created = await call("POST", "/v1/bans", { body: { userId: "sam", reason: "a" } });
      expect(created.status).toBe(201);
      expect(created.headers.get("etag")).toBe('"1"');
      expect(((await created.json()) as { version: number }).version).toBe(1);

      const changed = await call("POST", "/v1/bans", { body: { userId: "sam", reason: "b" } });
      expect(((await changed.json()) as { version: number }).version).toBe(2);

      const one = await call("GET", "/v1/bans/sam");
      expect(one.headers.get("etag")).toBe('"2"');
      expect(((await one.json()) as { version: number }).version).toBe(2);
      const list = await call("GET", "/v1/bans");
      expect(((await list.json()) as { items: { version: number }[] }).items[0]?.version).toBe(2);

      const state = await moderation("sam");
      expect(state.version).toBe(2);
      expect(state.ban?.reason).toBe("b");
      expect(state.ban?.version).toBe(2);

      const lifted = await call("DELETE", "/v1/bans/sam");
      expect(lifted.status).toBe(204);
      expect(lifted.headers.get("etag")).toBe('"3"');
      expect(await moderation("sam")).toEqual({
        userId: "sam",
        version: 3,
        ban: null,
        sanctions: [],
      });

      const seen = (await loggedEvents(prisma, gameId)).map((e) => [e.type, e.moderationVersion]);
      expect(seen).toEqual([
        ["game.user.banned", 1],
        ["game.user.banned", 2],
        ["game.user.unbanned", 3],
      ]);
    });

    it("refuses a stale If-Match on ban create and lift", async () => {
      await call("POST", "/v1/bans", { body: { userId: "tess" } });
      const staleBan = await call("POST", "/v1/bans", {
        body: { userId: "tess", reason: "x" },
        ifMatch: '"0"',
      });
      expect(staleBan.status).toBe(412);
      expect(((await staleBan.json()) as Envelope).code).toBe("precondition_failed");

      // A queued lift from before a re-ban is refused.
      await call("DELETE", "/v1/bans/tess", { ifMatch: '"1"' });
      await call("POST", "/v1/bans", { body: { userId: "tess", reason: "again" } });
      const staleLift = await call("DELETE", "/v1/bans/tess", { ifMatch: '"2"' });
      expect(staleLift.status).toBe(412);
      expect((await moderation("tess")).ban?.reason).toBe("again");

      const lift = await call("DELETE", "/v1/bans/tess", { ifMatch: "3" });
      expect(lift.status).toBe(204);
      expect((await moderation("tess")).version).toBe(4);

      const firstBan = await call("POST", "/v1/bans", { body: { userId: "uma" }, ifMatch: '"0"' });
      expect(firstBan.status).toBe(201);
      expect(
        (await call("POST", "/v1/bans", { body: { userId: "vic" }, ifMatch: "bogus" })).status,
      ).toBe(400);
    });

    it("does not bump for group bans", async () => {
      await addMember("wes");
      await call("POST", `/v1/groups/${groupId}/members/wes/ban`);
      expect((await moderation("wes")).version).toBe(0);
    });
  });

  describe("not-active lifts", () => {
    it("game unban: not_active for a lifted ban and an unknown user", async () => {
      await call("POST", "/v1/bans", { body: { userId: "xena" } });
      expect((await call("DELETE", "/v1/bans/xena")).status).toBe(204);
      for (const userId of ["xena", "never-seen"]) {
        const res = await call("DELETE", `/v1/bans/${userId}`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as Envelope;
        expect(body.code).toBe("not_found");
        expect(body.details).toEqual({ reason: "not_active" });
      }
    });

    it("game unban: not_active wins over a stale If-Match", async () => {
      await call("POST", "/v1/bans", { body: { userId: "yuri" } });
      await call("DELETE", "/v1/bans/yuri");
      const res = await call("DELETE", "/v1/bans/yuri", { ifMatch: '"1"' });
      expect(res.status).toBe(404);
      expect(((await res.json()) as Envelope).details).toEqual({ reason: "not_active" });
    });

    it("group unban: not_active for a member not banned and an unknown user", async () => {
      await addMember("zed");
      for (const userId of ["zed", "never-seen"]) {
        const res = await call("DELETE", `/v1/groups/${groupId}/members/${userId}/ban`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as Envelope;
        expect(body.code).toBe("not_found");
        expect(body.details).toEqual({ reason: "not_active" });
      }
    });

    it("group unban: an unknown group has no reason", async () => {
      await addMember("abe");
      await call("POST", `/v1/groups/${groupId}/members/abe/ban`);
      const res = await call("DELETE", "/v1/groups/group_missing/members/abe/ban");
      expect(res.status).toBe(404);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("not_found");
      expect(body.details).toBeUndefined();
    });

    it("other 404s carry no details", async () => {
      const res = await call("GET", "/v1/bans/never-seen");
      expect(res.status).toBe(404);
      expect(((await res.json()) as Envelope).details).toBeUndefined();
    });
  });

  describe("ban import fields", () => {
    it("stores bannedAt and issuer on the ban and its history row", async () => {
      const bannedAt = "2024-03-01T12:00:00.000Z";
      const res = await call("POST", "/v1/bans", {
        body: { userId: "bea", bannedAt, issuer: "OldStaff#1", reason: "grief" },
      });
      expect(res.status).toBe(201);
      const ban = (await res.json()) as { bannedAt: string; issuer: string | null };
      expect(ban.bannedAt).toBe(bannedAt);
      expect(ban.issuer).toBe("OldStaff#1");

      const history = await call("GET", "/v1/bans/bea/history");
      const items = (
        (await history.json()) as {
          items: { eventAt: string; issuer: string | null; kind: string }[];
        }
      ).items;
      expect(items[0]).toMatchObject({ kind: "set", eventAt: bannedAt, issuer: "OldStaff#1" });

      const fetched = await call("GET", "/v1/bans/bea");
      expect(((await fetched.json()) as { issuer: string }).issuer).toBe("OldStaff#1");
    });

    it("accepts issuer and actorUserId together", async () => {
      const res = await call("POST", "/v1/bans", {
        body: { userId: "cy", issuer: "console", actorUserId: "mod1" },
      });
      const ban = (await res.json()) as { issuer: string; bannedBy: string };
      expect(ban).toMatchObject({ issuer: "console", bannedBy: "mod1" });
    });

    it("lets an explicit bannedAt replace an active ban's start", async () => {
      await call("POST", "/v1/bans", { body: { userId: "dee" } });
      const bannedAt = "2023-01-01T00:00:00.000Z";
      const res = await call("POST", "/v1/bans", { body: { userId: "dee", bannedAt } });
      expect(((await res.json()) as { bannedAt: string }).bannedAt).toBe(bannedAt);
    });

    it("rejects a bannedAt more than 60 seconds ahead, and bad issuers", async () => {
      const soon = new Date(Date.now() + 30_000).toISOString();
      expect(
        (await call("POST", "/v1/bans", { body: { userId: "eve", bannedAt: soon } })).status,
      ).toBe(201);
      const later = new Date(Date.now() + 120_000).toISOString();
      expect(
        (await call("POST", "/v1/bans", { body: { userId: "fay", bannedAt: later } })).status,
      ).toBe(400);
      expect(
        (await call("POST", "/v1/bans", { body: { userId: "fay", bannedAt: "yesterday-ish" } }))
          .status,
      ).toBe(400);
      expect((await call("POST", "/v1/bans", { body: { userId: "fay", issuer: "" } })).status).toBe(
        400,
      );
      expect(
        (await call("POST", "/v1/bans", { body: { userId: "fay", issuer: "x".repeat(129) } }))
          .status,
      ).toBe(400);
    });

    it("keeps a past expiresAt creating an already-expired ban", async () => {
      const res = await call("POST", "/v1/bans", {
        body: {
          userId: "gus",
          bannedAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-02-01T00:00:00.000Z",
        },
      });
      expect(res.status).toBe(201);
      expect((await call("GET", "/v1/bans/gus")).status).toBe(404);
    });

    it("returns issuer null on group history rows", async () => {
      await addMember("hank");
      await call("POST", `/v1/groups/${groupId}/members/hank/ban`);
      const history = await call("GET", `/v1/groups/${groupId}/bans/history`);
      const items = ((await history.json()) as { items: { issuer: string | null }[] }).items;
      expect(items[0]?.issuer).toBeNull();
    });
  });

  describe("nodes-mode empty segments", () => {
    const admin = `Bearer ${ADMIN_TOKEN}`;
    const setMode = (mode: "exact" | "nodes") =>
      call("PATCH", `/v1/admin/games/${gameId}/config`, {
        body: { config: { permissions: { mode } } },
        auth: admin,
      });

    it("rejects keys with an empty segment on write in nodes mode", async () => {
      expect((await setMode("nodes")).status).toBe(200);
      await addMember("ida");
      for (const bad of ["a..b", ".a", "a."]) {
        const entry = await call("POST", `/v1/roles/${roleId}/permissions`, {
          body: { permission: bad },
        });
        expect(entry.status).toBe(400);
        const override = await call(
          "POST",
          `/v1/groups/${groupId}/members/ida/permissions/${encodeURIComponent(bad)}`,
          { body: { grant: true } },
        );
        expect(override.status).toBe(400);
        expect(((await override.json()) as Envelope).message).toContain("empty segment");
      }
      expect(
        (await call("POST", `/v1/roles/${roleId}/permissions`, { body: { permission: "a.b" } }))
          .status,
      ).toBeLessThan(300);
    });

    it("still accepts empty segments in exact mode", async () => {
      const res = await call("POST", `/v1/roles/${roleId}/permissions`, {
        body: { permission: "a..b" },
      });
      expect(res.status).toBeLessThan(300);
    });

    it("refuses the switch to nodes when a stored key has an empty segment", async () => {
      await addMember("jo");
      await call("POST", `/v1/groups/${groupId}/members/jo/permissions/fly.`, {
        body: { grant: true },
      });
      const res = await setMode("nodes");
      expect(res.status).toBe(409);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("permission_mode_conflict");
      expect(body.message).toContain("empty segment");
    });
  });
});
