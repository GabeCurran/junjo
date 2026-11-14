import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { loggedEvents } from "../testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-write-origin";
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "MemberPermissionOverride", "MemberRole", "RoleParent", "RolePermission", "PermissionDef", "GroupMember", "GameBan", "BanHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "GroupVersion", "GroupRelationship", "Invitation", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface Envelope {
  code: string;
  details?: Record<string, unknown>;
}

describe.skipIf(!TEST_DATABASE_URL)("event origin, group versions, actors", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let keyId: string;
  let gameId: string;
  let groupId: string;
  let otherGroupId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Origin", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    key = `Bearer ${seeded.raw.full}`;
    keyId = seeded.apiKey.id;
    await prisma.apiKey.update({ where: { id: keyId }, data: { canExport: true } });
    app = createApp({ prisma, adminToken: ADMIN_TOKEN });
    groupId = await createGroup("faction:a", "Red");
    otherGroupId = await createGroup("faction:a", "Blue");
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string> } = {},
  ) {
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

  async function createGroup(kind: string, name: string): Promise<string> {
    const res = await call("POST", "/v1/groups", { body: { kind, name, visibility: "public" } });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function etag(id: string): Promise<string> {
    const res = await call("GET", `/v1/groups/${id}`);
    expect(res.status).toBe(200);
    return res.headers.get("etag") as string;
  }

  describe("origin", () => {
    it("stamps the key and the write tag on every event the write causes", async () => {
      const res = await call("POST", `/v1/groups/${groupId}/members`, {
        body: { userId: "alice" },
        headers: { "junjo-write-tag": "server-1" },
      });
      expect(res.status).toBe(201);
      const [joined] = await loggedEvents(prisma, gameId, "member.joined");
      expect(joined?.origin).toEqual({ apiKeyId: keyId, tag: "server-1" });
    });

    it("leaves the tag null without the header", async () => {
      await call("PATCH", `/v1/groups/${groupId}`, { body: { name: "Crimson" } });
      const [updated] = await loggedEvents(prisma, gameId, "group.updated");
      expect(updated?.origin).toEqual({ apiKeyId: keyId, tag: null });
    });

    it("leaves the key null for admin writes", async () => {
      const res = await app.request(`/v1/admin/games/${gameId}/groups/${groupId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "From the dashboard" }),
      });
      expect(res.status).toBe(200);
      const [updated] = await loggedEvents(prisma, gameId, "group.updated");
      expect(updated?.origin).toEqual({ apiKeyId: null, tag: null });
    });

    it("refuses a malformed tag before writing", async () => {
      for (const tag of ["has space", "x".repeat(129), "café"]) {
        const res = await call("PATCH", `/v1/groups/${groupId}`, {
          body: { name: "Nope" },
          headers: { "junjo-write-tag": tag },
        });
        expect(res.status).toBe(400);
      }
      expect(await loggedEvents(prisma, gameId, "group.updated")).toHaveLength(0);
    });
  });

  describe("group version", () => {
    it("starts at 0 and moves to the position of the group's latest event", async () => {
      expect(await etag(groupId)).toBe('"0"');
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "alice" } });
      const after = await etag(groupId);
      const rows = await prisma.eventLog.findMany({ where: { gameId }, orderBy: { seq: "asc" } });
      const last = rows
        .filter((r) => (r.payload as { groupId?: string }).groupId === groupId)
        .pop();
      expect(after).toBe(`"${last?.seq}"`);
      // Another group's write leaves this one alone.
      await call("POST", `/v1/groups/${otherGroupId}/members`, { body: { userId: "bob" } });
      expect(await etag(groupId)).toBe(after);
    });

    it("moves on member, role and relationship changes inside the group", async () => {
      const v0 = await etag(groupId);
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "alice" } });
      const v1 = await etag(groupId);
      const role = await call("POST", `/v1/groups/${groupId}/roles`, {
        body: { name: "officer", priority: 3 },
      });
      expect(role.status).toBe(201);
      const v2 = await etag(groupId);
      await call("PUT", `/v1/groups/${groupId}/relationships/${otherGroupId}`, {
        body: { type: "enemy" },
      });
      const v3 = await etag(groupId);
      expect(new Set([v0, v1, v2, v3]).size).toBe(4);
      // The B side's version is not moved by A's stance.
      expect(await etag(otherGroupId)).toBe('"0"');
    });

    it("answers the new version on PATCH and refuses a stale If-Match with the current one", async () => {
      const v0 = await etag(groupId);
      const first = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { metadata: { motd: "one" } },
        headers: { "if-match": v0 },
      });
      expect(first.status).toBe(200);
      const v1 = first.headers.get("etag");
      expect(v1).not.toBe(v0);
      expect(v1).toBe(await etag(groupId));

      const stale = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { metadata: { motd: "two" } },
        headers: { "if-match": v0 },
      });
      expect(stale.status).toBe(412);
      const body = (await stale.json()) as Envelope;
      expect(body.code).toBe("precondition_failed");
      expect(`"${body.details?.version}"`).toBe(v1);
      const group = (await (await call("GET", `/v1/groups/${groupId}`)).json()) as {
        metadata: Record<string, unknown>;
      };
      expect(group.metadata).toEqual({ motd: "one" });
    });

    it("checks If-Match on a PATCH that changes nothing", async () => {
      const res = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { name: "Red" },
        headers: { "if-match": '"999"' },
      });
      expect(res.status).toBe(412);
      const ok = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { name: "Red" },
        headers: { "if-match": await etag(groupId) },
      });
      expect(ok.status).toBe(200);
    });

    it("lets exactly one of two writers with the same If-Match win", async () => {
      const v0 = await etag(groupId);
      const results = await Promise.all(
        ["one", "two", "three"].map((motd) =>
          call("PATCH", `/v1/groups/${groupId}`, {
            body: { metadata: { motd } },
            headers: { "if-match": v0 },
          }),
        ),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 412, 412]);
    });

    it("refuses a malformed If-Match", async () => {
      const res = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { name: "x" },
        headers: { "if-match": 'W/"1"' },
      });
      expect(res.status).toBe(400);
    });

    it("guards soft and hard deletes, and drops the version row on a hard delete", async () => {
      const soft = await call("DELETE", `/v1/groups/${groupId}`, {
        headers: { "if-match": '"12345"' },
      });
      expect(soft.status).toBe(412);
      const ok = await call("DELETE", `/v1/groups/${groupId}`, {
        headers: { "if-match": await etag(otherGroupId) },
      });
      // groupId is still at 0 too, so the other group's 0 matches.
      expect(ok.status).toBe(200);

      const hardStale = await call("DELETE", `/v1/groups/${otherGroupId}?hard=true`, {
        headers: { "if-match": '"777"' },
      });
      expect(hardStale.status).toBe(412);
      await call("POST", `/v1/groups/${otherGroupId}/members`, { body: { userId: "carol" } });
      expect(await prisma.groupVersion.count({ where: { groupId: otherGroupId } })).toBe(1);
      const hard = await call("DELETE", `/v1/groups/${otherGroupId}?hard=true`, {
        headers: { "if-match": await etag(otherGroupId) },
      });
      expect(hard.status).toBe(204);
      expect(await prisma.groupVersion.count({ where: { groupId: otherGroupId } })).toBe(0);
    });

    it("sends the version on create", async () => {
      const res = await call("POST", "/v1/groups", {
        body: { kind: "faction:a", name: "Green", creatorUserId: "dave" },
      });
      expect(res.status).toBe(201);
      const id = ((await res.json()) as { id: string }).id;
      expect(res.headers.get("etag")).toBe(await etag(id));
      expect(res.headers.get("etag")).not.toBe('"0"');
    });
  });

  describe("actors", () => {
    it("records the kicker in audit and on member.left", async () => {
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "alice" } });
      const res = await call("POST", `/v1/groups/${groupId}/members/alice/kick`, {
        body: { reason: "griefing", actorUserId: "mod" },
      });
      expect(res.status).toBe(200);
      const [left] = await loggedEvents(prisma, gameId, "member.left");
      expect(left?.kickedBy).toBe("mod");
      const audit = await prisma.auditEntry.findFirst({ where: { action: "member.kicked" } });
      const mod = await prisma.externalIdentity.findFirst({ where: { externalUserId: "mod" } });
      expect(audit?.actorUserId).toBe(mod?.junjoUserId);
    });

    it("leaves kickedBy off without an actor", async () => {
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "alice" } });
      await call("POST", `/v1/groups/${groupId}/members/alice/kick`);
      const [left] = await loggedEvents(prisma, gameId, "member.left");
      expect(left).not.toHaveProperty("kickedBy");
    });

    it("records the actor of a group update and delete", async () => {
      const patched = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { name: "Crimson", actorUserId: "leader" },
      });
      expect(patched.status).toBe(200);
      const [updated] = await loggedEvents(prisma, gameId, "group.updated");
      expect(updated?.actorUserId).toBe("leader");

      const deleted = await call("DELETE", `/v1/groups/${groupId}?actorUserId=leader`);
      expect(deleted.status).toBe(200);
      const [gone] = await loggedEvents(prisma, gameId, "group.deleted");
      expect(gone?.actorUserId).toBe("leader");
      const leader = await prisma.externalIdentity.findFirst({
        where: { externalUserId: "leader" },
      });
      const rows = await prisma.auditEntry.findMany({
        where: { action: { in: ["group.updated", "group.deleted"] } },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.actorUserId).toBe(leader?.junjoUserId);
    });

    it("refuses a PATCH that names only an actor", async () => {
      const res = await call("PATCH", `/v1/groups/${groupId}`, {
        body: { actorUserId: "leader" },
      });
      expect(res.status).toBe(400);
    });

    it("records who set and cleared a relationship", async () => {
      const set = await call("PUT", `/v1/groups/${groupId}/relationships/${otherGroupId}`, {
        body: { type: "ally", mutual: true, actorUserId: "leader" },
      });
      expect(set.status).toBe(200);
      expect(((await set.json()) as { setBy: string }).setBy).toBe("leader");
      const list = (await (
        await call("GET", `/v1/groups/${otherGroupId}/relationships`)
      ).json()) as {
        setBy: string | null;
      }[];
      expect(list[0]?.setBy).toBe("leader");
      const changed = await loggedEvents(prisma, gameId, "group.relationship.changed");
      expect(changed).toHaveLength(2);
      for (const e of changed) {
        expect(e.actorUserId).toBe("leader");
        expect((e.relationship as { setBy: string }).setBy).toBe("leader");
      }

      const cleared = await call(
        "DELETE",
        `/v1/groups/${groupId}/relationships/${otherGroupId}?actorUserId=rival`,
      );
      expect(cleared.status).toBe(204);
      const all = await loggedEvents(prisma, gameId, "group.relationship.changed");
      expect(all[2]?.relationship).toBeNull();
      expect(all[2]?.actorUserId).toBe("rival");
      const audit = await prisma.auditEntry.findFirst({
        where: { action: "group.relationship.cleared" },
      });
      expect(audit?.actorUserId).not.toBeNull();
    });
  });

  describe("export filters", () => {
    async function exportLines(query: string): Promise<Record<string, unknown>[]> {
      const res = await call("GET", `/v1/export${query}`);
      expect(res.status).toBe(200);
      return (await res.text())
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }

    it("keeps only the asked record kinds and group kinds, with group versions", async () => {
      const ranks = await createGroup("ranks", "Server ranks");
      await call("POST", `/v1/groups/${ranks}/members`, { body: { userId: "alice" } });
      await call("POST", `/v1/groups/${groupId}/members`, { body: { userId: "bob" } });

      const lines = await exportLines("?records=group,member&groupKinds=faction:a");
      const header = lines[0] as { records: string[]; groupKinds: string[] };
      expect(header.records).toEqual(["group", "member"]);
      expect(header.groupKinds).toEqual(["faction:a"]);
      const kinds = new Set(lines.map((l) => l.kind));
      expect(kinds).toEqual(new Set(["header", "game", "group", "member", "end"]));
      const groups = lines.filter((l) => l.kind === "group");
      expect(groups.map((g) => g.id).sort()).toEqual([groupId, otherGroupId].sort());
      const red = groups.find((g) => g.id === groupId);
      expect(`"${red?.version}"`).toBe(await etag(groupId));
      const members = lines.filter((l) => l.kind === "member");
      expect(members).toHaveLength(1);
      expect(members[0]?.groupId).toBe(groupId);
    });

    it("exports everything without filters", async () => {
      const lines = await exportLines("");
      const header = lines[0] as { records: string[]; groupKinds: unknown };
      expect(header.groupKinds).toBeNull();
      expect(header.records).toContain("person");
      expect(header.records).toContain("audit");
    });

    it("refuses unknown or empty filters", async () => {
      for (const q of ["?records=group,nope", "?records=", "?groupKinds=", "?records=game"]) {
        const res = await call("GET", `/v1/export${q}`);
        expect(res.status).toBe(400);
      }
    });
  });
});
