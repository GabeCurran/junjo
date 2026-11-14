import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-group-batch";
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "GameBan", "BanHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "GroupVersion", "GroupRelationship", "Invitation", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;
const KIND = "kind-a";

interface Envelope {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

interface BatchBody {
  version: string;
  results: unknown[];
}

interface WireMember {
  userId: string;
  status: string;
  roles: string[];
  version: number;
}

// One group set up for an op, with the ids a comparison maps to labels.
interface Side {
  g: string;
  o: string;
  lead: string;
  staff: string;
  labels: Map<string, string>;
}

// Keys whose values differ between two identical setups (generated ids
// and clocks) and are left out of comparisons.
const VOLATILE = new Set([
  "id",
  "memberId",
  "occurredAt",
  "createdAt",
  "updatedAt",
  "joinedAt",
  "since",
  "setAt",
  "invitationId",
]);

function normalize(value: unknown, labels: ReadonlyMap<string, string>): unknown {
  if (typeof value === "string") return labels.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => normalize(v, labels));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (VOLATILE.has(k)) continue;
      // The group version is a stream position, so it differs by side.
      if (k === "version" && typeof v === "string") continue;
      out[k] = normalize(v, labels);
    }
    return out;
  }
  return value;
}

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/batch", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let keyId: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Batch", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    key = `Bearer ${seeded.raw.full}`;
    keyId = seeded.apiKey.id;
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    return app.request(path, {
      method,
      headers: {
        authorization: key,
        "content-type": "application/json",
        ...(opts.headers ?? {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  const batch = (groupId: string, ops: unknown[], headers?: Record<string, string>) =>
    call("POST", `/v1/groups/${groupId}/batch`, { body: { ops }, headers });

  async function ok(res: Response | Promise<Response>, status = 200): Promise<unknown> {
    const r = await res;
    const text = await r.text();
    expect(r.status, text).toBe(status);
    return text.length === 0 ? null : JSON.parse(text);
  }

  async function makeGroup(name: string, kind = KIND): Promise<string> {
    const body = (await ok(
      call("POST", "/v1/groups", { body: { kind, name, visibility: "public" } }),
      201,
    )) as { id: string };
    return body.id;
  }

  async function makeRole(groupId: string, name: string, priority: number): Promise<string> {
    const body = (await ok(
      call("POST", `/v1/groups/${groupId}/roles`, { body: { name, priority } }),
      201,
    )) as { id: string };
    return body.id;
  }

  async function addMember(groupId: string, userId: string, roleId?: string): Promise<void> {
    const res = await call("POST", `/v1/groups/${groupId}/members`, {
      body: { userId, ...(roleId ? { roleId } : {}) },
    });
    expect([200, 201]).toContain(res.status);
  }

  async function etag(groupId: string): Promise<string> {
    const res = await call("GET", `/v1/groups/${groupId}`);
    expect(res.status).toBe(200);
    return res.headers.get("etag") as string;
  }

  async function setKinds(kinds: Record<string, unknown>): Promise<void> {
    const res = await app.request(`/v1/admin/games/${gameId}/config`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ config: { groups: { kinds } } }),
    });
    expect(res.status).toBe(200);
  }

  async function side(): Promise<Side> {
    const g = await makeGroup("G");
    const o = await makeGroup("O");
    const lead = await makeRole(g, "lead", 10);
    const staff = await makeRole(g, "staff", 5);
    await addMember(g, "alice", lead);
    await addMember(g, "bob");
    const labels = new Map([
      [g, "G"],
      [o, "O"],
      [lead, "lead"],
      [staff, "staff"],
    ]);
    return { g, o, lead, staff, labels };
  }

  async function lastSeq(): Promise<bigint> {
    const row = await prisma.gameEventCounter.findUnique({ where: { gameId } });
    return row?.seq ?? 0n;
  }

  // Events logged after `after` about the side's groups, in order.
  async function eventsSince(after: bigint, s: Side): Promise<unknown[]> {
    const rows = await prisma.eventLog.findMany({
      where: { gameId, seq: { gt: after } },
      orderBy: { seq: "asc" },
    });
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((e) => e.groupId === s.g || e.groupId === s.o)
      .map((e) => normalize(e, s.labels));
  }

  async function auditIds(): Promise<Set<string>> {
    return new Set((await prisma.auditEntry.findMany({ select: { id: true } })).map((r) => r.id));
  }

  async function auditSince(before: Set<string>, s: Side): Promise<string[]> {
    const rows = await prisma.auditEntry.findMany({ where: { groupId: { in: [s.g, s.o] } } });
    return rows
      .filter((r) => !before.has(r.id))
      .map((r) =>
        JSON.stringify(
          normalize(
            {
              action: r.action,
              targetId: r.targetId,
              actorUserId: r.actorUserId,
              payload: r.payload,
            },
            s.labels,
          ),
        ),
      )
      .sort();
  }

  interface ParityCase {
    name: string;
    prep?: (s: Side) => Promise<void>;
    single: (s: Side) => { method: string; path: string; body?: unknown };
    op: (s: Side) => Record<string, unknown>;
  }

  const FUTURE = "2099-01-01T00:00:00.000Z";

  const cases: ParityCase[] = [
    {
      name: "member.add with a role and an actor",
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members`,
        body: { userId: "dave", roleId: s.staff, actorUserId: "mod" },
      }),
      op: (s) => ({ op: "member.add", userId: "dave", roleId: s.staff, actorUserId: "mod" }),
    },
    {
      name: "member.add of an active member",
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members`,
        body: { userId: "bob" },
      }),
      op: () => ({ op: "member.add", userId: "bob" }),
    },
    {
      name: "member.add reactivating a member who left",
      prep: async (s) => {
        await ok(call("POST", `/v1/groups/${s.g}/leave`, { body: { userId: "bob" } }));
      },
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members`,
        body: { userId: "bob" },
      }),
      op: () => ({ op: "member.add", userId: "bob" }),
    },
    {
      name: "member.kick",
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members/bob/kick`,
        body: { reason: "rules", actorUserId: "mod" },
      }),
      op: () => ({ op: "member.kick", userId: "bob", reason: "rules", actorUserId: "mod" }),
    },
    {
      name: "member.leave",
      single: (s) => ({ method: "POST", path: `/v1/groups/${s.g}/leave`, body: { userId: "bob" } }),
      op: () => ({ op: "member.leave", userId: "bob" }),
    },
    {
      name: "member.ban of a member",
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members/bob/ban`,
        body: { reason: "spam", expiresAt: FUTURE, actorUserId: "mod" },
      }),
      op: () => ({
        op: "member.ban",
        userId: "bob",
        reason: "spam",
        expiresAt: FUTURE,
        actorUserId: "mod",
      }),
    },
    {
      name: "member.ban of a person with no membership",
      single: (s) => ({ method: "POST", path: `/v1/groups/${s.g}/members/erin/ban`, body: {} }),
      op: () => ({ op: "member.ban", userId: "erin" }),
    },
    {
      name: "member.unban",
      prep: async (s) => {
        await ok(call("POST", `/v1/groups/${s.g}/members/bob/ban`, { body: {} }));
      },
      single: (s) => ({
        method: "DELETE",
        path: `/v1/groups/${s.g}/members/bob/ban`,
        body: { actorUserId: "mod" },
      }),
      op: () => ({ op: "member.unban", userId: "bob", actorUserId: "mod" }),
    },
    {
      name: "member.update",
      single: (s) => ({
        method: "PATCH",
        path: `/v1/groups/${s.g}/members/alice`,
        body: { metadata: { rank: 3 }, notesPublic: "hello" },
      }),
      op: () => ({
        op: "member.update",
        userId: "alice",
        metadata: { rank: 3 },
        notesPublic: "hello",
      }),
    },
    {
      name: "member.update that changes nothing",
      single: (s) => ({
        method: "PATCH",
        path: `/v1/groups/${s.g}/members/alice`,
        body: { notesPublic: null },
      }),
      op: () => ({ op: "member.update", userId: "alice", notesPublic: null }),
    },
    {
      name: "member.role.add",
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members/alice/roles/${s.staff}`,
        body: { actorUserId: "mod" },
      }),
      op: (s) => ({ op: "member.role.add", userId: "alice", roleId: s.staff, actorUserId: "mod" }),
    },
    {
      name: "member.role.add of a held role",
      single: (s) => ({
        method: "POST",
        path: `/v1/groups/${s.g}/members/alice/roles/${s.lead}`,
      }),
      op: (s) => ({ op: "member.role.add", userId: "alice", roleId: s.lead }),
    },
    {
      name: "member.role.remove",
      single: (s) => ({
        method: "DELETE",
        path: `/v1/groups/${s.g}/members/alice/roles/${s.lead}`,
        body: { actorUserId: "mod" },
      }),
      op: (s) => ({
        op: "member.role.remove",
        userId: "alice",
        roleId: s.lead,
        actorUserId: "mod",
      }),
    },
    {
      name: "group.update",
      single: (s) => ({
        method: "PATCH",
        path: `/v1/groups/${s.g}`,
        body: { name: "Renamed", metadata: { motd: "hi" }, actorUserId: "mod" },
      }),
      op: () => ({
        op: "group.update",
        name: "Renamed",
        metadata: { motd: "hi" },
        actorUserId: "mod",
      }),
    },
    {
      name: "role.entry.set of a grant",
      single: (s) => ({
        method: "POST",
        path: `/v1/roles/${s.lead}/permissions`,
        body: { permission: "kick" },
      }),
      op: (s) => ({ op: "role.entry.set", roleId: s.lead, permission: "kick" }),
    },
    {
      name: "role.entry.set of a contextual deny",
      single: (s) => ({
        method: "POST",
        path: `/v1/roles/${s.lead}/permissions`,
        body: { permission: "build", value: false, context: { world: "w1" } },
      }),
      op: (s) => ({
        op: "role.entry.set",
        roleId: s.lead,
        permission: "build",
        value: false,
        context: { world: "w1" },
      }),
    },
    {
      name: "role.entry.remove",
      prep: async (s) => {
        await ok(call("POST", `/v1/roles/${s.lead}/permissions`, { body: { permission: "kick" } }));
      },
      single: (s) => ({ method: "DELETE", path: `/v1/roles/${s.lead}/permissions/kick` }),
      op: (s) => ({ op: "role.entry.remove", roleId: s.lead, permission: "kick" }),
    },
    {
      name: "relationship.set, mutual",
      single: (s) => ({
        method: "PUT",
        path: `/v1/groups/${s.g}/relationships/${s.o}`,
        body: { type: "ally", mutual: true, actorUserId: "mod" },
      }),
      op: (s) => ({
        op: "relationship.set",
        otherGroupId: s.o,
        type: "ally",
        mutual: true,
        actorUserId: "mod",
      }),
    },
    {
      name: "relationship.clear, mutual",
      prep: async (s) => {
        await ok(
          call("PUT", `/v1/groups/${s.g}/relationships/${s.o}`, {
            body: { type: "rival", mutual: true },
          }),
        );
      },
      single: (s) => ({
        method: "DELETE",
        path: `/v1/groups/${s.g}/relationships/${s.o}?mutual=true&actorUserId=mod`,
      }),
      op: (s) => ({
        op: "relationship.clear",
        otherGroupId: s.o,
        mutual: true,
        actorUserId: "mod",
      }),
    },
  ];

  describe("each op alone matches its single route", () => {
    it.each(cases)("$name", async (c) => {
      const single = await side();
      const batched = await side();
      await c.prep?.(single);
      await c.prep?.(batched);

      let seq = await lastSeq();
      let audit = await auditIds();
      const req = c.single(single);
      const singleRes = await call(req.method, req.path, { body: req.body });
      expect(singleRes.status).toBeLessThan(300);
      const singleText = await singleRes.text();
      const singleBody = singleText.length === 0 ? null : JSON.parse(singleText);
      const singleEvents = await eventsSince(seq, single);
      const singleAudit = await auditSince(audit, single);

      seq = await lastSeq();
      audit = await auditIds();
      const body = (await ok(batch(batched.g, [c.op(batched)]))) as BatchBody;
      const batchEvents = await eventsSince(seq, batched);
      const batchAudit = await auditSince(audit, batched);

      expect(body.results).toHaveLength(1);
      expect(normalize(body.results[0], batched.labels)).toEqual(
        normalize(singleBody, single.labels),
      );
      expect(batchEvents).toEqual(singleEvents);
      expect(batchAudit).toEqual(singleAudit);
      expect(`"${body.version}"`).toBe(await etag(batched.g));
    });

    it("refuses a create-only add of an existing row as the single route does", async () => {
      const s = await side();
      const single = await call("POST", `/v1/groups/${s.g}/members`, {
        body: { userId: "bob" },
        headers: { "if-none-match": "*" },
      });
      expect(single.status).toBe(412);
      const singleBody = (await single.json()) as Envelope;
      const res = await batch(s.g, [{ op: "member.add", userId: "bob", createOnly: true }]);
      expect(res.status).toBe(412);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe(singleBody.code);
      expect(body.message).toBe(singleBody.message);
      expect(body.details).toEqual({ ...singleBody.details, opIndex: 0 });
    });
  });

  describe("ordering", () => {
    it("lets a later op act on a member an earlier op added", async () => {
      const s = await side();
      const seq = await lastSeq();
      const body = (await ok(
        batch(s.g, [
          { op: "member.add", userId: "dave" },
          { op: "member.role.add", userId: "dave", roleId: s.staff },
        ]),
      )) as BatchBody;
      const [added, assigned] = body.results as WireMember[];
      expect(added?.roles).toEqual([]);
      expect(assigned?.roles).toEqual([s.staff]);
      expect(assigned?.version).toBe((added?.version ?? 0) + 1);
      const events = (await eventsSince(seq, s)) as { type: string }[];
      expect(events.map((e) => e.type)).toEqual(["member.joined", "role.changed"]);
    });

    it("hands the top role from one member to another in one step", async () => {
      const s = await side();
      const seq = await lastSeq();
      const body = (await ok(
        batch(s.g, [
          { op: "member.role.remove", userId: "alice", roleId: s.lead },
          { op: "member.role.add", userId: "bob", roleId: s.lead },
          { op: "member.role.add", userId: "alice", roleId: s.staff },
        ]),
      )) as BatchBody;
      const [aliceDemoted, bobPromoted, aliceStaff] = body.results as WireMember[];
      expect(aliceDemoted?.roles).toEqual([]);
      expect(bobPromoted?.roles).toEqual([s.lead]);
      expect(aliceStaff?.roles).toEqual([s.staff]);

      const holders = await prisma.memberRole.findMany({
        where: { roleId: s.lead },
        include: {
          groupMember: { include: { junjoUser: { include: { externalIdentities: true } } } },
        },
      });
      expect(
        holders.map((h) => h.groupMember.junjoUser.externalIdentities.map((i) => i.externalUserId)),
      ).toEqual([["bob"]]);

      const events = (await eventsSince(seq, s)) as {
        type: string;
        userId: string;
        added: string[];
        removed: string[];
      }[];
      expect(events.map((e) => [e.type, e.userId, e.added, e.removed])).toEqual([
        ["role.changed", "alice", [], ["lead"]],
        ["role.changed", "bob", ["lead"], []],
        ["role.changed", "alice", ["staff"], []],
      ]);
    });
  });

  describe("atomicity", () => {
    async function footprint(groupId: string) {
      return {
        members: await prisma.groupMember.findMany({
          where: { groupId },
          orderBy: { id: "asc" },
        }),
        roles: await prisma.memberRole.count(),
        audit: await prisma.auditEntry.count(),
        events: await prisma.eventLog.count(),
        deliveries: await prisma.webhookDelivery.count(),
        banHistory: await prisma.banHistory.count(),
        version: await etag(groupId),
      };
    }

    it("leaves no trace when the last op names a role of another group", async () => {
      const s = await side();
      const elsewhere = await makeRole(s.o, "elsewhere", 1);
      await prisma.webhookEndpoint.create({
        data: { gameId, url: "https://hooks.invalid/batch", secret: "s", events: [] },
      });
      const before = await footprint(s.g);
      const res = await batch(s.g, [
        { op: "member.add", userId: "dave" },
        { op: "member.role.add", userId: "dave", roleId: s.staff },
        { op: "member.kick", userId: "bob" },
        { op: "role.entry.set", roleId: s.lead, permission: "kick" },
        { op: "member.role.add", userId: "dave", roleId: elsewhere },
      ]);
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("role_group_mismatch");
      expect(body.details).toEqual({ opIndex: 4 });
      expect(await footprint(s.g)).toEqual(before);
      expect(await prisma.rolePermission.count()).toBe(0);
    });

    it("refuses an add of a person banned earlier in the same batch", async () => {
      const s = await side();
      const before = await footprint(s.g);
      const res = await batch(s.g, [
        { op: "member.ban", userId: "erin", reason: "spam" },
        { op: "member.add", userId: "erin" },
      ]);
      expect(res.status).toBe(403);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("banned");
      expect(body.details).toEqual({ opIndex: 1 });
      expect(await footprint(s.g)).toEqual(before);
    });

    it("keeps an op's own details beside the index", async () => {
      const s = await side();
      const res = await batch(s.g, [
        { op: "member.update", userId: "alice", notesPublic: "x" },
        { op: "member.unban", userId: "bob" },
      ]);
      expect(res.status).toBe(404);
      const body = (await res.json()) as Envelope;
      expect(body.details).toEqual({ reason: "not_active", opIndex: 1 });
    });

    it("reports the first failing op, before a later malformed id", async () => {
      const s = await side();
      await app.request(`/v1/admin/games/${gameId}/config`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { identity: { formats: { acct: "uuid" } } } }),
      });
      const early = await batch(s.g, [
        { op: "member.kick", userId: "nobody" },
        { op: "member.add", userId: "acct:not-a-uuid" },
      ]);
      expect(early.status).toBe(404);
      expect(((await early.json()) as Envelope).details).toEqual({ opIndex: 0 });
      const late = await batch(s.g, [
        { op: "member.add", userId: "frank" },
        { op: "member.add", userId: "acct:not-a-uuid" },
      ]);
      expect(late.status).toBe(400);
      const body = (await late.json()) as Envelope;
      expect(body.code).toBe("invalid_user_id");
      expect(body.details).toEqual({ opIndex: 1 });
      const frank = await prisma.groupMember.count({
        where: {
          groupId: s.g,
          junjoUser: { externalIdentities: { some: { externalUserId: "frank" } } },
        },
      });
      expect(frank).toBe(0);
    });

    it("answers 404 for ops after one that deleted the emptied group", async () => {
      await setKinds({ [KIND]: { deleteWhenEmpty: true } });
      const g = await makeGroup("Solo");
      await addMember(g, "alice");
      const res = await batch(g, [
        { op: "member.leave", userId: "alice" },
        { op: "member.add", userId: "bob" },
      ]);
      expect(res.status).toBe(404);
      expect(((await res.json()) as Envelope).details).toEqual({ opIndex: 1 });
      const group = await prisma.group.findUniqueOrThrow({ where: { id: g } });
      expect(group.softDeletedAt).toBeNull();
      // The same departure alone deletes the group, as its route does.
      await ok(batch(g, [{ op: "member.leave", userId: "alice" }]));
      const after = await prisma.group.findUniqueOrThrow({ where: { id: g } });
      expect(after.softDeletedAt).not.toBeNull();
    });
  });

  describe("If-Match", () => {
    it("refuses a stale version with the current one and writes nothing", async () => {
      const s = await side();
      const v0 = await etag(s.g);
      await ok(call("PATCH", `/v1/groups/${s.g}`, { body: { metadata: { a: 1 } } }));
      const v1 = await etag(s.g);
      const events = await prisma.eventLog.count();
      const res = await batch(s.g, [{ op: "member.kick", userId: "bob" }], { "if-match": v0 });
      expect(res.status).toBe(412);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("precondition_failed");
      expect(`"${body.details?.version}"`).toBe(v1);
      expect(await prisma.eventLog.count()).toBe(events);
      const bob = (await (await call("GET", `/v1/groups/${s.g}/members/bob`)).json()) as WireMember;
      expect(bob.status).toBe("active");
    });

    it("applies on the current version and answers the new one", async () => {
      const s = await side();
      const v0 = await etag(s.g);
      const res = await batch(
        s.g,
        [
          { op: "member.kick", userId: "bob" },
          { op: "group.update", metadata: { a: 2 } },
        ],
        { "if-match": v0 },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as BatchBody;
      expect(res.headers.get("etag")).toBe(`"${body.version}"`);
      expect(`"${body.version}"`).not.toBe(v0);
      expect(`"${body.version}"`).toBe(await etag(s.g));
    });

    it("checks a batch that changes nothing", async () => {
      const s = await side();
      const noop = [{ op: "member.add", userId: "bob" }];
      const stale = await batch(s.g, noop, { "if-match": '"999"' });
      expect(stale.status).toBe(412);
      const current = await etag(s.g);
      const res = await batch(s.g, noop, { "if-match": current });
      expect(res.status).toBe(200);
      expect(`"${((await res.json()) as BatchBody).version}"`).toBe(current);
    });

    it("lets exactly one of several batches on the same version win", async () => {
      const s = await side();
      const v0 = await etag(s.g);
      const results = await Promise.all(
        ["one", "two", "three", "four"].map((motd) =>
          batch(
            s.g,
            [
              { op: "group.update", metadata: { motd } },
              { op: "member.update", userId: "alice", notesPublic: motd },
            ],
            { "if-match": v0 },
          ),
        ),
      );
      expect(results.map((r) => r.status).sort()).toEqual([200, 412, 412, 412]);
    });

    it("refuses a malformed If-Match", async () => {
      const s = await side();
      const res = await batch(s.g, [{ op: "member.kick", userId: "bob" }], {
        "if-match": 'W/"1"',
      });
      expect(res.status).toBe(400);
    });
  });

  describe("kind limits", () => {
    it("applies maxPerUser across the batch's adds", async () => {
      await setKinds({ [KIND]: { maxPerUser: 1 } });
      const first = await makeGroup("First");
      const second = await makeGroup("Second");
      await addMember(first, "alice");
      const res = await batch(second, [
        { op: "member.add", userId: "bob" },
        { op: "member.add", userId: "alice" },
      ]);
      expect(res.status).toBe(409);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("group_limit_reached");
      expect(body.details).toEqual({ opIndex: 1 });
      expect(await prisma.groupMember.count({ where: { groupId: second } })).toBe(0);
    });

    it("applies maxMembers as the batch changes the count", async () => {
      await setKinds({ [KIND]: { maxMembers: 2 } });
      const g = await makeGroup("Capped");
      await addMember(g, "alice");
      const full = await batch(g, [
        { op: "member.add", userId: "bob" },
        { op: "member.add", userId: "carol" },
      ]);
      expect(full.status).toBe(409);
      const body = (await full.json()) as Envelope;
      expect(body.code).toBe("group_full");
      expect(body.details).toEqual({ opIndex: 1 });
      await ok(
        batch(g, [
          { op: "member.kick", userId: "alice" },
          { op: "member.add", userId: "bob" },
          { op: "member.add", userId: "carol" },
        ]),
      );
      expect(await prisma.groupMember.count({ where: { groupId: g, status: "active" } })).toBe(2);
    });

    it("lets batches adding the same people to groups of one kind finish", async () => {
      await setKinds({ [KIND]: { maxPerUser: 5 } });
      const groups = await Promise.all(["A", "B", "C"].map((n) => makeGroup(n)));
      const people = ["p1", "p2", "p3", "p4"];
      const results = await Promise.all(
        groups.map((g, i) =>
          batch(
            g,
            (i % 2 === 0 ? people : [...people].reverse()).map((userId) => ({
              op: "member.add",
              userId,
            })),
          ),
        ),
      );
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    });
  });

  describe("validation", () => {
    async function refused(ops: unknown, opIndex?: number) {
      const s = await side();
      const events = await prisma.eventLog.count();
      const res = await call("POST", `/v1/groups/${s.g}/batch`, { body: { ops } });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope;
      expect(body.code).toBe("bad_request");
      if (opIndex === undefined) expect(body.details).toBeUndefined();
      else expect(body.details).toEqual({ opIndex });
      expect(await prisma.eventLog.count()).toBe(events);
      return body;
    }

    it("refuses an empty or oversized list", async () => {
      await refused([]);
      await refused(Array.from({ length: 51 }, () => ({ op: "member.leave", userId: "bob" })));
    });

    it("refuses an unknown op", async () => {
      await refused([{ op: "member.leave", userId: "bob" }, { op: "member.delete" }], 1);
    });

    it("refuses an unknown field", async () => {
      await refused([{ op: "member.kick", userId: "bob", extra: true }], 0);
    });

    it("refuses a passcode in group.update", async () => {
      const body = await refused([{ op: "group.update", name: "x", passcode: "1234" }], 0);
      expect(body.message).toContain("passcode");
    });

    it("refuses a group.update that names only an actor", async () => {
      await refused([{ op: "group.update", actorUserId: "mod" }], 0);
    });

    it("refuses unknown fields on the body", async () => {
      const s = await side();
      const res = await call("POST", `/v1/groups/${s.g}/batch`, {
        body: { ops: [{ op: "member.leave", userId: "bob" }], extra: 1 },
      });
      expect(res.status).toBe(400);
    });

    it("answers 404 for a missing or deleted group", async () => {
      const res = await batch("nope", [{ op: "member.leave", userId: "bob" }]);
      expect(res.status).toBe(404);
      const s = await side();
      await ok(call("DELETE", `/v1/groups/${s.g}`));
      const gone = await batch(s.g, [{ op: "member.leave", userId: "bob" }]);
      expect(gone.status).toBe(404);
    });
  });

  describe("origin and idempotency", () => {
    it("stamps the key and the write tag on every event of the batch", async () => {
      const s = await side();
      const seq = await lastSeq();
      await ok(
        batch(
          s.g,
          [
            { op: "member.add", userId: "dave", roleId: s.staff },
            { op: "group.update", name: "Tagged" },
            { op: "relationship.set", otherGroupId: s.o, type: "ally", mutual: true },
          ],
          { "junjo-write-tag": "writer-1" },
        ),
      );
      const rows = await prisma.eventLog.findMany({ where: { gameId, seq: { gt: seq } } });
      expect(rows.length).toBe(5);
      for (const row of rows) {
        expect((row.payload as { origin: unknown }).origin).toEqual({
          apiKeyId: keyId,
          tag: "writer-1",
        });
      }
    });

    it("replays the stored response for a repeated Idempotency-Key", async () => {
      const s = await side();
      const ops = [{ op: "member.kick", userId: "bob" }];
      const headers = { "idempotency-key": "batch-1" };
      const first = await batch(s.g, ops, headers);
      expect(first.status).toBe(200);
      const firstBody = await first.text();
      const events = await prisma.eventLog.count();
      const second = await batch(s.g, ops, headers);
      expect(second.status).toBe(200);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
      expect(await second.text()).toBe(firstBody);
      expect(await prisma.eventLog.count()).toBe(events);
    });

    it("changes nothing and emits nothing for a batch of no-ops", async () => {
      const s = await side();
      const v0 = await etag(s.g);
      const seq = await lastSeq();
      const audit = await prisma.auditEntry.count();
      const body = (await ok(
        batch(s.g, [
          { op: "member.add", userId: "bob" },
          { op: "member.role.add", userId: "alice", roleId: s.lead },
          { op: "member.role.remove", userId: "bob", roleId: s.lead },
          { op: "relationship.clear", otherGroupId: s.o },
          { op: "role.entry.remove", roleId: s.lead, permission: "absent" },
          { op: "group.update", name: "G" },
        ]),
      )) as BatchBody;
      expect(`"${body.version}"`).toBe(v0);
      expect(body.results).toHaveLength(6);
      expect(body.results[3]).toBeNull();
      expect(await lastSeq()).toBe(seq);
      expect(await prisma.auditEntry.count()).toBe(audit);
    });
  });
});
