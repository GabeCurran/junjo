import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { loggedEvents, seedLinkedPerson } from "../testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-create-only";
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

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/members with If-None-Match", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let gameId: string;
  let groupId: string;
  let roleId: string;
  let defaultRoleId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Create only", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    const group = await prisma.group.create({
      data: { gameId, kind: "guild", name: "g", visibility: "public", metadata: {} },
    });
    groupId = group.id;
    roleId = (await prisma.role.create({ data: { groupId, name: "mod", priority: 50 } })).id;
    defaultRoleId = (
      await prisma.role.create({ data: { groupId, name: "member", priority: 0, isDefault: true } })
    ).id;
  });

  async function add(
    body: Record<string, unknown>,
    opts: { ifNoneMatch?: string; idempotencyKey?: string; path?: string; auth?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: opts.auth ?? key,
      "content-type": "application/json",
    };
    if (opts.ifNoneMatch !== undefined) headers["if-none-match"] = opts.ifNoneMatch;
    if (opts.idempotencyKey !== undefined) headers["idempotency-key"] = opts.idempotencyKey;
    return app.request(opts.path ?? `/v1/groups/${groupId}/members`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  }

  const createOnly = (body: Record<string, unknown>, opts: { idempotencyKey?: string } = {}) =>
    add(body, { ...opts, ifNoneMatch: "*" });

  async function snapshot() {
    return {
      members: await prisma.groupMember.findMany({ orderBy: { id: "asc" } }),
      roles: await prisma.memberRole.findMany({ orderBy: { groupMemberId: "asc" } }),
      audit: await prisma.auditEntry.count(),
      events: (await loggedEvents(prisma, gameId)).length,
    };
  }

  async function seedRow(
    userId: string,
    status: string,
    extra: { bannedUntil?: Date; roleIds?: string[] } = {},
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: userId },
    });
    const member = await prisma.groupMember.create({
      data: {
        groupId,
        junjoUserId: user.id,
        status,
        version: 4,
        leftAt: status === "left" || status === "kicked" ? new Date() : null,
        bannedUntil: extra.bannedUntil ?? null,
      },
    });
    for (const r of extra.roleIds ?? []) {
      await prisma.memberRole.create({ data: { groupMemberId: member.id, roleId: r } });
    }
    return member;
  }

  describe("refused when a row exists", () => {
    const expired = new Date(Date.now() - 60_000);
    const cases: { status: string; bannedUntil?: Date }[] = [
      { status: "active" },
      { status: "left" },
      { status: "kicked" },
      { status: "invited" },
      { status: "banned", bannedUntil: expired },
    ];

    for (const { status, bannedUntil } of cases) {
      it(`answers 412 for a ${status} row and changes nothing`, async () => {
        await seedRow("pat", status, { bannedUntil, roleIds: [roleId] });
        const before = await snapshot();

        const res = await createOnly({ userId: "pat", roleId: defaultRoleId });
        expect(res.status).toBe(412);
        const body = (await res.json()) as Envelope;
        expect(body.code).toBe("precondition_failed");
        expect(body.status).toBe(412);
        expect(body.message).toContain(`status ${status}`);
        expect(body.details).toEqual({ memberStatus: status });
        expect(res.headers.get("etag")).toBe('"4"');

        expect(await snapshot()).toEqual(before);
      });
    }

    it("refuses a row held under another linked id of the same person", async () => {
      await seedLinkedPerson(prisma, gameId, "mc:alt", "web:main", groupId);
      const before = await snapshot();
      const res = await createOnly({ userId: "mc:alt" });
      expect(res.status).toBe(412);
      expect(((await res.json()) as Envelope).details).toEqual({ memberStatus: "active" });
      expect(await snapshot()).toEqual(before);
    });

    it("refuses before evaluating kind limits", async () => {
      const config = await app.request(`/v1/admin/games/${gameId}/config`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { groups: { kinds: { guild: { maxMembers: 1 } } } } }),
      });
      expect(config.status).toBe(200);
      await seedRow("full", "active");
      await seedRow("gone", "left");
      // Without the header the reactivation hits the cap.
      const plain = await add({ userId: "gone" });
      expect(((await plain.json()) as Envelope).code).toBe("group_full");
      const res = await createOnly({ userId: "gone" });
      expect(res.status).toBe(412);
      expect(((await res.json()) as Envelope).details).toEqual({ memberStatus: "left" });
    });

    it("answers banned first when the row is an active group ban", async () => {
      await seedRow("ban", "banned");
      const res = await createOnly({ userId: "ban" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as Envelope).code).toBe("banned");
    });

    it("answers the group and role errors first, as without the header", async () => {
      await seedRow("pat", "active");
      const missing = await createOnly({ userId: "pat", roleId: "role_missing" });
      expect(missing.status).toBe(404);
      const noGroup = await add(
        { userId: "pat" },
        { ifNoneMatch: "*", path: "/v1/groups/nope/members" },
      );
      expect(noGroup.status).toBe(404);
    });
  });

  describe("applied when no row exists", () => {
    it("matches the plain add, with and without a role", async () => {
      const plain = await add({ userId: "ann", roleId: defaultRoleId });
      const guarded = await createOnly({ userId: "bea", roleId: defaultRoleId });
      expect(guarded.status).toBe(plain.status);
      expect(guarded.status).toBe(201);
      expect(guarded.headers.get("etag")).toBe(plain.headers.get("etag"));
      const a = (await plain.json()) as WireMember;
      const b = (await guarded.json()) as WireMember;
      expect(b).toMatchObject({ status: "active", roles: [defaultRoleId], version: 1 });
      expect({ ...b, id: "", userId: "", joinedAt: "" }).toEqual({
        ...a,
        id: "",
        userId: "",
        joinedAt: "",
      });

      const bare = await createOnly({ userId: "cal" });
      expect(bare.status).toBe(201);
      expect(((await bare.json()) as WireMember).roles).toEqual([]);

      const types = (await loggedEvents(prisma, gameId)).map((e) => e.type);
      expect(types).toEqual([
        "member.joined",
        "role.changed",
        "member.joined",
        "role.changed",
        "member.joined",
      ]);
      const audits = await prisma.auditEntry.findMany({ orderBy: { createdAt: "asc" } });
      expect(audits.map((x) => x.action).sort()).toEqual(
        [
          "member.joined",
          "member.joined",
          "member.joined",
          "role.assigned",
          "role.assigned",
        ].sort(),
      );
    });

    it("accepts the header with surrounding whitespace", async () => {
      expect((await add({ userId: "dee" }, { ifNoneMatch: " * " })).status).toBe(201);
    });

    it("lets exactly one of two concurrent create-only adds through", async () => {
      for (let i = 0; i < 5; i++) {
        const userId = `race-${i}`;
        const results = await Promise.all([
          createOnly({ userId, roleId: defaultRoleId }),
          createOnly({ userId, roleId: defaultRoleId }),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 412]);
      }
      expect(await prisma.groupMember.count()).toBe(5);
      expect(await prisma.memberRole.count()).toBe(5);
      expect((await loggedEvents(prisma, gameId, "member.joined")).length).toBe(5);
    });

    it("replays the first answer for a repeated Idempotency-Key", async () => {
      const first = await createOnly({ userId: "eve" }, { idempotencyKey: "k-eve" });
      expect(first.status).toBe(201);
      const firstBody = await first.text();
      const replay = await createOnly({ userId: "eve" }, { idempotencyKey: "k-eve" });
      expect(replay.status).toBe(201);
      expect(replay.headers.get("idempotent-replayed")).toBe("true");
      expect(replay.headers.get("etag")).toBe('"1"');
      expect(await replay.text()).toBe(firstBody);

      const fresh = await createOnly({ userId: "eve" }, { idempotencyKey: "k-eve-2" });
      expect(fresh.status).toBe(412);
      const again = await createOnly({ userId: "eve" }, { idempotencyKey: "k-eve-2" });
      expect(again.status).toBe(412);
      expect(again.headers.get("idempotent-replayed")).toBe("true");
      expect(again.headers.get("etag")).toBe('"1"');
    });
  });

  it("rejects any other If-None-Match value with 400 before writing", async () => {
    for (const value of ['"1"', 'W/"1"', '"1", "2"', "", "**", '*, "1"']) {
      const res = await add({ userId: "fay" }, { ifNoneMatch: value });
      expect(res.status, value).toBe(400);
      expect(((await res.json()) as Envelope).code).toBe("bad_request");
    }
    expect(await prisma.groupMember.count()).toBe(0);
    expect(await prisma.externalIdentity.count()).toBe(0);
  });

  it("applies on the admin as-game mount", async () => {
    await seedRow("gil", "kicked");
    const path = `/v1/admin/games/${gameId}/as-game/groups/${groupId}/members`;
    const auth = `Bearer ${ADMIN_TOKEN}`;
    const refused = await add({ userId: "gil" }, { ifNoneMatch: "*", path, auth });
    expect(refused.status).toBe(412);
    expect(((await refused.json()) as Envelope).details).toEqual({ memberStatus: "kicked" });
    const created = await add({ userId: "hal" }, { ifNoneMatch: "*", path, auth });
    expect(created.status).toBe(201);
    const bad = await add({ userId: "ivy" }, { ifNoneMatch: '"1"', path, auth });
    expect(bad.status).toBe(400);
  });
});
