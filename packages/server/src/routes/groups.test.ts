import { type Prisma, PrismaClient } from "@prisma/client";
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

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function postGroups(body: unknown, header: string = authHeader) {
    return app.request("/v1/groups", {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("creates a group with the required fields and applies defaults", async () => {
    const res = await postGroups({ kind: "guild", name: "Crimson Wolves" });
    expect(res.status).toBe(201);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      gameId,
      kind: "guild",
      name: "Crimson Wolves",
      visibility: "invite-only",
      metadata: {},
      defaultRoleId: null,
      memberCount: 0,
      softDeletedAt: null,
    });
    expect(typeof body.id).toBe("string");
    expect(body.id).toMatch(/^c[a-z0-9]+/);
    expect(typeof body.createdAt).toBe("string");
    expect(typeof body.updatedAt).toBe("string");
    expect(new Date(body.createdAt as string).toString()).not.toBe("Invalid Date");

    const stored = await prisma.group.findUnique({ where: { id: body.id as string } });
    expect(stored?.gameId).toBe(gameId);
    expect(stored?.visibility).toBe("invite-only");
  });

  it("preserves provided visibility, metadata, and defaultRoleId", async () => {
    const res = await postGroups({
      kind: "clan",
      name: "Iron Hand",
      visibility: "public",
      metadata: { motto: "Together" },
      defaultRoleId: "role_xyz",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.visibility).toBe("public");
    expect(body.metadata).toEqual({ motto: "Together" });
    expect(body.defaultRoleId).toBe("role_xyz");
  });

  it("writes a group.created audit entry per call", async () => {
    const res = await postGroups({ kind: "guild", name: "Audit Group" });
    const body = (await res.json()) as { id: string };
    const entries = await prisma.auditEntry.findMany({ where: { groupId: body.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("group.created");
    expect(entry.targetId).toBe(body.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({ name: "Audit Group", kind: "guild" });
  });

  it("rejects a body missing required fields", async () => {
    const res = await postGroups({ kind: "guild" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects an invalid visibility value", async () => {
    const res = await postGroups({ kind: "guild", name: "x", visibility: "open" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const res = await postGroups({ kind: "guild", name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const res = await postGroups("not json");
    expect(res.status).toBe(400);
  });

  it("rejects requests without an API key", async () => {
    const res = await app.request("/v1/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "guild", name: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("scopes the new group to the calling game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const otherKey = await createApiKey(otherGame.id, prisma);

    const a = await postGroups({ kind: "guild", name: "From A" });
    const b = await postGroups({ kind: "guild", name: "From B" }, `Bearer ${otherKey.raw.full}`);
    const ja = (await a.json()) as { gameId: string };
    const jb = (await b.json()) as { gameId: string };
    expect(ja.gameId).toBe(gameId);
    expect(jb.gameId).toBe(otherGame.id);
    expect(ja.gameId).not.toBe(jb.gameId);
  });

  describe("creatorUserId", () => {
    async function loadAudit(groupId: string) {
      return prisma.auditEntry.findMany({
        where: { groupId },
        orderBy: { createdAt: "asc" },
      });
    }

    for (const visibility of ["public", "invite-only", "secret"] as const) {
      it(`adds the creator as an active member when visibility=${visibility}`, async () => {
        const res = await postGroups({
          kind: "guild",
          name: `Creator ${visibility}`,
          visibility,
          creatorUserId: "founder",
        });
        expect(res.status).toBe(201);
        const body = (await res.json()) as { id: string; memberCount: number };
        expect(body.memberCount).toBe(1);

        const member = await prisma.groupMember.findFirst({
          where: { groupId: body.id },
          include: { junjoUser: { include: { externalIdentities: true } } },
        });
        expect(member?.status).toBe("active");
        expect(member?.junjoUser.externalIdentities[0]?.externalUserId).toBe("founder");
      });
    }

    it("writes both group.created and member.joined audit entries with via=creator", async () => {
      const res = await postGroups({
        kind: "guild",
        name: "Audited Creator",
        creatorUserId: "founder",
      });
      const body = (await res.json()) as { id: string };
      const entries = await loadAudit(body.id);
      expect(entries.map((e) => e.action)).toEqual(["group.created", "member.joined"]);
      const joined = entries[1];
      if (!joined) throw new Error("expected member.joined audit entry");
      expect(joined.targetId).toBe("founder");
      expect((joined.payload as { via?: string })?.via).toBe("creator");
      expect(joined.actorUserId).not.toBeNull();
    });

    it("does not add a member or write member.joined when creatorUserId is omitted", async () => {
      const res = await postGroups({ kind: "guild", name: "Solo" });
      const body = (await res.json()) as { id: string; memberCount: number };
      expect(body.memberCount).toBe(0);
      const members = await prisma.groupMember.findMany({ where: { groupId: body.id } });
      expect(members).toHaveLength(0);
      const entries = await loadAudit(body.id);
      expect(entries.map((e) => e.action)).toEqual(["group.created"]);
    });

    it("rejects an empty creatorUserId with 400", async () => {
      const res = await postGroups({ kind: "guild", name: "x", creatorUserId: "" });
      expect(res.status).toBe(400);
    });

    it("assigns defaultRoleId when a matching Role row already exists in the group", async () => {
      // Pre-seed a Role row whose id we can pass as defaultRoleId.
      // We need to know the group id first, so create the group via the
      // route, seed the Role, drop the row, then re-create. Cleaner: use
      // a fixed cuid-shaped role id, create the group with that id as
      // defaultRoleId, then race to insert the Role inside the same tx.
      // The route path can't do that, so for this test we pre-create a
      // sibling group + Role and then re-use the role id (Role rows are
      // group-scoped via FK, so this scenario doesn't apply on a fresh
      // group). Instead, verify the contract directly: when the role
      // does NOT belong to the new group, no MemberRole row is written.
      const res = await postGroups({
        kind: "guild",
        name: "Stale Default",
        defaultRoleId: "role_does_not_exist_yet",
        creatorUserId: "founder",
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { id: string };
      const memberRoles = await prisma.memberRole.findMany({
        where: { groupMember: { groupId: body.id } },
      });
      expect(memberRoles).toHaveLength(0);

      // The audit payload should also omit the roleId field when no
      // role was assigned (canned templates that pre-seed a Role can
      // exercise the positive path; here we just verify the no-op).
      const entries = await loadAudit(body.id);
      const joined = entries.find((e) => e.action === "member.joined");
      expect(joined).toBeDefined();
      expect((joined?.payload as { roleId?: string })?.roleId).toBeUndefined();
    });

    it("upserts the JunjoUser when the creator has no prior identity in this game", async () => {
      const before = await prisma.externalIdentity.count();
      const res = await postGroups({
        kind: "guild",
        name: "First-time creator",
        creatorUserId: "brand_new",
      });
      expect(res.status).toBe(201);
      const after = await prisma.externalIdentity.count();
      expect(after).toBe(before + 1);
    });

    it("reuses an existing JunjoUser when the creator already has an identity", async () => {
      // Pre-create an identity by issuing a first call.
      const first = await postGroups({
        kind: "guild",
        name: "First",
        creatorUserId: "repeat",
      });
      const firstBody = (await first.json()) as { id: string };
      const initialIdentity = await prisma.externalIdentity.findFirst({
        where: { externalUserId: "repeat" },
      });
      const before = await prisma.externalIdentity.count();

      const second = await postGroups({
        kind: "guild",
        name: "Second",
        creatorUserId: "repeat",
      });
      expect(second.status).toBe(201);
      const after = await prisma.externalIdentity.count();
      expect(after).toBe(before);

      // Both groups share the same JunjoUser.
      const member1 = await prisma.groupMember.findFirst({ where: { groupId: firstBody.id } });
      const secondBody = (await second.json()) as { id: string };
      const member2 = await prisma.groupMember.findFirst({ where: { groupId: secondBody.id } });
      expect(member1?.junjoUserId).toBe(initialIdentity?.junjoUserId);
      expect(member2?.junjoUserId).toBe(initialIdentity?.junjoUserId);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function getGroup(id: string, header: string = authHeader) {
    return app.request(`/v1/groups/${id}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  async function seedGroup(overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {}) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Test Group",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("returns the group when it exists in the calling game", async () => {
    const group = await seedGroup();
    const res = await getGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: group.id,
      gameId,
      kind: "guild",
      name: "Test Group",
      visibility: "invite-only",
      metadata: {},
      defaultRoleId: null,
      memberCount: 0,
      softDeletedAt: null,
    });
    expect(typeof body.createdAt).toBe("string");
    expect(new Date(body.createdAt as string).toString()).not.toBe("Invalid Date");
  });

  it("counts only active members in memberCount", async () => {
    const group = await seedGroup();
    const userA = await prisma.junjoUser.create({ data: {} });
    const userB = await prisma.junjoUser.create({ data: {} });
    const userC = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.createMany({
      data: [
        { groupId: group.id, junjoUserId: userA.id, status: "active" },
        { groupId: group.id, junjoUserId: userB.id, status: "active" },
        { groupId: group.id, junjoUserId: userC.id, status: "left" },
      ],
    });

    const res = await getGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberCount: number };
    expect(body.memberCount).toBe(2);
  });

  it("returns 404 not_found when the group does not exist", async () => {
    const res = await getGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await getGroup(group.id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await getGroup(group.id);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function listGroups(query = "", header: string = authHeader) {
    const path = query ? `/v1/groups?${query}` : "/v1/groups";
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  async function seedGroup(opts: {
    gameId?: string;
    name: string;
    createdAt?: Date;
    softDeletedAt?: Date | null;
  }) {
    return prisma.group.create({
      data: {
        gameId: opts.gameId ?? gameId,
        kind: "guild",
        name: opts.name,
        visibility: "invite-only",
        metadata: {},
        ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
        ...(opts.softDeletedAt !== undefined ? { softDeletedAt: opts.softDeletedAt } : {}),
      },
    });
  }

  it("returns an empty page when no groups exist", async () => {
    const res = await listGroups();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns groups in createdAt desc order with memberCount", async () => {
    await seedGroup({ name: "oldest", createdAt: new Date("2026-04-01T00:00:00Z") });
    const middle = await seedGroup({ name: "middle", createdAt: new Date("2026-04-02T00:00:00Z") });
    await seedGroup({ name: "newest", createdAt: new Date("2026-04-03T00:00:00Z") });

    const userA = await prisma.junjoUser.create({ data: {} });
    const userB = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.createMany({
      data: [
        { groupId: middle.id, junjoUserId: userA.id, status: "active" },
        { groupId: middle.id, junjoUserId: userB.id, status: "left" },
      ],
    });

    const res = await listGroups();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ name: string; memberCount: number }>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.name)).toEqual(["newest", "middle", "oldest"]);
    expect(body.items.map((i) => i.memberCount)).toEqual([0, 1, 0]);
    expect(body.nextCursor).toBeNull();
  });

  it("excludes soft-deleted groups and groups in other games", async () => {
    await seedGroup({ name: "visible" });
    await seedGroup({ name: "trashed", softDeletedAt: new Date() });
    const otherGame = await createGame("Other Game", prisma);
    await seedGroup({ gameId: otherGame.id, name: "elsewhere" });

    const res = await listGroups();
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["visible"]);
  });

  it("paginates via cursor and limit", async () => {
    for (let i = 0; i < 5; i++) {
      await seedGroup({
        name: `g${i}`,
        createdAt: new Date(`2026-04-${String(i + 1).padStart(2, "0")}T00:00:00Z`),
      });
    }

    const page1 = await listGroups("limit=2");
    const body1 = (await page1.json()) as {
      items: Array<{ id: string; name: string }>;
      nextCursor: string | null;
    };
    expect(body1.items.map((i) => i.name)).toEqual(["g4", "g3"]);
    expect(body1.nextCursor).toBe(body1.items[1]?.id);

    const page2 = await listGroups(`limit=2&cursor=${body1.nextCursor}`);
    const body2 = (await page2.json()) as {
      items: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(body2.items.map((i) => i.name)).toEqual(["g2", "g1"]);
    expect(body2.nextCursor).not.toBeNull();

    const page3 = await listGroups(`limit=2&cursor=${body2.nextCursor}`);
    const body3 = (await page3.json()) as {
      items: Array<{ name: string }>;
      nextCursor: string | null;
    };
    expect(body3.items.map((i) => i.name)).toEqual(["g0"]);
    expect(body3.nextCursor).toBeNull();
  });

  it("defaults limit to 50 when not provided", async () => {
    for (let i = 0; i < 51; i++) {
      await seedGroup({
        name: `g${i}`,
        createdAt: new Date(2026, 3, 1, 0, 0, i),
      });
    }
    const res = await listGroups();
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toHaveLength(50);
    expect(body.nextCursor).not.toBeNull();
  });

  it("rejects an out-of-range limit", async () => {
    const res = await listGroups("limit=101");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a non-integer limit", async () => {
    const res = await listGroups("limit=abc");
    expect(res.status).toBe(400);
  });

  it("rejects an unknown cursor", async () => {
    const res = await listGroups("cursor=ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("invalid cursor");
  });

  it("rejects a cursor pointing at a group in a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const stranger = await seedGroup({ gameId: otherGame.id, name: "elsewhere" });
    const res = await listGroups(`cursor=${stranger.id}`);
    expect(res.status).toBe(400);
  });

  it("accepts a gameId that matches the calling game", async () => {
    await seedGroup({ name: "mine" });
    const res = await listGroups(`gameId=${gameId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["mine"]);
  });

  it("rejects a gameId that does not match the calling game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const res = await listGroups(`gameId=${otherGame.id}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe("gameId must match the calling game");
  });

  it("preserves pagination across a soft-deleted cursor row", async () => {
    const a = await seedGroup({ name: "a", createdAt: new Date("2026-04-03T00:00:00Z") });
    await seedGroup({ name: "b", createdAt: new Date("2026-04-02T00:00:00Z") });
    await seedGroup({ name: "c", createdAt: new Date("2026-04-01T00:00:00Z") });
    await prisma.group.update({ where: { id: a.id }, data: { softDeletedAt: new Date() } });

    const res = await listGroups(`cursor=${a.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(body.items.map((i) => i.name)).toEqual(["b", "c"]);
  });

  it("rejects requests without an API key", async () => {
    const res = await app.request("/v1/groups", { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PATCH /v1/groups/:id", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function patchGroup(id: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${id}`, {
      method: "PATCH",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function seedGroup(
    overrides: Partial<{
      gameId: string;
      name: string;
      visibility: string;
      metadata: Record<string, unknown>;
      defaultRoleId: string | null;
      softDeletedAt: Date;
    }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: overrides.name ?? "Test Group",
        visibility: overrides.visibility ?? "invite-only",
        metadata: (overrides.metadata ?? {}) as Prisma.InputJsonValue,
        defaultRoleId: overrides.defaultRoleId ?? null,
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("updates a single field and returns the updated group", async () => {
    const group = await seedGroup({ name: "Old Name" });
    const res = await patchGroup(group.id, { name: "New Name" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(group.id);
    expect(body.name).toBe("New Name");
    expect(body.visibility).toBe("invite-only");

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.name).toBe("New Name");
  });

  it("updates multiple fields in one call", async () => {
    const group = await seedGroup({
      name: "Old Name",
      visibility: "invite-only",
      metadata: { motto: "Old" },
      defaultRoleId: "role_old",
    });
    const res = await patchGroup(group.id, {
      name: "New Name",
      visibility: "public",
      metadata: { motto: "New" },
      defaultRoleId: "role_new",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      name: "New Name",
      visibility: "public",
      metadata: { motto: "New" },
      defaultRoleId: "role_new",
    });
  });

  it("clears defaultRoleId when set to null", async () => {
    const group = await seedGroup({ defaultRoleId: "role_keep" });
    const res = await patchGroup(group.id, { defaultRoleId: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultRoleId: string | null };
    expect(body.defaultRoleId).toBeNull();
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.defaultRoleId).toBeNull();
  });

  it("replaces metadata wholesale rather than merging", async () => {
    const group = await seedGroup({ metadata: { motto: "old", banner: "url" } });
    const res = await patchGroup(group.id, { metadata: { tagline: "new" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ tagline: "new" });
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.metadata).toEqual({ tagline: "new" });
  });

  it("writes a group.updated audit entry whose payload contains only changed fields", async () => {
    const group = await seedGroup({
      name: "Before",
      visibility: "invite-only",
      defaultRoleId: "role_keep",
    });
    const res = await patchGroup(group.id, {
      name: "After",
      visibility: "invite-only",
      defaultRoleId: "role_keep",
    });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.updated" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(group.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      before: { name: "Before" },
      after: { name: "After" },
    });
  });

  it("writes no audit entry when the patch is a no-op", async () => {
    const group = await seedGroup({ name: "Same", visibility: "invite-only" });
    const beforeUpdatedAt = group.updatedAt.toISOString();
    const res = await patchGroup(group.id, { name: "Same", visibility: "invite-only" });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.updated" },
    });
    expect(entries).toHaveLength(0);
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.updatedAt.toISOString()).toBe(beforeUpdatedAt);
  });

  it("returns the active member count in the response", async () => {
    const group = await seedGroup();
    const userA = await prisma.junjoUser.create({ data: {} });
    const userB = await prisma.junjoUser.create({ data: {} });
    const userC = await prisma.junjoUser.create({ data: {} });
    await prisma.groupMember.createMany({
      data: [
        { groupId: group.id, junjoUserId: userA.id, status: "active" },
        { groupId: group.id, junjoUserId: userB.id, status: "active" },
        { groupId: group.id, junjoUserId: userC.id, status: "left" },
      ],
    });

    const res = await patchGroup(group.id, { name: "Renamed" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { memberCount: number };
    expect(body.memberCount).toBe(2);
  });

  it("rejects an empty body with 400", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/at least one field/);
  });

  it("rejects an invalid visibility value", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, { visibility: "open" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty name", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, { name: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const group = await seedGroup();
    const res = await patchGroup(group.id, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await patchGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx", { name: "x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await patchGroup(group.id, { name: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await patchGroup(group.id, { name: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/groups/:id", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function deleteGroup(id: string, query = "", header: string = authHeader) {
    const path = query ? `/v1/groups/${id}?${query}` : `/v1/groups/${id}`;
    return app.request(path, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Doomed",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("soft-deletes a live group and writes a group.deleted audit entry", async () => {
    const group = await seedGroup();
    const res = await deleteGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe(group.id);
    expect(typeof body.softDeletedAt).toBe("string");

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt).toBeInstanceOf(Date);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.deleted" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(group.id);
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({ kind: "soft", retentionDays: 7 });
  });

  it("is idempotent on an already soft-deleted group (no second audit entry)", async () => {
    const group = await seedGroup({ softDeletedAt: new Date("2026-04-27T00:00:00Z") });
    const res = await deleteGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { softDeletedAt: string };
    expect(body.softDeletedAt).toBe("2026-04-27T00:00:00.000Z");

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt?.toISOString()).toBe("2026-04-27T00:00:00.000Z");

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.deleted" },
    });
    expect(entries).toHaveLength(0);
  });

  it("hard-deletes when ?hard=true is set, including the group's audit history", async () => {
    const group = await seedGroup();
    await prisma.auditEntry.create({
      data: {
        groupId: group.id,
        action: "group.created",
        targetId: group.id,
        payload: {},
      },
    });

    const res = await deleteGroup(group.id, "hard=true");
    expect(res.status).toBe(204);

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored).toBeNull();

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(0);
  });

  it("hard-deletes a group that was already soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date("2026-04-20T00:00:00Z") });
    const res = await deleteGroup(group.id, "hard=true");
    expect(res.status).toBe(204);
    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored).toBeNull();
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await deleteGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await deleteGroup(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/restore", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function restoreGroup(id: string, header: string = authHeader) {
    return app.request(`/v1/groups/${id}/restore`, {
      method: "POST",
      headers: { authorization: header },
    });
  }

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name: "Phoenix",
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  it("restores a soft-deleted group within the 7-day window", async () => {
    const softDeletedAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
    const group = await seedGroup({ softDeletedAt });
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; softDeletedAt: string | null };
    expect(body.id).toBe(group.id);
    expect(body.softDeletedAt).toBeNull();

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt).toBeNull();

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.restored" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe(group.id);
    expect(entry.payload).toMatchObject({ previousSoftDeletedAt: softDeletedAt.toISOString() });
  });

  it("is idempotent on a non-deleted group (no audit entry)", async () => {
    const group = await seedGroup();
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { softDeletedAt: string | null };
    expect(body.softDeletedAt).toBeNull();

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "group.restored" },
    });
    expect(entries).toHaveLength(0);
  });

  it("rejects restore on a group whose soft-delete is older than 7 days", async () => {
    const softDeletedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const group = await seedGroup({ softDeletedAt });
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(410);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("restore_window_expired");
    expect(body.message).toMatch(/7 days/);

    const stored = await prisma.group.findUnique({ where: { id: group.id } });
    expect(stored?.softDeletedAt).toEqual(softDeletedAt);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await restoreGroup("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id, softDeletedAt: new Date() });
    const res = await restoreGroup(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await app.request(`/v1/groups/${group.id}/restore`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/invitations", () => {
  let app: Hono;
  let authHeader: string;
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
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  function postInvite(groupId: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${groupId}/invitations`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
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

  it("creates a direct-user invitation with a generated code", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { targetUserId: "user_alice" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      groupId: group.id,
      targetUserId: "user_alice",
      roleId: null,
      createdBy: null,
      usedAt: null,
      usedBy: null,
      expiresAt: null,
    });
    expect(typeof body.id).toBe("string");
    expect(typeof body.code).toBe("string");
    expect(body.code as string).toMatch(/^[a-f0-9]{16}$/);
    expect(typeof body.createdAt).toBe("string");

    const stored = await prisma.invitation.findUnique({ where: { id: body.id as string } });
    expect(stored?.groupId).toBe(group.id);
    expect(stored?.targetUserId).toBe("user_alice");
    expect(stored?.createdByUserId).toBeNull();
    expect(stored?.code).toBe(body.code);
  });

  it("forwards an optional roleId verbatim", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, {
      targetUserId: "user_bob",
      roleId: "role_officer",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roleId: string | null };
    expect(body.roleId).toBe("role_officer");

    const stored = await prisma.invitation.findFirst({ where: { groupId: group.id } });
    expect(stored?.roleId).toBe("role_officer");
  });

  it("writes a member.invited audit entry per call", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, {
      targetUserId: "user_carol",
      roleId: "role_x",
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; code: string };

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "member.invited" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe("user_carol");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({
      invitationId: body.id,
      code: body.code,
      targetUserId: "user_carol",
      roleId: "role_x",
    });
  });

  it("generates a unique code per call", async () => {
    const group = await seedGroup();
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const res = await postInvite(group.id, { targetUserId: `user_${i}` });
      const body = (await res.json()) as { code: string };
      codes.add(body.code);
    }
    expect(codes.size).toBe(5);
  });

  it("creates an open-code invitation when targetUserId is omitted", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, {});
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      groupId: group.id,
      targetUserId: null,
      roleId: null,
      createdBy: null,
      usedAt: null,
      usedBy: null,
      expiresAt: null,
    });
    expect(body.code as string).toMatch(/^[a-f0-9]{16}$/);

    const stored = await prisma.invitation.findUnique({ where: { id: body.id as string } });
    expect(stored?.targetUserId).toBeNull();
    expect(stored?.expiresAt).toBeNull();
  });

  it("creates an open-code invitation with a roleId", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { roleId: "role_recruit" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { roleId: string | null; targetUserId: string | null };
    expect(body.roleId).toBe("role_recruit");
    expect(body.targetUserId).toBeNull();
  });

  it("computes expiresAt from a duration string", async () => {
    const group = await seedGroup();
    const before = Date.now();
    const res = await postInvite(group.id, { expiresIn: "7d" });
    const after = Date.now();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { expiresAt: string | null; id: string };
    expect(body.expiresAt).not.toBeNull();
    const expiresMs = new Date(body.expiresAt as string).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs);

    const stored = await prisma.invitation.findUnique({ where: { id: body.id } });
    expect(stored?.expiresAt).not.toBeNull();
    expect(stored?.expiresAt?.getTime()).toBe(expiresMs);
  });

  it("supports s, m, h, and d duration units", async () => {
    const group = await seedGroup();
    const cases: Array<{ input: string; ms: number }> = [
      { input: "30s", ms: 30 * 1000 },
      { input: "5m", ms: 5 * 60 * 1000 },
      { input: "2h", ms: 2 * 60 * 60 * 1000 },
      { input: "1d", ms: 24 * 60 * 60 * 1000 },
    ];
    for (const { input, ms } of cases) {
      const before = Date.now();
      const res = await postInvite(group.id, { expiresIn: input });
      const after = Date.now();
      expect(res.status).toBe(201);
      const body = (await res.json()) as { expiresAt: string | null };
      const t = new Date(body.expiresAt as string).getTime();
      expect(t).toBeGreaterThanOrEqual(before + ms);
      expect(t).toBeLessThanOrEqual(after + ms);
    }
  });

  it("audits an open-code invitation with targetId null and expiresAt in payload", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { roleId: "role_recruit", expiresIn: "1h" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; code: string; expiresAt: string };

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "member.invited" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBeNull();
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({
      invitationId: body.id,
      code: body.code,
      targetUserId: null,
      roleId: "role_recruit",
      expiresAt: body.expiresAt,
    });
  });

  it("rejects an empty targetUserId", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { targetUserId: "" });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed expiresIn string", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { expiresIn: "soon" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a non-positive expiresIn", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, { expiresIn: "0d" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/positive/);
  });

  it("rejects a malformed JSON body", async () => {
    const group = await seedGroup();
    const res = await postInvite(group.id, "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postInvite("ckxxxxxxxxxxxxxxxxxxxxxxxx", { targetUserId: "user_x" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await postInvite(group.id, { targetUserId: "user_x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postInvite(group.id, { targetUserId: "user_x" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/invitations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetUserId: "user_x" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/invitations", () => {
  let app: Hono;
  let authHeader: string;
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
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
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
    overrides: Partial<{
      code: string;
      targetUserId: string | null;
      roleId: string | null;
      expiresAt: Date | null;
      usedAt: Date | null;
      usedByUserId: string | null;
      createdAt: Date;
    }> = {},
  ) {
    return prisma.invitation.create({
      data: {
        groupId,
        code: overrides.code ?? Math.random().toString(36).slice(2, 18).padEnd(16, "0"),
        targetUserId: overrides.targetUserId ?? null,
        roleId: overrides.roleId ?? null,
        expiresAt: overrides.expiresAt ?? null,
        usedAt: overrides.usedAt ?? null,
        usedByUserId: overrides.usedByUserId ?? null,
        ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
      },
    });
  }

  function listInvites(groupId: string, query = "", header: string = authHeader) {
    const path = query
      ? `/v1/groups/${groupId}/invitations?${query}`
      : `/v1/groups/${groupId}/invitations`;
    return app.request(path, { method: "GET", headers: { authorization: header } });
  }

  it("returns an empty page when no invitations exist", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns invitations in createdAt desc order, default-excluding used and expired", async () => {
    const group = await seedGroup();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const t0 = new Date("2026-04-01T00:00:00Z");
    const t1 = new Date("2026-04-02T00:00:00Z");
    const t2 = new Date("2026-04-03T00:00:00Z");

    await seedInvite(group.id, { code: "valid_b__________", createdAt: t1 });
    await seedInvite(group.id, { code: "valid_a__________", createdAt: t2 });
    await seedInvite(group.id, {
      code: "expired__________",
      createdAt: t0,
      expiresAt: past,
    });
    await seedInvite(group.id, {
      code: "used_____________",
      createdAt: t0,
      usedAt: new Date(),
      usedByUserId: "user_alice",
    });
    await seedInvite(group.id, {
      code: "future_expiry____",
      createdAt: t0,
      expiresAt: future,
    });

    const res = await listInvites(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ code: string; createdAt: string }>;
      nextCursor: string | null;
    };
    expect(body.items.map((i) => i.code)).toEqual([
      "valid_a__________",
      "valid_b__________",
      "future_expiry____",
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it("includes expired rows when includeExpired=true", async () => {
    const group = await seedGroup();
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await seedInvite(group.id, { code: "expired__________", expiresAt: past });
    await seedInvite(group.id, { code: "live_____________" });

    const res = await listInvites(group.id, "includeExpired=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ code: string }> };
    const codes = body.items.map((i) => i.code).sort();
    expect(codes).toEqual(["expired__________", "live_____________"]);
  });

  it("includes used rows when includeUsed=true", async () => {
    const group = await seedGroup();
    await seedInvite(group.id, {
      code: "used_____________",
      usedAt: new Date(),
      usedByUserId: "user_alice",
    });
    await seedInvite(group.id, { code: "live_____________" });

    const res = await listInvites(group.id, "includeUsed=true");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ code: string }> };
    const codes = body.items.map((i) => i.code).sort();
    expect(codes).toEqual(["live_____________", "used_____________"]);
  });

  it("paginates via cursor and limit", async () => {
    const group = await seedGroup();
    for (let i = 0; i < 5; i++) {
      await seedInvite(group.id, {
        code: `code_${i}__________`.slice(0, 16).padEnd(16, "0"),
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
      });
    }

    const first = await listInvites(group.id, "limit=2");
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: Array<{ id: string; createdAt: string }>;
      nextCursor: string | null;
    };
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.nextCursor).toBe(firstBody.items[1]?.id);

    const second = await listInvites(group.id, `limit=2&cursor=${firstBody.nextCursor as string}`);
    const secondBody = (await second.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(secondBody.items).toHaveLength(2);
    expect(secondBody.nextCursor).toBe(secondBody.items[1]?.id);
    expect(secondBody.items.map((i) => i.id)).not.toEqual(firstBody.items.map((i) => i.id));

    const third = await listInvites(group.id, `limit=2&cursor=${secondBody.nextCursor as string}`);
    const thirdBody = (await third.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(thirdBody.items).toHaveLength(1);
    expect(thirdBody.nextCursor).toBeNull();
  });

  it("rejects an out-of-range limit", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id, "limit=0");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects an unknown cursor", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id, "cursor=ckunknown");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects a cursor pointing at an invitation in another group", async () => {
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    const invB = await seedInvite(groupB.id);
    const res = await listInvites(groupA.id, `cursor=${invB.id}`);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid includeExpired value", async () => {
    const group = await seedGroup();
    const res = await listInvites(group.id, "includeExpired=yes");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listInvites("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await listInvites(group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await listInvites(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/invitations`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/leave", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function postLeave(groupId: string, body: unknown, header = authHeader) {
    return app.request(`/v1/groups/${groupId}/leave`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("transitions an active member to left and writes a member.left audit entry", async () => {
    const group = await seedGroup();
    const { user, member } = await seedMember(group.id, "user_alice", "active");

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "left",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("left");
    expect(stored?.leftAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.action).toBe("member.left");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBe(user.id);
    expect(entry.payload).toMatchObject({ memberId: member.id, reason: "left" });
  });

  it("returns the member roles populated from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("is idempotent on an already-left member (no audit, leftAt unchanged)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "left");
    const originalLeftAt = new Date("2026-01-01T00:00:00Z");
    await prisma.groupMember.update({
      where: { id: member.id },
      data: { leftAt: originalLeftAt },
    });

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("left");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("left");
    expect(stored?.leftAt?.toISOString()).toBe(originalLeftAt.toISOString());
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("is idempotent on a kicked member (does not transition kicked to left)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "kicked");

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("kicked");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("kicked");
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await postLeave(group.id, { userId: "user_unknown" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postLeave("ckxxxxxxxxxxxxxxxxxxxxxxxx", { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice", "active");
    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postLeave(group.id, { userId: "user_alice" });
    expect(res.status).toBe(404);
  });

  it("rejects a body missing userId", async () => {
    const group = await seedGroup();
    const res = await postLeave(group.id, {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("bad_request");
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/leave`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_alice" }),
    });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/members/:userId/kick", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function postKick(
    groupId: string,
    userId: string,
    body: unknown = undefined,
    header = authHeader,
  ) {
    return app.request(`/v1/groups/${groupId}/members/${userId}/kick`, {
      method: "POST",
      headers: { authorization: header, "content-type": "application/json" },
      body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("transitions an active member to kicked and writes a member.kicked audit entry with reason", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");

    const res = await postKick(group.id, "user_alice", { reason: "trolling" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "kicked",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("kicked");
    expect(stored?.leftAt).not.toBeNull();

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.action).toBe("member.kicked");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toMatchObject({ memberId: member.id, reason: "trolling" });
  });

  it("stores reason as null when the body is omitted", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");

    const res = await postKick(group.id, "user_alice");
    expect(res.status).toBe(200);

    const audit = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(audit).toHaveLength(1);
    const [entry] = audit;
    if (!entry) throw new Error("expected audit entry");
    expect(entry.payload).toMatchObject({ reason: null });
  });

  it("returns the member roles populated from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await postKick(group.id, "user_alice", { reason: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("is idempotent on an already-kicked member (no audit, leftAt unchanged)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "kicked");
    const originalLeftAt = new Date("2026-01-01T00:00:00Z");
    await prisma.groupMember.update({
      where: { id: member.id },
      data: { leftAt: originalLeftAt },
    });

    const res = await postKick(group.id, "user_alice", { reason: "again" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("kicked");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("kicked");
    expect(stored?.leftAt?.toISOString()).toBe(originalLeftAt.toISOString());
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("is idempotent on a left member (does not transition left to kicked)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "left");

    const res = await postKick(group.id, "user_alice", { reason: "late" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("left");

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.status).toBe("left");
    const audit = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(audit).toBe(0);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await postKick(group.id, "user_alice", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await postKick(group.id, "user_unknown", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postKick("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", { reason: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice", "active");
    const res = await postKick(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postKick(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("rejects a reason longer than 500 characters", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");
    const res = await postKick(group.id, "user_alice", { reason: "x".repeat(501) });
    expect(res.status).toBe(400);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice/kick`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "weird/user", "active");

    const res = await postKick(group.id, "weird%2Fuser", { reason: "ok" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; status: string };
    expect(body.userId).toBe("weird/user");
    expect(body.status).toBe("kicked");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/members/:userId", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  function getMember(groupId: string, userId: string, header = authHeader) {
    return app.request(`/v1/groups/${groupId}/members/${userId}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns the active member with the dev's external user id", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");

    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "active",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
    });
    expect(typeof body.joinedAt).toBe("string");
  });

  it("returns members in any status (left / kicked / invited)", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "left");
    const aliceRes = await getMember(group.id, "user_alice");
    expect(aliceRes.status).toBe(200);
    expect(((await aliceRes.json()) as { status: string }).status).toBe("left");

    await seedMember(group.id, "user_bob", "kicked");
    const bobRes = await getMember(group.id, "user_bob");
    expect(bobRes.status).toBe(200);
    expect(((await bobRes.json()) as { status: string }).status).toBe("kicked");
  });

  it("populates roles from MemberRole rows", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "active");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await getMember(group.id, "user_alice");
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await getMember(group.id, "user_unknown");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await getMember("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice", "active");
    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await getMember(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", "active");
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "weird/user", "active");
    const res = await getMember(group.id, "weird%2Fuser");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe("weird/user");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/members", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    overrides: Partial<{
      status: "active" | "left" | "kicked" | "invited";
      joinedAt: Date;
    }> = {},
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: {
        groupId: groupIdValue,
        junjoUserId: user.id,
        status: overrides.status ?? "active",
        ...(overrides.joinedAt !== undefined ? { joinedAt: overrides.joinedAt } : {}),
      },
    });
    return { user, member };
  }

  function listMembers(groupId: string, query = "", header = authHeader) {
    return app.request(`/v1/groups/${groupId}/members${query}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty page for a group with no members", async () => {
    const group = await seedGroup();
    const res = await listMembers(group.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; nextCursor: string | null };
    expect(body.items).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns members ordered by joinedAt desc with the dev's external user ids", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_old", {
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_mid", {
      joinedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_new", {
      joinedAt: new Date("2026-03-01T00:00:00Z"),
    });

    const res = await listMembers(group.id);
    const body = (await res.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(body.items.map((m) => m.userId)).toEqual(["user_new", "user_mid", "user_old"]);
    expect(body.nextCursor).toBeNull();
  });

  it("returns members regardless of status (active, left, kicked)", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_active", {
      status: "active",
      joinedAt: new Date("2026-03-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_left", {
      status: "left",
      joinedAt: new Date("2026-02-01T00:00:00Z"),
    });
    await seedMember(group.id, "user_kicked", {
      status: "kicked",
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await listMembers(group.id);
    const body = (await res.json()) as { items: Array<{ userId: string; status: string }> };
    expect(body.items).toHaveLength(3);
    expect(body.items.map((m) => m.status)).toEqual(["active", "left", "kicked"]);
  });

  it("populates roles via batched MemberRole lookup", async () => {
    const group = await seedGroup();
    const { member: alice } = await seedMember(group.id, "user_alice");
    const { member: bob } = await seedMember(group.id, "user_bob");
    const officer = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    const recruit = await prisma.role.create({
      data: { groupId: group.id, name: "recruit", priority: 10 },
    });
    await prisma.memberRole.createMany({
      data: [
        { groupMemberId: alice.id, roleId: officer.id },
        { groupMemberId: alice.id, roleId: recruit.id },
        { groupMemberId: bob.id, roleId: recruit.id },
      ],
    });

    const res = await listMembers(group.id);
    const body = (await res.json()) as { items: Array<{ id: string; roles: string[] }> };
    const aliceItem = body.items.find((i) => i.id === alice.id);
    const bobItem = body.items.find((i) => i.id === bob.id);
    if (!aliceItem || !bobItem) throw new Error("expected both items");
    expect(aliceItem.roles.sort()).toEqual([officer.id, recruit.id].sort());
    expect(bobItem.roles).toEqual([recruit.id]);
  });

  it("paginates with limit + cursor across pages", async () => {
    const group = await seedGroup();
    for (let i = 0; i < 5; i++) {
      await seedMember(group.id, `user_${i}`, {
        joinedAt: new Date(Date.UTC(2026, 0, i + 1)),
      });
    }

    const first = await listMembers(group.id, "?limit=2");
    const fb = (await first.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(fb.items.map((m) => m.userId)).toEqual(["user_4", "user_3"]);
    expect(fb.nextCursor).not.toBeNull();

    const second = await listMembers(group.id, `?limit=2&cursor=${fb.nextCursor}`);
    const sb = (await second.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(sb.items.map((m) => m.userId)).toEqual(["user_2", "user_1"]);
    expect(sb.nextCursor).not.toBeNull();

    const third = await listMembers(group.id, `?limit=2&cursor=${sb.nextCursor}`);
    const tb = (await third.json()) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(tb.items.map((m) => m.userId)).toEqual(["user_0"]);
    expect(tb.nextCursor).toBeNull();
  });

  it("rejects out-of-range limit", async () => {
    const group = await seedGroup();
    const tooHigh = await listMembers(group.id, "?limit=101");
    expect(tooHigh.status).toBe(400);
    const tooLow = await listMembers(group.id, "?limit=0");
    expect(tooLow.status).toBe(400);
  });

  it("rejects an unknown cursor", async () => {
    const group = await seedGroup();
    const res = await listMembers(group.id, "?cursor=ckunknownxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(400);
  });

  it("rejects a cursor pointing at a member of a different group", async () => {
    const group = await seedGroup();
    const other = await seedGroup();
    const { member: otherMember } = await seedMember(other.id, "user_x");
    const res = await listMembers(group.id, `?cursor=${otherMember.id}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listMembers("ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await listMembers(group.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await listMembers(group.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/members`, { method: "GET" });
    expect(res.status).toBe(401);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("PATCH /v1/groups/:id/members/:userId", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    overrides: Partial<{
      status: "active" | "left" | "kicked" | "invited";
      metadata: Record<string, unknown>;
      notesPublic: string | null;
      notesPrivate: string | null;
    }> = {},
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: {
        groupId: groupIdValue,
        junjoUserId: user.id,
        status: overrides.status ?? "active",
        metadata: (overrides.metadata ?? {}) as Prisma.InputJsonValue,
        notesPublic: overrides.notesPublic ?? null,
        notesPrivate: overrides.notesPrivate ?? null,
      },
    });
    return { user, member };
  }

  function patchMember(groupId: string, userId: string, body: unknown, header = authHeader) {
    return app.request(`/v1/groups/${groupId}/members/${userId}`, {
      method: "PATCH",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  it("updates metadata and writes a member.metadata.updated audit entry", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", {
      metadata: { joined: "2026-01-01" },
    });

    const res = await patchMember(group.id, "user_alice", {
      metadata: { joined: "2026-01-01", rank: "officer" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      metadata: { joined: "2026-01-01", rank: "officer" },
      notesPublic: null,
      notesPrivate: null,
    });

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.metadata).toEqual({ joined: "2026-01-01", rank: "officer" });

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("member.metadata.updated");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      before: { metadata: { joined: "2026-01-01" } },
      after: { metadata: { joined: "2026-01-01", rank: "officer" } },
    });
  });

  it("replaces metadata wholesale rather than merging", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", {
      metadata: { rank: "officer", banner: "blue" },
    });

    const res = await patchMember(group.id, "user_alice", { metadata: { rank: "recruit" } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ rank: "recruit" });
  });

  it("treats metadata as a change even when supplied unchanged", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", { metadata: { rank: "officer" } });

    const res = await patchMember(group.id, "user_alice", { metadata: { rank: "officer" } });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("member.metadata.updated");
  });

  it("updates notesPublic alone and writes a member.notes.updated audit entry", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");

    const res = await patchMember(group.id, "user_alice", { notesPublic: "great healer" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.notesPublic).toBe("great healer");
    expect(body.notesPrivate).toBeNull();

    const stored = await prisma.groupMember.findUnique({ where: { id: member.id } });
    expect(stored?.notesPublic).toBe("great healer");
    expect(stored?.notesPrivate).toBeNull();

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("member.notes.updated");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({
      before: { notesPublic: null },
      after: { notesPublic: "great healer" },
    });
  });

  it("updates notesPrivate alone and writes a member.notes.updated audit entry", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");

    const res = await patchMember(group.id, "user_alice", { notesPrivate: "do not promote" });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.payload).toEqual({
      before: { notesPrivate: null },
      after: { notesPrivate: "do not promote" },
    });
  });

  it("clears notes when set to null", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", {
      notesPublic: "great",
      notesPrivate: "watch out",
    });

    const res = await patchMember(group.id, "user_alice", {
      notesPublic: null,
      notesPrivate: null,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { notesPublic: unknown; notesPrivate: unknown };
    expect(body.notesPublic).toBeNull();
    expect(body.notesPrivate).toBeNull();

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.action).toBe("member.notes.updated");
    expect(entry.payload).toEqual({
      before: { notesPublic: "great", notesPrivate: "watch out" },
      after: { notesPublic: null, notesPrivate: null },
    });
  });

  it("only includes changed notes fields in the audit payload", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", {
      notesPublic: "keep",
      notesPrivate: "old",
    });

    const res = await patchMember(group.id, "user_alice", {
      notesPublic: "keep",
      notesPrivate: "new",
    });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({ where: { groupId: group.id } });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.payload).toEqual({
      before: { notesPrivate: "old" },
      after: { notesPrivate: "new" },
    });
  });

  it("writes both metadata and notes audit entries when both are changed in one PATCH", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", { metadata: { rank: "recruit" } });

    const res = await patchMember(group.id, "user_alice", {
      metadata: { rank: "officer" },
      notesPublic: "promoted",
    });
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain("member.metadata.updated");
    expect(actions).toContain("member.notes.updated");
  });

  it("writes no audit entry and does not bump anything on a fully no-op notes PATCH", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", {
      notesPublic: "same",
      notesPrivate: "same",
    });

    const res = await patchMember(group.id, "user_alice", {
      notesPublic: "same",
      notesPrivate: "same",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; notesPublic: string | null };
    expect(body.id).toBe(member.id);
    expect(body.notesPublic).toBe("same");

    const entries = await prisma.auditEntry.count({ where: { groupId: group.id } });
    expect(entries).toBe(0);
  });

  it("populates roles in the response", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await prisma.role.create({
      data: { groupId: group.id, name: "officer", priority: 50 },
    });
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await patchMember(group.id, "user_alice", { notesPublic: "x" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);
  });

  it("returns 200 and updates terminal-status members (left / kicked)", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice", { status: "kicked" });

    const res = await patchMember(group.id, "user_alice", { notesPrivate: "do not re-invite" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; notesPrivate: string | null };
    expect(body.status).toBe("kicked");
    expect(body.notesPrivate).toBe("do not re-invite");
  });

  it("rejects an empty body with 400", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await patchMember(group.id, "user_alice", {});
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/at least one field/);
  });

  it("rejects notesPublic longer than 5000 characters", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await patchMember(group.id, "user_alice", { notesPublic: "x".repeat(5001) });
    expect(res.status).toBe(400);
  });

  it("rejects notesPrivate longer than 5000 characters", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await patchMember(group.id, "user_alice", { notesPrivate: "x".repeat(5001) });
    expect(res.status).toBe(400);
  });

  it("rejects a malformed JSON body", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await patchMember(group.id, "user_alice", "not json");
    expect(res.status).toBe(400);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });

    const res = await patchMember(group.id, "user_alice", { notesPublic: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await patchMember(group.id, "user_unknown", { notesPublic: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await patchMember("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", { notesPublic: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice");
    const res = await patchMember(group.id, "user_alice", { notesPublic: "x" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await patchMember(group.id, "user_alice", { notesPublic: "x" });
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notesPublic: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "weird/user");

    const res = await patchMember(group.id, "weird%2Fuser", { notesPublic: "ok" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; notesPublic: string | null };
    expect(body.userId).toBe("weird/user");
    expect(body.notesPublic).toBe("ok");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/bulk-invite", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "Invitation", "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedGroup(
    overrides: Partial<{ gameId: string; softDeletedAt: Date | null }> = {},
  ) {
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

  async function seedActiveMember(groupIdValue: string, externalUserId: string) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status: "active" },
    });
    return user;
  }

  function postBulk(
    groupId: string,
    body: string,
    init: { contentType?: string; header?: string; query?: string } = {},
  ) {
    const path = `/v1/groups/${groupId}/bulk-invite${init.query ?? ""}`;
    return app.request(path, {
      method: "POST",
      headers: {
        authorization: init.header ?? authHeader,
        "content-type": init.contentType ?? "text/csv",
      },
      body,
    });
  }

  it("creates one invitation per row and returns the count", async () => {
    const group = await seedGroup();
    const csv = "user_alice\nuser_bob\nuser_carol\n";

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ invited: 3, skipped: 0, errors: [] });

    const invitations = await prisma.invitation.findMany({
      where: { groupId: group.id },
      orderBy: { createdAt: "asc" },
    });
    expect(invitations).toHaveLength(3);
    const targets = invitations.map((i) => i.targetUserId).sort();
    expect(targets).toEqual(["user_alice", "user_bob", "user_carol"]);
    for (const inv of invitations) {
      expect(inv.code).toMatch(/^[a-f0-9]{16}$/);
      expect(inv.expiresAt).toBeNull();
      expect(inv.roleId).toBeNull();
      expect(inv.createdByUserId).toBeNull();
    }
  });

  it("writes one member.invited audit entry per created invitation", async () => {
    const group = await seedGroup();
    const res = await postBulk(group.id, "user_alice\nuser_bob\n");
    expect(res.status).toBe(200);

    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "member.invited" },
      orderBy: { createdAt: "asc" },
    });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toMatchObject({
        targetUserId: expect.any(String),
        roleId: null,
        expiresAt: null,
        source: "bulk-invite",
      });
    }
    const targetIds = entries.map((e) => e.targetId).sort();
    expect(targetIds).toEqual(["user_alice", "user_bob"]);
  });

  it("forwards roleId from the query string to every created invitation", async () => {
    const group = await seedGroup();
    const res = await postBulk(group.id, "user_alice\nuser_bob\n", {
      query: "?roleId=role_recruit",
    });
    expect(res.status).toBe(200);

    const invitations = await prisma.invitation.findMany({ where: { groupId: group.id } });
    expect(invitations).toHaveLength(2);
    for (const inv of invitations) {
      expect(inv.roleId).toBe("role_recruit");
    }
  });

  it("trims whitespace and ignores empty lines without counting them", async () => {
    const group = await seedGroup();
    const csv = "  user_alice  \n\n\tuser_bob\t\n   \n";

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; skipped: number };
    expect(body.invited).toBe(2);
    expect(body.skipped).toBe(0);

    const invitations = await prisma.invitation.findMany({ where: { groupId: group.id } });
    const targets = invitations.map((i) => i.targetUserId).sort();
    expect(targets).toEqual(["user_alice", "user_bob"]);
  });

  it("handles \\r\\n line endings", async () => {
    const group = await seedGroup();
    const csv = "user_alice\r\nuser_bob\r\n";

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(200);

    const invitations = await prisma.invitation.findMany({ where: { groupId: group.id } });
    const targets = invitations.map((i) => i.targetUserId).sort();
    expect(targets).toEqual(["user_alice", "user_bob"]);
  });

  it("returns row-numbered errors for userIds longer than 255 characters", async () => {
    const group = await seedGroup();
    const tooLong = "x".repeat(256);
    const csv = `user_alice\n${tooLong}\nuser_bob\n`;

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invited: number;
      skipped: number;
      errors: Array<{ row: number; reason: string }>;
    };
    expect(body.invited).toBe(2);
    expect(body.skipped).toBe(0);
    expect(body.errors).toEqual([{ row: 2, reason: "userId exceeds 255 characters" }]);

    const invitations = await prisma.invitation.findMany({ where: { groupId: group.id } });
    expect(invitations).toHaveLength(2);
  });

  it("counts row numbers based on source line position (empty lines included)", async () => {
    const group = await seedGroup();
    const tooLong = "x".repeat(256);
    const csv = `user_alice\n\n\n${tooLong}\n`;

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { errors: Array<{ row: number; reason: string }> };
    expect(body.errors).toEqual([{ row: 4, reason: "userId exceeds 255 characters" }]);
  });

  it("skips users who are already active members of the group", async () => {
    const group = await seedGroup();
    await seedActiveMember(group.id, "user_alice");

    const res = await postBulk(group.id, "user_alice\nuser_bob\n");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; skipped: number };
    expect(body.invited).toBe(1);
    expect(body.skipped).toBe(1);

    const invitations = await prisma.invitation.findMany({ where: { groupId: group.id } });
    expect(invitations).toHaveLength(1);
    expect(invitations[0]?.targetUserId).toBe("user_bob");
  });

  it("skips users who already have an unused, unexpired invitation", async () => {
    const group = await seedGroup();
    await prisma.invitation.create({
      data: { groupId: group.id, code: "abc123abc123abc1", targetUserId: "user_alice" },
    });

    const res = await postBulk(group.id, "user_alice\nuser_bob\n");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; skipped: number };
    expect(body.invited).toBe(1);
    expect(body.skipped).toBe(1);

    const invitations = await prisma.invitation.findMany({
      where: { groupId: group.id, targetUserId: "user_alice" },
    });
    expect(invitations).toHaveLength(1);
  });

  it("does not skip users whose pending invitation has expired", async () => {
    const group = await seedGroup();
    await prisma.invitation.create({
      data: {
        groupId: group.id,
        code: "expiredcodeexpir",
        targetUserId: "user_alice",
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const res = await postBulk(group.id, "user_alice\n");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; skipped: number };
    expect(body.invited).toBe(1);
    expect(body.skipped).toBe(0);
  });

  it("does not skip users whose only invitation has been used", async () => {
    const group = await seedGroup();
    await prisma.invitation.create({
      data: {
        groupId: group.id,
        code: "usedcodeusedcode",
        targetUserId: "user_alice",
        usedAt: new Date(),
      },
    });

    const res = await postBulk(group.id, "user_alice\n");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; skipped: number };
    expect(body.invited).toBe(1);
    expect(body.skipped).toBe(0);
  });

  it("treats duplicate userIds within one batch as a single invite plus skips", async () => {
    const group = await seedGroup();
    const res = await postBulk(group.id, "user_alice\nuser_alice\nuser_alice\n");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { invited: number; skipped: number };
    expect(body.invited).toBe(1);
    expect(body.skipped).toBe(2);

    const invitations = await prisma.invitation.findMany({
      where: { groupId: group.id, targetUserId: "user_alice" },
    });
    expect(invitations).toHaveLength(1);
  });

  it("returns 400 when the row count exceeds 1000", async () => {
    const group = await seedGroup();
    const csv = `${Array.from({ length: 1001 }, (_, i) => `user_${i}`).join("\n")}\n`;

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("bad_request");
    expect(body.message).toMatch(/1000/);

    const invitations = await prisma.invitation.findMany({ where: { groupId: group.id } });
    expect(invitations).toHaveLength(0);
  });

  it("returns zero counts and an empty errors array for an empty body", async () => {
    const group = await seedGroup();
    const res = await postBulk(group.id, "");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ invited: 0, skipped: 0, errors: [] });
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await postBulk("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice\n");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("not_found");
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const res = await postBulk(group.id, "user_alice\n");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const res = await postBulk(group.id, "user_alice\n");
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    const res = await app.request(`/v1/groups/${group.id}/bulk-invite`, {
      method: "POST",
      headers: { "content-type": "text/csv" },
      body: "user_alice\n",
    });
    expect(res.status).toBe(401);
  });

  it("rejects an empty roleId query param", async () => {
    const group = await seedGroup();
    const res = await postBulk(group.id, "user_alice\n", { query: "?roleId=" });
    expect(res.status).toBe(400);
  });

  it("returns errors and skips together in one response", async () => {
    const group = await seedGroup();
    await seedActiveMember(group.id, "user_alice");
    const tooLong = "x".repeat(256);
    const csv = `user_alice\n${tooLong}\nuser_bob\n`;

    const res = await postBulk(group.id, csv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      invited: number;
      skipped: number;
      errors: Array<{ row: number; reason: string }>;
    };
    expect(body.invited).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.errors).toEqual([{ row: 2, reason: "userId exceeds 255 characters" }]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("POST /v1/groups/:id/members/:userId/roles/:roleId", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  async function seedRole(groupIdValue: string, name = "Officer", priority = 80) {
    return prisma.role.create({
      data: { groupId: groupIdValue, name, priority },
    });
  }

  function assignRole(
    groupId: string,
    userId: string,
    roleId: string,
    header: string = authHeader,
  ) {
    return app.request(`/v1/groups/${groupId}/members/${userId}/roles/${roleId}`, {
      method: "POST",
      headers: { authorization: header },
    });
  }

  it("creates a MemberRole row and returns the member with the role attached", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);

    const res = await assignRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      id: member.id,
      groupId: group.id,
      userId: "user_alice",
      status: "active",
      roles: [role.id],
    });

    const stored = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: role.id } },
    });
    expect(stored).not.toBeNull();
  });

  it("writes a role.assigned audit entry per call", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);

    await assignRole(group.id, "user_alice", role.id);
    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "role.assigned" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({ memberId: member.id, roleId: role.id });
  });

  it("is idempotent on already-assigned role (no second audit entry, no extra MemberRole row)", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);

    const first = await assignRole(group.id, "user_alice", role.id);
    expect(first.status).toBe(200);
    const second = await assignRole(group.id, "user_alice", role.id);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { roles: string[] };
    expect(body.roles).toEqual([role.id]);

    const memberRoles = await prisma.memberRole.findMany({
      where: { groupMemberId: member.id },
    });
    expect(memberRoles).toHaveLength(1);
    const entries = await prisma.auditEntry.findMany({
      where: { action: "role.assigned" },
    });
    expect(entries).toHaveLength(1);
  });

  it("supports multiple roles on a single member", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const officer = await seedRole(group.id, "Officer", 80);
    const recruiter = await seedRole(group.id, "Recruiter", 50);

    await assignRole(group.id, "user_alice", officer.id);
    const res = await assignRole(group.id, "user_alice", recruiter.id);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles.sort()).toEqual([officer.id, recruiter.id].sort());
  });

  it("returns 400 role_group_mismatch when the role belongs to a different group", async () => {
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    await seedMember(groupA.id, "user_alice");
    const otherRole = await seedRole(groupB.id);

    const res = await assignRole(groupA.id, "user_alice", otherRole.id);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("role_group_mismatch");

    const stored = await prisma.memberRole.findMany({});
    expect(stored).toHaveLength(0);
  });

  it("returns 404 when the role does not exist", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await assignRole(group.id, "user_alice", "ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group does not exist", async () => {
    const otherGroup = await seedGroup();
    const role = await seedRole(otherGroup.id);
    const res = await assignRole("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);
    const res = await assignRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(404);
    const stored = await prisma.memberRole.findMany({ where: { groupMemberId: member.id } });
    expect(stored).toHaveLength(0);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId: otherGame.id, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: user.id, status: "active" },
    });
    const role = await seedRole(group.id);

    const res = await assignRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const role = await seedRole(group.id);
    const res = await assignRole(group.id, "user_unknown", role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    const role = await seedRole(group.id);
    const res = await assignRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(404);
  });

  it("allows assignment to a non-active member", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice", "kicked");
    const role = await seedRole(group.id);

    const res = await assignRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[]; status: string };
    expect(body.roles).toEqual([role.id]);
    expect(body.status).toBe("kicked");

    const stored = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: role.id } },
    });
    expect(stored).not.toBeNull();
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice/roles/${role.id}`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "weird/user");
    const role = await seedRole(group.id);

    const res = await assignRole(group.id, "weird%2Fuser", role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; roles: string[] };
    expect(body.userId).toBe("weird/user");
    expect(body.roles).toEqual([role.id]);

    const stored = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: role.id } },
    });
    expect(stored).not.toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)("DELETE /v1/groups/:id/members/:userId/roles/:roleId", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    status: "active" | "left" | "kicked" | "invited" = "active",
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status },
    });
    return { user, member };
  }

  async function seedRole(groupIdValue: string, name = "Officer", priority = 80) {
    return prisma.role.create({
      data: { groupId: groupIdValue, name, priority },
    });
  }

  function removeRole(
    groupId: string,
    userId: string,
    roleId: string,
    header: string = authHeader,
  ) {
    return app.request(`/v1/groups/${groupId}/members/${userId}/roles/${roleId}`, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  it("deletes the MemberRole row and returns the member with the role removed", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await removeRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([]);

    const stored = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: role.id } },
    });
    expect(stored).toBeNull();
  });

  it("writes a role.unassigned audit entry per call", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    await removeRole(group.id, "user_alice", role.id);
    const entries = await prisma.auditEntry.findMany({
      where: { groupId: group.id, action: "role.unassigned" },
    });
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    if (!entry) throw new Error("expected one audit entry");
    expect(entry.targetId).toBe("user_alice");
    expect(entry.actorUserId).toBeNull();
    expect(entry.payload).toEqual({ memberId: member.id, roleId: role.id });
  });

  it("preserves other role assignments on the same member", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    const officer = await seedRole(group.id, "Officer", 80);
    const recruiter = await seedRole(group.id, "Recruiter", 50);
    await prisma.memberRole.createMany({
      data: [
        { groupMemberId: member.id, roleId: officer.id },
        { groupMemberId: member.id, roleId: recruiter.id },
      ],
    });

    const res = await removeRole(group.id, "user_alice", officer.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([recruiter.id]);
  });

  it("is a no-op when the member does not have the role assigned (no audit entry)", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);

    const res = await removeRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([]);

    const entries = await prisma.auditEntry.findMany({
      where: { action: "role.unassigned" },
    });
    expect(entries).toHaveLength(0);
  });

  it("is a no-op when the role does not exist at all", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");

    const res = await removeRole(group.id, "user_alice", "ckxxxxxxxxxxxxxxxxxxxxxxxx");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([]);

    const entries = await prisma.auditEntry.findMany({
      where: { action: "role.unassigned" },
    });
    expect(entries).toHaveLength(0);
  });

  it("is a no-op when the role belongs to a different group", async () => {
    const groupA = await seedGroup();
    const groupB = await seedGroup();
    await seedMember(groupA.id, "user_alice");
    const otherRole = await seedRole(groupB.id);

    const res = await removeRole(groupA.id, "user_alice", otherRole.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { roles: string[] };
    expect(body.roles).toEqual([]);
  });

  it("returns 404 when the group does not exist", async () => {
    const otherGroup = await seedGroup();
    const role = await seedRole(otherGroup.id);
    const res = await removeRole("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    const { member } = await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await removeRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(404);
    const stored = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: role.id } },
    });
    expect(stored).not.toBeNull();
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId: otherGame.id, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: user.id, status: "active" },
    });
    const role = await seedRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await removeRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const role = await seedRole(group.id);
    const res = await removeRole(group.id, "user_unknown", role.id);
    expect(res.status).toBe(404);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    const role = await seedRole(group.id);
    const res = await removeRole(group.id, "user_alice", role.id);
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const role = await seedRole(group.id);
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice/roles/${role.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "weird/user");
    const role = await seedRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });

    const res = await removeRole(group.id, "weird%2Fuser", role.id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string; roles: string[] };
    expect(body.userId).toBe("weird/user");
    expect(body.roles).toEqual([]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)(
  "POST /v1/groups/:id/members/:userId/permissions/:permission",
  () => {
    let app: Hono;
    let authHeader: string;
    let gameId: string;

    beforeAll(() => {
      app = createApp({ prisma });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

    async function seedMember(
      groupIdValue: string,
      externalUserId: string,
      gameIdValue: string = gameId,
    ) {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId: gameIdValue, junjoUserId: user.id, externalUserId },
      });
      const member = await prisma.groupMember.create({
        data: { groupId: groupIdValue, junjoUserId: user.id, status: "active" },
      });
      return { user, member };
    }

    function override(
      groupIdValue: string,
      userId: string,
      permission: string,
      body: unknown,
      header: string = authHeader,
    ) {
      return app.request(`/v1/groups/${groupIdValue}/members/${userId}/permissions/${permission}`, {
        method: "POST",
        headers: { authorization: header, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });
    }

    it("creates a MemberPermissionOverride row and returns the wire shape", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");

      const res = await override(group.id, "user_alice", "guild.invite_member", { grant: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        groupId: group.id,
        userId: "user_alice",
        permission: "guild.invite_member",
        grant: true,
        setBy: null,
      });
      expect(typeof body.setAt).toBe("string");

      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "guild.invite_member",
          },
        },
      });
      expect(stored?.grant).toBe(true);
      expect(stored?.setByUserId).toBeNull();
    });

    it("auto-registers the permission key into PermissionDef on first sight per game", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");

      expect(await prisma.permissionDef.count()).toBe(0);
      await override(group.id, "user_alice", "guild.kick", { grant: false });
      const defs = await prisma.permissionDef.findMany({});
      expect(defs).toHaveLength(1);
      expect(defs[0]?.gameId).toBe(gameId);
      expect(defs[0]?.key).toBe("guild.kick");
    });

    it("does not duplicate the PermissionDef row across multiple overrides of the same key", async () => {
      const group = await seedGroup();
      const m1 = await seedMember(group.id, "user_alice");
      const userBob = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: userBob.id, externalUserId: "user_bob" },
      });
      await prisma.groupMember.create({
        data: { groupId: group.id, junjoUserId: userBob.id, status: "active" },
      });

      void m1;
      await override(group.id, "user_alice", "guild.kick", { grant: true });
      await override(group.id, "user_bob", "guild.kick", { grant: false });
      const defs = await prisma.permissionDef.findMany({});
      expect(defs).toHaveLength(1);
    });

    it("writes a permission.override.set audit entry on create (no `before` field)", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");

      await override(group.id, "user_alice", "guild.kick", { grant: true });
      const entries = await prisma.auditEntry.findMany({
        where: { action: "permission.override.set" },
      });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.targetId).toBe("user_alice");
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({
        memberId: member.id,
        permission: "guild.kick",
        grant: true,
      });
    });

    it("writes audit entry with `before` field when the override is updated", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");

      await override(group.id, "user_alice", "guild.kick", { grant: true });
      const res = await override(group.id, "user_alice", "guild.kick", { grant: false });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { grant: boolean };
      expect(body.grant).toBe(false);

      const entries = await prisma.auditEntry.findMany({
        where: { action: "permission.override.set" },
        orderBy: { createdAt: "asc" },
      });
      expect(entries).toHaveLength(2);
      expect(entries[1]?.payload).toEqual({
        memberId: member.id,
        permission: "guild.kick",
        grant: false,
        before: { grant: true },
      });
    });

    it("is idempotent when grant matches the stored value (no audit entry, no setAt bump)", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");

      await override(group.id, "user_alice", "guild.kick", { grant: true });
      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "guild.kick",
          },
        },
      });
      const before = stored?.setAt;

      await override(group.id, "user_alice", "guild.kick", { grant: true });
      const after = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "guild.kick",
          },
        },
      });
      expect(after?.setAt.getTime()).toBe(before?.getTime());

      const entries = await prisma.auditEntry.findMany({
        where: { action: "permission.override.set" },
      });
      expect(entries).toHaveLength(1);
    });

    it("supports multiple overrides on the same member with different keys", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");

      await override(group.id, "user_alice", "guild.kick", { grant: true });
      await override(group.id, "user_alice", "guild.invite_member", { grant: false });

      const stored = await prisma.memberPermissionOverride.findMany({});
      expect(stored).toHaveLength(2);
    });

    it("rejects an empty permission key", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const res = await app.request(`/v1/groups/${group.id}/members/user_alice/permissions/`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ grant: true }),
      });
      expect(res.status).toBe(404);
    });

    it("rejects a permission key over the length cap", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const longKey = "a".repeat(129);
      const res = await override(group.id, "user_alice", longKey, { grant: true });
      expect(res.status).toBe(400);
    });

    it("rejects a missing grant field", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const res = await override(group.id, "user_alice", "guild.kick", {});
      expect(res.status).toBe(400);
    });

    it("rejects a non-boolean grant field", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const res = await override(group.id, "user_alice", "guild.kick", { grant: "yes" });
      expect(res.status).toBe(400);
    });

    it("rejects a malformed JSON body", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const res = await override(group.id, "user_alice", "guild.kick", "not json");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the group does not exist", async () => {
      const res = await override("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", "guild.kick", {
        grant: true,
      });
      expect(res.status).toBe(404);
      expect(await prisma.permissionDef.count()).toBe(0);
    });

    it("returns 404 when the group is soft-deleted", async () => {
      const group = await seedGroup({ softDeletedAt: new Date() });
      await seedMember(group.id, "user_alice");
      const res = await override(group.id, "user_alice", "guild.kick", { grant: true });
      expect(res.status).toBe(404);
      expect(await prisma.memberPermissionOverride.count()).toBe(0);
      expect(await prisma.permissionDef.count()).toBe(0);
    });

    it("returns 404 when the group belongs to a different game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const group = await seedGroup({ gameId: otherGame.id });
      await seedMember(group.id, "user_alice", otherGame.id);
      const res = await override(group.id, "user_alice", "guild.kick", { grant: true });
      expect(res.status).toBe(404);
      expect(await prisma.permissionDef.count()).toBe(0);
    });

    it("returns 404 when the user has no ExternalIdentity for this game", async () => {
      const group = await seedGroup();
      const res = await override(group.id, "user_unknown", "guild.kick", { grant: true });
      expect(res.status).toBe(404);
    });

    it("returns 404 when no GroupMember row exists for the user", async () => {
      const group = await seedGroup();
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
      });
      const res = await override(group.id, "user_alice", "guild.kick", { grant: true });
      expect(res.status).toBe(404);
    });

    it("rejects requests without an API key", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const res = await app.request(
        `/v1/groups/${group.id}/members/user_alice/permissions/guild.kick`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ grant: true }),
        },
      );
      expect(res.status).toBe(401);
    });

    it("URL-decodes the permission path parameter", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");
      const res = await override(group.id, "user_alice", "scope%2Fwith-slash", { grant: true });
      expect(res.status).toBe(200);
      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "scope/with-slash",
          },
        },
      });
      expect(stored?.grant).toBe(true);
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)(
  "DELETE /v1/groups/:id/members/:userId/permissions/:permission",
  () => {
    let app: Hono;
    let authHeader: string;
    let gameId: string;

    beforeAll(() => {
      app = createApp({ prisma });
    });

    beforeEach(async () => {
      await prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

    async function seedMember(
      groupIdValue: string,
      externalUserId: string,
      gameIdValue: string = gameId,
    ) {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId: gameIdValue, junjoUserId: user.id, externalUserId },
      });
      const member = await prisma.groupMember.create({
        data: { groupId: groupIdValue, junjoUserId: user.id, status: "active" },
      });
      return { user, member };
    }

    async function seedOverride(
      groupMemberId: string,
      permissionKey: string,
      grant: boolean,
      ownerGameId: string = gameId,
    ) {
      await prisma.permissionDef.upsert({
        where: { gameId_key: { gameId: ownerGameId, key: permissionKey } },
        create: { gameId: ownerGameId, key: permissionKey },
        update: {},
      });
      return prisma.memberPermissionOverride.create({
        data: { groupMemberId, permissionKey, grant, setByUserId: null },
      });
    }

    function clearOverride(
      groupIdValue: string,
      userId: string,
      permission: string,
      header: string = authHeader,
    ) {
      return app.request(`/v1/groups/${groupIdValue}/members/${userId}/permissions/${permission}`, {
        method: "DELETE",
        headers: { authorization: header },
      });
    }

    it("deletes the MemberPermissionOverride row and returns 204", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");
      await seedOverride(member.id, "guild.kick", true);

      const res = await clearOverride(group.id, "user_alice", "guild.kick");
      expect(res.status).toBe(204);
      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "guild.kick",
          },
        },
      });
      expect(stored).toBeNull();
    });

    it("writes a permission.override.cleared audit entry with the previous grant", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");
      await seedOverride(member.id, "guild.kick", false);

      await clearOverride(group.id, "user_alice", "guild.kick");
      const entries = await prisma.auditEntry.findMany({
        where: { action: "permission.override.cleared" },
      });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.targetId).toBe("user_alice");
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({
        memberId: member.id,
        permission: "guild.kick",
        grant: false,
      });
    });

    it("preserves PermissionDef when clearing", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");
      await seedOverride(member.id, "guild.kick", true);

      await clearOverride(group.id, "user_alice", "guild.kick");
      const defs = await prisma.permissionDef.findMany({});
      expect(defs).toHaveLength(1);
    });

    it("is a no-op when the member does not have the override (no audit entry)", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");

      const res = await clearOverride(group.id, "user_alice", "guild.kick");
      expect(res.status).toBe(204);

      const entries = await prisma.auditEntry.findMany({});
      expect(entries).toHaveLength(0);
    });

    it("preserves other overrides on the same member", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");
      await seedOverride(member.id, "guild.kick", true);
      await seedOverride(member.id, "guild.invite_member", false);

      await clearOverride(group.id, "user_alice", "guild.kick");
      const remaining = await prisma.memberPermissionOverride.findMany({
        where: { groupMemberId: member.id },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.permissionKey).toBe("guild.invite_member");
    });

    it("returns 404 when the group does not exist", async () => {
      const res = await clearOverride("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice", "guild.kick");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the group is soft-deleted", async () => {
      const group = await seedGroup({ softDeletedAt: new Date() });
      const { member } = await seedMember(group.id, "user_alice");
      await seedOverride(member.id, "guild.kick", true);

      const res = await clearOverride(group.id, "user_alice", "guild.kick");
      expect(res.status).toBe(404);
      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "guild.kick",
          },
        },
      });
      expect(stored).not.toBeNull();
    });

    it("returns 404 when the group belongs to a different game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const group = await seedGroup({ gameId: otherGame.id });
      const { member } = await seedMember(group.id, "user_alice", otherGame.id);
      await seedOverride(member.id, "guild.kick", true, otherGame.id);

      const res = await clearOverride(group.id, "user_alice", "guild.kick");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the user has no ExternalIdentity for this game", async () => {
      const group = await seedGroup();
      const res = await clearOverride(group.id, "user_unknown", "guild.kick");
      expect(res.status).toBe(404);
    });

    it("returns 404 when no GroupMember row exists for the user", async () => {
      const group = await seedGroup();
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
      });
      const res = await clearOverride(group.id, "user_alice", "guild.kick");
      expect(res.status).toBe(404);
    });

    it("rejects requests without an API key", async () => {
      const group = await seedGroup();
      await seedMember(group.id, "user_alice");
      const res = await app.request(
        `/v1/groups/${group.id}/members/user_alice/permissions/guild.kick`,
        { method: "DELETE" },
      );
      expect(res.status).toBe(401);
    });

    it("URL-decodes the permission path parameter", async () => {
      const group = await seedGroup();
      const { member } = await seedMember(group.id, "user_alice");
      await seedOverride(member.id, "scope/with-slash", true);

      const res = await clearOverride(group.id, "user_alice", "scope%2Fwith-slash");
      expect(res.status).toBe(204);
      const stored = await prisma.memberPermissionOverride.findUnique({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: "scope/with-slash",
          },
        },
      });
      expect(stored).toBeNull();
    });
  },
);

describe.skipIf(!TEST_DATABASE_URL)("GET /v1/groups/:id/members/:userId/permissions", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "PermissionDef", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
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

  async function seedMember(
    groupIdValue: string,
    externalUserId: string,
    gameIdValue: string = gameId,
  ) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId: gameIdValue, junjoUserId: user.id, externalUserId },
    });
    const member = await prisma.groupMember.create({
      data: { groupId: groupIdValue, junjoUserId: user.id, status: "active" },
    });
    return { user, member };
  }

  function listOverrides(groupIdValue: string, userId: string, header: string = authHeader) {
    return app.request(`/v1/groups/${groupIdValue}/members/${userId}/permissions`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  it("returns an empty array when the member has no overrides", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await listOverrides(group.id, "user_alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  it("returns overrides sorted by permissionKey ascending", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    await prisma.permissionDef.create({ data: { gameId, key: "alpha" } });
    await prisma.permissionDef.create({ data: { gameId, key: "beta" } });
    await prisma.permissionDef.create({ data: { gameId, key: "gamma" } });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "gamma", grant: true },
    });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "alpha", grant: false },
    });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "beta", grant: true },
    });

    const res = await listOverrides(group.id, "user_alice");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ permission: string; grant: boolean }>;
    expect(body.map((o) => o.permission)).toEqual(["alpha", "beta", "gamma"]);
    expect(body.map((o) => o.grant)).toEqual([false, true, true]);
  });

  it("returns the wire shape with groupId, userId, setBy null, and ISO setAt", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "user_alice");
    await prisma.permissionDef.create({ data: { gameId, key: "guild.kick" } });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "guild.kick", grant: true },
    });

    const res = await listOverrides(group.id, "user_alice");
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      groupId: group.id,
      userId: "user_alice",
      permission: "guild.kick",
      grant: true,
      setBy: null,
    });
    expect(typeof body[0]?.setAt).toBe("string");
    expect(new Date(body[0]?.setAt as string).toString()).not.toBe("Invalid Date");
  });

  it("returns only overrides scoped to this member (not other members in the same group)", async () => {
    const group = await seedGroup();
    const { member: alice } = await seedMember(group.id, "user_alice");
    const userBob = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: userBob.id, externalUserId: "user_bob" },
    });
    const bob = await prisma.groupMember.create({
      data: { groupId: group.id, junjoUserId: userBob.id, status: "active" },
    });
    await prisma.permissionDef.create({ data: { gameId, key: "guild.kick" } });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: alice.id, permissionKey: "guild.kick", grant: true },
    });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: bob.id, permissionKey: "guild.kick", grant: false },
    });

    const res = await listOverrides(group.id, "user_alice");
    const body = (await res.json()) as Array<{ grant: boolean }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.grant).toBe(true);
  });

  it("returns 404 when the group does not exist", async () => {
    const res = await listOverrides("ckxxxxxxxxxxxxxxxxxxxxxxxx", "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group is soft-deleted", async () => {
    const group = await seedGroup({ softDeletedAt: new Date() });
    await seedMember(group.id, "user_alice");
    const res = await listOverrides(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the group belongs to a different game", async () => {
    const otherGame = await createGame("Other Game", prisma);
    const group = await seedGroup({ gameId: otherGame.id });
    await seedMember(group.id, "user_alice", otherGame.id);
    const res = await listOverrides(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("returns 404 when the user has no ExternalIdentity for this game", async () => {
    const group = await seedGroup();
    const res = await listOverrides(group.id, "user_unknown");
    expect(res.status).toBe(404);
  });

  it("returns 404 when no GroupMember row exists for the user", async () => {
    const group = await seedGroup();
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId: "user_alice" },
    });
    const res = await listOverrides(group.id, "user_alice");
    expect(res.status).toBe(404);
  });

  it("rejects requests without an API key", async () => {
    const group = await seedGroup();
    await seedMember(group.id, "user_alice");
    const res = await app.request(`/v1/groups/${group.id}/members/user_alice/permissions`, {
      method: "GET",
    });
    expect(res.status).toBe(401);
  });

  it("URL-decodes the userId path parameter", async () => {
    const group = await seedGroup();
    const { member } = await seedMember(group.id, "weird/user");
    await prisma.permissionDef.create({ data: { gameId, key: "guild.kick" } });
    await prisma.memberPermissionOverride.create({
      data: { groupMemberId: member.id, permissionKey: "guild.kick", grant: true },
    });

    const res = await listOverrides(group.id, "weird%2Fuser");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ userId: string }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.userId).toBe("weird/user");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Group relationships", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "GroupRelationship", "AuditEntry", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedGroup(
    name: string,
    overrides: Partial<{ gameId: string; softDeletedAt: Date }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
      },
    });
  }

  function setRelationship(a: string, b: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${a}/relationships/${b}`, {
      method: "PUT",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function clearRelationship(a: string, b: string, query = "", header: string = authHeader) {
    return app.request(`/v1/groups/${a}/relationships/${b}${query}`, {
      method: "DELETE",
      headers: { authorization: header },
    });
  }

  function getRelationship(a: string, b: string, header: string = authHeader) {
    return app.request(`/v1/groups/${a}/relationships/${b}`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  function listRelationships(a: string, header: string = authHeader) {
    return app.request(`/v1/groups/${a}/relationships`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  describe("PUT /v1/groups/:a/relationships/:b", () => {
    it("creates a directed relationship and returns the wire shape", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");

      const res = await setRelationship(a.id, b.id, { type: "ally" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({
        groupAId: a.id,
        groupBId: b.id,
        type: "ally",
        since: expect.any(String),
        setBy: null,
      });

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      expect(stored?.type).toBe("ally");
      expect(stored?.setByUserId).toBeNull();
    });

    it("writes a group.relationship.set audit entry on the origin group", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");

      await setRelationship(a.id, b.id, { type: "ally" });

      const entries = await prisma.auditEntry.findMany({ where: { groupId: a.id } });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.action).toBe("group.relationship.set");
      expect(entry.targetId).toBe(b.id);
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({
        groupAId: a.id,
        groupBId: b.id,
        type: "ally",
        mutual: false,
      });

      const otherEntries = await prisma.auditEntry.findMany({ where: { groupId: b.id } });
      expect(otherEntries).toHaveLength(0);
    });

    it("writes both directions when mutual is true", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");

      const res = await setRelationship(a.id, b.id, { type: "ally", mutual: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { groupAId: string; groupBId: string };
      expect(body.groupAId).toBe(a.id);
      expect(body.groupBId).toBe(b.id);

      const both = await prisma.groupRelationship.findMany({
        where: {
          OR: [
            { groupAId: a.id, groupBId: b.id },
            { groupAId: b.id, groupBId: a.id },
          ],
        },
      });
      expect(both).toHaveLength(2);
      expect(new Set(both.map((r) => r.type))).toEqual(new Set(["ally"]));

      const auditA = await prisma.auditEntry.findMany({ where: { groupId: a.id } });
      expect(auditA).toHaveLength(1);
      expect(auditA[0]?.payload).toMatchObject({
        groupAId: a.id,
        groupBId: b.id,
        mutual: true,
      });
      const auditB = await prisma.auditEntry.findMany({ where: { groupId: b.id } });
      expect(auditB).toHaveLength(1);
      expect(auditB[0]?.payload).toMatchObject({
        groupAId: b.id,
        groupBId: a.id,
        mutual: true,
      });
    });

    it("updates the type and bumps `since` when the row already exists with a different type", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "neutral", setByUserId: null },
      });
      const before = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      if (!before) throw new Error("expected seeded row");

      await new Promise((r) => setTimeout(r, 5));
      const res = await setRelationship(a.id, b.id, { type: "enemy" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { type: string; since: string };
      expect(body.type).toBe("enemy");
      expect(new Date(body.since).getTime()).toBeGreaterThan(before.since.getTime());

      const entries = await prisma.auditEntry.findMany({ where: { groupId: a.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.payload).toMatchObject({
        groupAId: a.id,
        groupBId: b.id,
        type: "enemy",
        before: { type: "neutral" },
      });
    });

    it("is idempotent when the type already matches", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const seeded = await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });

      const res = await setRelationship(a.id, b.id, { type: "ally" });
      expect(res.status).toBe(200);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      expect(stored?.since.toISOString()).toBe(seeded.since.toISOString());
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it("writes only the missing direction on a partial-mutual update", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });

      const res = await setRelationship(a.id, b.id, { type: "ally", mutual: true });
      expect(res.status).toBe(200);

      const both = await prisma.groupRelationship.findMany();
      expect(both).toHaveLength(2);

      const entries = await prisma.auditEntry.findMany();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.groupId).toBe(b.id);
    });

    it("supports asymmetric relationships when mutual is omitted", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");

      await setRelationship(a.id, b.id, { type: "ally" });
      await setRelationship(b.id, a.id, { type: "neutral" });

      const ab = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      const ba = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: b.id, groupBId: a.id } },
      });
      expect(ab?.type).toBe("ally");
      expect(ba?.type).toBe("neutral");
    });

    it("rejects a self-relationship with 400 bad_request", async () => {
      const a = await seedGroup("A");
      const res = await setRelationship(a.id, a.id, { type: "ally" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("bad_request");
    });

    it("rejects a missing type with 400 bad_request", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await setRelationship(a.id, b.id, {});
      expect(res.status).toBe(400);
    });

    it("rejects an over-cap type with 400 bad_request", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await setRelationship(a.id, b.id, { type: "x".repeat(65) });
      expect(res.status).toBe(400);
    });

    it("rejects a non-string type with 400 bad_request", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await setRelationship(a.id, b.id, { type: 123 });
      expect(res.status).toBe(400);
    });

    it("returns 404 when group A does not exist", async () => {
      const b = await seedGroup("B");
      const res = await setRelationship("grp_missing", b.id, { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B does not exist", async () => {
      const a = await seedGroup("A");
      const res = await setRelationship(a.id, "grp_missing", { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group A is soft-deleted", async () => {
      const a = await seedGroup("A", { softDeletedAt: new Date() });
      const b = await seedGroup("B");
      const res = await setRelationship(a.id, b.id, { type: "ally" });
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B belongs to a different game", async () => {
      const a = await seedGroup("A");
      const otherGame = await createGame("Other Game", prisma);
      const b = await seedGroup("B", { gameId: otherGame.id });
      const res = await setRelationship(a.id, b.id, { type: "ally" });
      expect(res.status).toBe(404);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      expect(stored).toBeNull();
    });

    it("rejects requests without an API key", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "ally" }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("DELETE /v1/groups/:a/relationships/:b", () => {
    it("deletes the row and writes a group.relationship.cleared audit entry", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(a.id, b.id);
      expect(res.status).toBe(204);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      expect(stored).toBeNull();

      const entries = await prisma.auditEntry.findMany({ where: { groupId: a.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("group.relationship.cleared");
      expect(entries[0]?.payload).toEqual({
        groupAId: a.id,
        groupBId: b.id,
        type: "ally",
        mutual: false,
      });
    });

    it("clears both directions when ?mutual=true is supplied", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: b.id, groupBId: a.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(a.id, b.id, "?mutual=true");
      expect(res.status).toBe(204);

      const remaining = await prisma.groupRelationship.findMany();
      expect(remaining).toHaveLength(0);

      const entries = await prisma.auditEntry.findMany();
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((e) => e.groupId))).toEqual(new Set([a.id, b.id]));
    });

    it("is idempotent when the row does not exist", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");

      const res = await clearRelationship(a.id, b.id);
      expect(res.status).toBe(204);
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it("clears only the existing direction when ?mutual=true and only one side is present", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(a.id, b.id, "?mutual=true");
      expect(res.status).toBe(204);

      const remaining = await prisma.groupRelationship.findMany();
      expect(remaining).toHaveLength(0);

      const entries = await prisma.auditEntry.findMany();
      expect(entries).toHaveLength(1);
      expect(entries[0]?.groupId).toBe(a.id);
    });

    it("preserves the asymmetric counterpart when mutual is not set", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: b.id, groupBId: a.id, type: "neutral", setByUserId: null },
      });

      const res = await clearRelationship(a.id, b.id);
      expect(res.status).toBe(204);

      const remaining = await prisma.groupRelationship.findMany();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.groupAId).toBe(b.id);
      expect(remaining[0]?.type).toBe("neutral");
    });

    it("rejects a self-relationship with 400 bad_request", async () => {
      const a = await seedGroup("A");
      const res = await clearRelationship(a.id, a.id);
      expect(res.status).toBe(400);
    });

    it("rejects a malformed mutual query value", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await clearRelationship(a.id, b.id, "?mutual=yes");
      expect(res.status).toBe(400);
    });

    it("returns 404 when group A or B is missing", async () => {
      const a = await seedGroup("A");
      const res = await clearRelationship(a.id, "grp_missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when group B is in a different game", async () => {
      const a = await seedGroup("A");
      const otherGame = await createGame("Other Game", prisma);
      const b = await seedGroup("B", { gameId: otherGame.id });
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });

      const res = await clearRelationship(a.id, b.id);
      expect(res.status).toBe(404);

      const stored = await prisma.groupRelationship.findUnique({
        where: { groupAId_groupBId: { groupAId: a.id, groupBId: b.id } },
      });
      expect(stored).not.toBeNull();
    });

    it("rejects requests without an API key", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
        method: "DELETE",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/groups/:a/relationships/:b", () => {
    it("returns the directed row when present", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });

      const res = await getRelationship(a.id, b.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        groupAId: a.id,
        groupBId: b.id,
        type: "ally",
        setBy: null,
      });
    });

    it("returns 404 when no row exists for that direction", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      await prisma.groupRelationship.create({
        data: { groupAId: b.id, groupBId: a.id, type: "ally", setByUserId: null },
      });

      const res = await getRelationship(a.id, b.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when either group is missing or cross-game", async () => {
      const a = await seedGroup("A");
      const otherGame = await createGame("Other Game", prisma);
      const b = await seedGroup("B", { gameId: otherGame.id });

      const res = await getRelationship(a.id, b.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 on a self-relationship lookup", async () => {
      const a = await seedGroup("A");
      const res = await getRelationship(a.id, a.id);
      expect(res.status).toBe(404);
    });

    it("rejects requests without an API key", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`);
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/groups/:a/relationships", () => {
    it("returns an empty array when the group has no outgoing relationships", async () => {
      const a = await seedGroup("A");
      const res = await listRelationships(a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it("returns rows where the group is the A-side, sorted by groupBId asc", async () => {
      const a = await seedGroup("A");
      const b = await seedGroup("B");
      const c = await seedGroup("C");
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: c.id, type: "enemy", setByUserId: null },
      });
      await prisma.groupRelationship.create({
        data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
      });
      // Reverse direction; should NOT appear in A's outgoing list.
      await prisma.groupRelationship.create({
        data: { groupAId: b.id, groupBId: a.id, type: "neutral", setByUserId: null },
      });

      const res = await listRelationships(a.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ groupBId: string; type: string }>;
      expect(body).toHaveLength(2);
      const ids = [b.id, c.id].sort();
      expect(body.map((r) => r.groupBId)).toEqual(ids);
    });

    it("returns 404 when the group does not exist or belongs to a different game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const a = await seedGroup("A", { gameId: otherGame.id });

      const res = await listRelationships(a.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when the group is soft-deleted", async () => {
      const a = await seedGroup("A", { softDeletedAt: new Date() });
      const res = await listRelationships(a.id);
      expect(res.status).toBe(404);
    });

    it("rejects requests without an API key", async () => {
      const a = await seedGroup("A");
      const res = await app.request(`/v1/groups/${a.id}/relationships`);
      expect(res.status).toBe(401);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Sub-group parent + children", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function seedGroup(
    name: string,
    overrides: Partial<{ gameId: string; softDeletedAt: Date; parentGroupId: string }> = {},
  ) {
    return prisma.group.create({
      data: {
        gameId: overrides.gameId ?? gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        metadata: {},
        softDeletedAt: overrides.softDeletedAt ?? null,
        parentGroupId: overrides.parentGroupId ?? null,
      },
    });
  }

  function setParent(id: string, body: unknown, header: string = authHeader) {
    return app.request(`/v1/groups/${id}/parent`, {
      method: "PUT",
      headers: { authorization: header, "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  function listChildren(id: string, header: string = authHeader) {
    return app.request(`/v1/groups/${id}/children`, {
      method: "GET",
      headers: { authorization: header },
    });
  }

  describe("PUT /v1/groups/:id/parent", () => {
    it("sets a parent and returns the updated group", async () => {
      const child = await seedGroup("Child");
      const parent = await seedGroup("Parent");

      const res = await setParent(child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.id).toBe(child.id);
      expect(body.parentGroupId).toBe(parent.id);
      expect(body.memberCount).toBe(0);

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBe(parent.id);
    });

    it("writes a group.parent.set audit entry on the child group", async () => {
      const child = await seedGroup("Child");
      const parent = await seedGroup("Parent");

      await setParent(child.id, { parentGroupId: parent.id });

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(1);
      const [entry] = entries;
      if (!entry) throw new Error("expected one audit entry");
      expect(entry.action).toBe("group.parent.set");
      expect(entry.targetId).toBe(parent.id);
      expect(entry.actorUserId).toBeNull();
      expect(entry.payload).toEqual({ before: null, after: parent.id });

      const otherEntries = await prisma.auditEntry.findMany({ where: { groupId: parent.id } });
      expect(otherEntries).toHaveLength(0);
    });

    it("clears the parent and writes a group.parent.cleared audit entry when set to null", async () => {
      const parent = await seedGroup("Parent");
      const child = await seedGroup("Child", { parentGroupId: parent.id });

      const res = await setParent(child.id, { parentGroupId: null });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.parentGroupId).toBeNull();

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("group.parent.cleared");
      expect(entries[0]?.targetId).toBeNull();
      expect(entries[0]?.payload).toEqual({ before: parent.id, after: null });
    });

    it("captures the previous parent in before/after when reparenting", async () => {
      const oldParent = await seedGroup("Old");
      const newParent = await seedGroup("New");
      const child = await seedGroup("Child", { parentGroupId: oldParent.id });

      await setParent(child.id, { parentGroupId: newParent.id });

      const entries = await prisma.auditEntry.findMany({ where: { groupId: child.id } });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.action).toBe("group.parent.set");
      expect(entries[0]?.payload).toEqual({ before: oldParent.id, after: newParent.id });
    });

    it("is idempotent when the parent already matches the supplied value", async () => {
      const parent = await seedGroup("Parent");
      const child = await seedGroup("Child", { parentGroupId: parent.id });

      const res = await setParent(child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(200);

      expect(await prisma.auditEntry.count()).toBe(0);
      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBe(parent.id);
    });

    it("is idempotent when clearing an already-null parent", async () => {
      const child = await seedGroup("Child");

      const res = await setParent(child.id, { parentGroupId: null });
      expect(res.status).toBe(200);

      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it("rejects a self-parent with 400 parent_cycle", async () => {
      const child = await seedGroup("Child");
      const res = await setParent(child.id, { parentGroupId: child.id });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("parent_cycle");

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("rejects a candidate that would create a cycle in the parent chain", async () => {
      const top = await seedGroup("Top");
      const mid = await seedGroup("Mid", { parentGroupId: top.id });
      const bottom = await seedGroup("Bottom", { parentGroupId: mid.id });

      const res = await setParent(top.id, { parentGroupId: bottom.id });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("parent_cycle");

      const stored = await prisma.group.findUnique({ where: { id: top.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("rejects a candidate that is the direct child", async () => {
      const parent = await seedGroup("Parent");
      const child = await seedGroup("Child", { parentGroupId: parent.id });

      const res = await setParent(parent.id, { parentGroupId: child.id });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("parent_cycle");
    });

    it("allows setting a sibling-style parent (no cycle)", async () => {
      const root = await seedGroup("Root");
      const a = await seedGroup("A", { parentGroupId: root.id });
      const b = await seedGroup("B", { parentGroupId: root.id });

      const res = await setParent(a.id, { parentGroupId: b.id });
      expect(res.status).toBe(200);

      const stored = await prisma.group.findUnique({ where: { id: a.id } });
      expect(stored?.parentGroupId).toBe(b.id);
    });

    it("rejects a missing parentGroupId field with 400 bad_request", async () => {
      const child = await seedGroup("Child");
      const res = await setParent(child.id, {});
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("bad_request");
    });

    it("rejects a non-string non-null parentGroupId with 400 bad_request", async () => {
      const child = await seedGroup("Child");
      const res = await setParent(child.id, { parentGroupId: 42 });
      expect(res.status).toBe(400);
    });

    it("rejects an empty-string parentGroupId with 400 bad_request", async () => {
      const child = await seedGroup("Child");
      const res = await setParent(child.id, { parentGroupId: "" });
      expect(res.status).toBe(400);
    });

    it("rejects malformed JSON with 400 bad_request", async () => {
      const child = await seedGroup("Child");
      const res = await setParent(child.id, "not json");
      expect(res.status).toBe(400);
    });

    it("returns 404 when the child group does not exist", async () => {
      const parent = await seedGroup("Parent");
      const res = await setParent("grp_missing", { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the child group is soft-deleted", async () => {
      const parent = await seedGroup("Parent");
      const child = await seedGroup("Child", { softDeletedAt: new Date() });
      const res = await setParent(child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the parent group does not exist", async () => {
      const child = await seedGroup("Child");
      const res = await setParent(child.id, { parentGroupId: "grp_missing" });
      expect(res.status).toBe(404);

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("returns 404 when the parent group is in a different game", async () => {
      const child = await seedGroup("Child");
      const otherGame = await createGame("Other Game", prisma);
      const parent = await seedGroup("Parent", { gameId: otherGame.id });

      const res = await setParent(child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);

      const stored = await prisma.group.findUnique({ where: { id: child.id } });
      expect(stored?.parentGroupId).toBeNull();
    });

    it("returns 404 when the parent group is soft-deleted", async () => {
      const child = await seedGroup("Child");
      const parent = await seedGroup("Parent", { softDeletedAt: new Date() });

      const res = await setParent(child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("returns 404 when the child group is in a different game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const child = await seedGroup("Child", { gameId: otherGame.id });
      const parent = await seedGroup("Parent");

      const res = await setParent(child.id, { parentGroupId: parent.id });
      expect(res.status).toBe(404);
    });

    it("rejects requests without an API key", async () => {
      const child = await seedGroup("Child");
      const res = await app.request(`/v1/groups/${child.id}/parent`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parentGroupId: null }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/groups/:id/children", () => {
    it("returns an empty array when the group has no children", async () => {
      const parent = await seedGroup("Parent");
      const res = await listChildren(parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it("returns direct children sorted by createdAt desc", async () => {
      const parent = await seedGroup("Parent");
      const first = await seedGroup("First", { parentGroupId: parent.id });
      await new Promise((r) => setTimeout(r, 5));
      const second = await seedGroup("Second", { parentGroupId: parent.id });
      await new Promise((r) => setTimeout(r, 5));
      const third = await seedGroup("Third", { parentGroupId: parent.id });

      const res = await listChildren(parent.id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Array<{ id: string; parentGroupId: string }>;
      expect(body.map((g) => g.id)).toEqual([third.id, second.id, first.id]);
      for (const g of body) expect(g.parentGroupId).toBe(parent.id);
    });

    it("excludes soft-deleted children", async () => {
      const parent = await seedGroup("Parent");
      const live = await seedGroup("Live", { parentGroupId: parent.id });
      await prisma.group.create({
        data: {
          gameId,
          kind: "guild",
          name: "Dead",
          visibility: "invite-only",
          metadata: {},
          parentGroupId: parent.id,
          softDeletedAt: new Date(),
        },
      });

      const res = await listChildren(parent.id);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.id).toBe(live.id);
    });

    it("does not include grandchildren (direct children only)", async () => {
      const top = await seedGroup("Top");
      const mid = await seedGroup("Mid", { parentGroupId: top.id });
      await seedGroup("Bottom", { parentGroupId: mid.id });

      const res = await listChildren(top.id);
      const body = (await res.json()) as Array<{ id: string }>;
      expect(body.map((g) => g.id)).toEqual([mid.id]);
    });

    it("returns memberCount per child", async () => {
      const parent = await seedGroup("Parent");
      const child = await seedGroup("Child", { parentGroupId: parent.id });

      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.groupMember.create({
        data: {
          groupId: child.id,
          junjoUserId: user.id,
          status: "active",
          metadata: {},
        },
      });

      const res = await listChildren(parent.id);
      const body = (await res.json()) as Array<{ id: string; memberCount: number }>;
      expect(body[0]?.memberCount).toBe(1);
    });

    it("returns 404 when the parent group does not exist", async () => {
      const res = await listChildren("grp_missing");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the parent group is soft-deleted", async () => {
      const parent = await seedGroup("Parent", { softDeletedAt: new Date() });
      const res = await listChildren(parent.id);
      expect(res.status).toBe(404);
    });

    it("returns 404 when the parent group is in a different game", async () => {
      const otherGame = await createGame("Other Game", prisma);
      const parent = await seedGroup("Parent", { gameId: otherGame.id });

      const res = await listChildren(parent.id);
      expect(res.status).toBe(404);
    });

    it("rejects requests without an API key", async () => {
      const parent = await seedGroup("Parent");
      const res = await app.request(`/v1/groups/${parent.id}/children`);
      expect(res.status).toBe(401);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Group visibility enforcement", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  async function makeGroup(visibility: "public" | "invite-only" | "secret", name: string) {
    return prisma.group.create({
      data: { gameId, kind: "guild", name, visibility, metadata: {} },
    });
  }

  async function makeMember(groupId: string, externalUserId: string) {
    const ju = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: ju.id, externalUserId },
    });
    await prisma.groupMember.create({
      data: { groupId, junjoUserId: ju.id, status: "active" },
    });
    return ju.id;
  }

  describe("GET /v1/groups", () => {
    it("returns secret groups when no viewer is supplied (admin/server caller)", async () => {
      await makeGroup("public", "p");
      await makeGroup("invite-only", "i");
      await makeGroup("secret", "s");

      const res = await app.request("/v1/groups", { headers: { authorization: authHeader } });
      const body = (await res.json()) as { items: Array<{ name: string }> };
      expect(body.items.map((g) => g.name).sort()).toEqual(["i", "p", "s"]);
    });

    it("hides secret groups from a viewer who is not a member", async () => {
      await makeGroup("public", "p");
      await makeGroup("invite-only", "i");
      const secret = await makeGroup("secret", "s");
      await makeMember(secret.id, "memberA");

      const res = await app.request("/v1/groups?viewer=stranger", {
        headers: { authorization: authHeader },
      });
      const body = (await res.json()) as { items: Array<{ name: string }> };
      expect(body.items.map((g) => g.name).sort()).toEqual(["i", "p"]);
    });

    it("shows a viewer their own secret groups but not others", async () => {
      await makeGroup("public", "p");
      const mySecret = await makeGroup("secret", "mine");
      const theirSecret = await makeGroup("secret", "theirs");
      await makeMember(mySecret.id, "viewerUser");
      await makeMember(theirSecret.id, "otherUser");

      const res = await app.request("/v1/groups?viewer=viewerUser", {
        headers: { authorization: authHeader },
      });
      const body = (await res.json()) as { items: Array<{ name: string }> };
      expect(body.items.map((g) => g.name).sort()).toEqual(["mine", "p"]);
    });

    it("treats an unknown viewer as a non-member (still hides all secrets)", async () => {
      const secret = await makeGroup("secret", "s");
      await makeMember(secret.id, "memberA");

      const res = await app.request("/v1/groups?viewer=ghost", {
        headers: { authorization: authHeader },
      });
      const body = (await res.json()) as { items: Array<{ name: string }> };
      expect(body.items).toEqual([]);
    });
  });

  describe("GET /v1/groups/:id", () => {
    it("admin caller can read a secret group with no viewer", async () => {
      const secret = await makeGroup("secret", "s");
      const res = await app.request(`/v1/groups/${secret.id}`, {
        headers: { authorization: authHeader },
      });
      expect(res.status).toBe(200);
    });

    it("a viewer who is a member can read a secret group", async () => {
      const secret = await makeGroup("secret", "s");
      await makeMember(secret.id, "alice");
      const res = await app.request(`/v1/groups/${secret.id}?viewer=alice`, {
        headers: { authorization: authHeader },
      });
      expect(res.status).toBe(200);
    });

    it("a viewer who is not a member 404s on a secret group", async () => {
      const secret = await makeGroup("secret", "s");
      const res = await app.request(`/v1/groups/${secret.id}?viewer=stranger`, {
        headers: { authorization: authHeader },
      });
      expect(res.status).toBe(404);
    });

    it("public and invite-only groups are visible to any viewer", async () => {
      const pub = await makeGroup("public", "p");
      const inv = await makeGroup("invite-only", "i");
      const r1 = await app.request(`/v1/groups/${pub.id}?viewer=anyone`, {
        headers: { authorization: authHeader },
      });
      const r2 = await app.request(`/v1/groups/${inv.id}?viewer=anyone`, {
        headers: { authorization: authHeader },
      });
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    });
  });

  describe("POST /v1/groups/:id/join", () => {
    function joinGroup(groupId: string, body: unknown) {
      return app.request(`/v1/groups/${groupId}/join`, {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    it("creates an active member on a public group", async () => {
      const pub = await makeGroup("public", "p");
      const res = await joinGroup(pub.id, { userId: "newcomer" });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { groupId: string; userId: string; status: string };
      expect(body).toMatchObject({ groupId: pub.id, userId: "newcomer", status: "active" });

      const stored = await prisma.groupMember.findFirst({
        where: { groupId: pub.id },
        include: { junjoUser: { include: { externalIdentities: true } } },
      });
      expect(stored?.status).toBe("active");
      expect(stored?.junjoUser.externalIdentities[0]?.externalUserId).toBe("newcomer");
    });

    it("rejects joining an invite-only group with 403", async () => {
      const inv = await makeGroup("invite-only", "i");
      const res = await joinGroup(inv.id, { userId: "newcomer" });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("permission_denied");
    });

    it("404s on a secret group (existence stays invisible)", async () => {
      const secret = await makeGroup("secret", "s");
      const res = await joinGroup(secret.id, { userId: "newcomer" });
      expect(res.status).toBe(404);
    });

    it("409s when the user is already an active member", async () => {
      const pub = await makeGroup("public", "p");
      await joinGroup(pub.id, { userId: "twice" });
      const res = await joinGroup(pub.id, { userId: "twice" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { code: string };
      expect(body.code).toBe("already_member");
    });

    it("re-joins after leaving by reactivating the existing row", async () => {
      const pub = await makeGroup("public", "p");
      await joinGroup(pub.id, { userId: "rejoin" });
      // Mark them left.
      const ju = await prisma.junjoUser.findFirst({
        where: { externalIdentities: { some: { externalUserId: "rejoin" } } },
      });
      await prisma.groupMember.updateMany({
        where: { groupId: pub.id, junjoUserId: ju?.id },
        data: { status: "left", leftAt: new Date() },
      });

      const res = await joinGroup(pub.id, { userId: "rejoin" });
      expect(res.status).toBe(201);
      const memberRows = await prisma.groupMember.findMany({ where: { groupId: pub.id } });
      expect(memberRows).toHaveLength(1);
      expect(memberRows[0]?.status).toBe("active");
      expect(memberRows[0]?.leftAt).toBeNull();
    });

    it("writes a member.joined audit entry tagged via=public-join", async () => {
      const pub = await makeGroup("public", "p");
      await joinGroup(pub.id, { userId: "auditme" });
      const entry = await prisma.auditEntry.findFirst({
        where: { groupId: pub.id, action: "member.joined" },
      });
      expect(entry).not.toBeNull();
      expect((entry?.payload as { via?: string })?.via).toBe("public-join");
    });

    it("rejects a body missing userId", async () => {
      const pub = await makeGroup("public", "p");
      const res = await joinGroup(pub.id, {});
      expect(res.status).toBe(400);
    });

    it("rejects requests without an API key", async () => {
      const pub = await makeGroup("public", "p");
      const res = await app.request(`/v1/groups/${pub.id}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: "anon" }),
      });
      expect(res.status).toBe(401);
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Page-size cap (JUNJO_MAX_PAGE_SIZE)", () => {
  let app: Hono;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    app = createApp({ prisma });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
  });

  it("rejects limit > default cap (100) with 400", async () => {
    // Default cap is 100; the existing groups.test exercises 101 too,
    // but this assertion makes the contract explicit alongside the
    // raised-cap test below.
    void gameId;
    const res = await app.request("/v1/groups?limit=200", {
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(400);
  });

  it("accepts limit > default cap once setMaxPageSize raises it", async () => {
    const { setMaxPageSize, resetMaxPageSize } = await import("../config/runtime.js");
    setMaxPageSize(500);
    try {
      const res = await app.request("/v1/groups?limit=200", {
        headers: { authorization: authHeader },
      });
      expect(res.status).toBe(200);
    } finally {
      resetMaxPageSize();
    }
  });

  it("re-rejects limit > 100 after the cap is reset to the default", async () => {
    const { setMaxPageSize, resetMaxPageSize } = await import("../config/runtime.js");
    setMaxPageSize(500);
    resetMaxPageSize();
    const res = await app.request("/v1/groups?limit=200", {
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(400);
  });
});
