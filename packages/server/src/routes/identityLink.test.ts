import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { hashLinkCode, normalizeLinkCode } from "../identityLink";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-link";
const MC = "mc:0f8fad5b-d9cb-469f-a165-70867728950e";
const WEB = "web:site_42";
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

let prisma: PrismaClient;

// biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted field by field
type Body = any;
async function read(res: Response | Promise<Response>): Promise<Body> {
  return (await res).json();
}

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

describe.skipIf(!TEST_DATABASE_URL)("identity linking", () => {
  let app: Hono;
  let gameId: string;
  let serverKey: string;
  let siteKey: string;
  let siteKeyId: string;
  let groupId: string;
  let defaultRoleId: string;
  let rankRoleId: string;

  beforeEach(async () => {
    // A fresh app per test resets the in-process rate limit budgets.
    app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub: new EventHub() } });
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "LinkCode", "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "MemberRole", "GroupMember", "UserRelationship", "GameBan", "BanHistory", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Network", prisma);
    gameId = game.id;
    const server = await createApiKey(gameId, prisma);
    await prisma.apiKey.update({
      where: { id: server.apiKey.id },
      data: { name: "Lobby", preferredNamespaces: ["mc"] },
    });
    serverKey = `Bearer ${server.raw.full}`;
    const site = await createApiKey(gameId, prisma);
    await prisma.apiKey.update({
      where: { id: site.apiKey.id },
      data: { name: "Website", preferredNamespaces: ["web"] },
    });
    siteKey = `Bearer ${site.raw.full}`;
    siteKeyId = site.apiKey.id;

    const group = await prisma.group.create({
      data: { gameId, kind: "network", name: "MV", visibility: "public", metadata: {} },
    });
    groupId = group.id;
    defaultRoleId = (
      await prisma.role.create({ data: { groupId, name: "Guest", priority: 0, isDefault: true } })
    ).id;
    rankRoleId = (await prisma.role.create({ data: { groupId, name: "Admin", priority: 100 } })).id;
    await prisma.group.update({ where: { id: groupId }, data: { defaultRoleId } });
    await prisma.rolePermission.create({ data: { roleId: rankRoleId, permissionKey: "staff" } });
  });

  function api(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
    return app.request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: init.key ?? serverKey,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  function adminGet(path: string) {
    return app.request(path, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  }

  async function person(externalUserId: string, roleIds: string[] = []) {
    const user = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: user.id, externalUserId },
    });
    if (roleIds.length > 0) {
      const member = await prisma.groupMember.create({
        data: { groupId, junjoUserId: user.id, status: "active" },
      });
      await prisma.memberRole.createMany({
        data: roleIds.map((roleId) => ({ groupMemberId: member.id, roleId })),
      });
    }
    return user.id;
  }

  async function issue(userId: string, key = serverKey) {
    return api(`/v1/users/${userId}/link-codes`, { method: "POST", key });
  }

  async function redeem(code: string, userId: string, key = siteKey) {
    return api("/v1/link-codes/redeem", { method: "POST", key, body: { code, userId } });
  }

  async function issueCode(userId: string): Promise<string> {
    const res = await issue(userId);
    expect(res.status).toBe(201);
    return (await read(res)).code;
  }

  describe("link codes", () => {
    it("issues a readable code, stored only as a hash, expiring in five minutes", async () => {
      const before = Date.now();
      const res = await issue(MC);
      expect(res.status).toBe(201);
      const body = await read(res);
      expect(body.code).toMatch(CODE_PATTERN);
      const expiresAt = Date.parse(body.expiresAt);
      expect(expiresAt - before).toBeGreaterThan(4.9 * 60_000);
      expect(expiresAt - before).toBeLessThanOrEqual(5 * 60_000 + 5_000);

      const rows = await prisma.linkCode.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.codeHash).toBe(hashLinkCode(normalizeLinkCode(body.code) as string));
      expect(JSON.stringify(rows)).not.toContain(body.code.replace("-", ""));
    });

    it("cancels an id's earlier code when a new one is issued", async () => {
      const first = await issueCode(MC);
      await issueCode(MC);
      const res = await redeem(first, WEB);
      expect(res.status).toBe(400);
      expect((await read(res)).code).toBe("link_code_invalid");
    });

    it("accepts the code in any case, without the hyphen, and with look-alikes", async () => {
      const code = await issueCode(MC);
      const typed = code.toLowerCase().replace("-", " ").replaceAll("0", "o").replaceAll("1", "l");
      expect((await redeem(typed, WEB)).status).toBe(200);
    });

    it("answers unknown, used and expired codes the same way", async () => {
      expect((await read(redeem("ZZZZ-ZZZZ", WEB))).code).toBe("link_code_invalid");
      expect((await read(redeem("not a code", WEB))).code).toBe("link_code_invalid");

      const used = await issueCode(MC);
      expect((await redeem(used, WEB)).status).toBe(200);
      expect((await read(redeem(used, "web:other"))).code).toBe("link_code_invalid");

      const stale = await issueCode("mc:11111111-2222-4333-8444-555555555555");
      await prisma.linkCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      expect((await read(redeem(stale, "web:third"))).code).toBe("link_code_invalid");
    });

    it("refuses a redeem by the id that requested the code", async () => {
      const code = await issueCode(MC);
      const res = await redeem(code, MC);
      expect(res.status).toBe(400);
    });

    it("rate limits code requests per id", async () => {
      for (let i = 0; i < 5; i++) expect((await issue(MC)).status).toBe(201);
      const res = await issue(MC);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBeTruthy();
      expect((await issue("mc:11111111-2222-4333-8444-555555555555")).status).toBe(201);
    });

    it("rate limits failed redeems per key", async () => {
      // A frozen clock keeps the budget from refilling mid-test.
      const frozen = Date.now();
      app = createApp({
        prisma,
        events: { hub: new EventHub() },
        identityLinks: { now: () => frozen },
      });
      for (let i = 0; i < 60; i++) {
        const res = await redeem("ZZZZ-ZZZZ", `web:guess_${i}`);
        expect(res.status).toBe(400);
      }
      const res = await redeem("ZZZZ-ZZZZ", "web:guess_last");
      expect(res.status).toBe(429);
      const code = await issueCode(MC);
      expect((await redeem(code, WEB, serverKey)).status).toBe(200);
      // Failed guesses created no one.
      expect(await prisma.externalIdentity.count()).toBe(2);
    }, 30_000);

    it("refuses to issue a code for an id banned in any group of the game", async () => {
      const jid = await person(MC);
      await prisma.groupMember.create({ data: { groupId, junjoUserId: jid, status: "banned" } });
      const res = await issue(MC);
      expect(res.status).toBe(403);
      expect((await read(res)).code).toBe("banned");
    });

    it("refuses to issue a code for a banned id", async () => {
      const jid = await person(MC);
      await prisma.gameBan.create({ data: { gameId, junjoUserId: jid } });
      const res = await issue(MC);
      expect(res.status).toBe(403);
      expect((await read(res)).code).toBe("banned");
    });
  });

  describe("linking", () => {
    it("merges a fresh id into the requester's person", async () => {
      const mcPerson = await person(MC, [defaultRoleId]);
      const code = await issueCode(MC);
      const res = await redeem(code, WEB);
      expect(res.status).toBe(200);
      const body = await read(res);
      expect(body.userId).toBe(WEB);
      expect(body.linkedUserId).toBe(WEB);
      expect(body.identities.map((i: { userId: string }) => i.userId)).toEqual([MC, WEB]);

      const web = await prisma.externalIdentity.findFirst({ where: { externalUserId: WEB } });
      expect(web?.junjoUserId).toBe(mcPerson);
      expect(await prisma.junjoUser.count()).toBe(1);

      const members = await read(api(`/v1/users/${WEB}/members`, { key: siteKey }));
      expect(members.map((m: { userId: string }) => m.userId)).toEqual([WEB]);
      const viaServer = await read(api(`/v1/users/${WEB}/members`));
      expect(viaServer.map((m: { userId: string }) => m.userId)).toEqual([MC]);
    });

    it("keeps the person that holds something, whichever side it is", async () => {
      const webPerson = await person(WEB, [rankRoleId]);
      await person(MC, [defaultRoleId]);
      const code = await issueCode(MC);
      const body = await read(redeem(code, WEB));
      expect(body.linkedUserId).toBe(MC);
      const mc = await prisma.externalIdentity.findFirst({ where: { externalUserId: MC } });
      expect(mc?.junjoUserId).toBe(webPerson);
      // The survivor's id stays first; the attached id joins after it.
      expect(body.identities.map((i: { userId: string }) => i.userId)).toEqual([WEB, MC]);
    });

    it("answers a redeem for an id already linked to the same person without changes", async () => {
      await person(MC);
      expect((await redeem(await issueCode(MC), WEB)).status).toBe(200);
      const audits = await prisma.auditEntry.count();
      const res = await redeem(await issueCode(MC), WEB);
      expect(res.status).toBe(200);
      expect(await prisma.auditEntry.count()).toBe(audits);
    });

    it("refuses when both people hold something, and the code stays usable", async () => {
      await person(MC, [rankRoleId]);
      const webPerson = await person(WEB);
      await prisma.friendTag.create({ data: { gameId, junjoUserId: webPerson, name: "pals" } });
      const code = await issueCode(MC);
      const res = await redeem(code, WEB);
      expect(res.status).toBe(409);
      expect((await read(res)).code).toBe("link_refused");

      await prisma.friendTag.deleteMany();
      expect((await redeem(code, WEB)).status).toBe(200);
    });

    it("counts friendships, overrides, metadata and history as holding something", async () => {
      const setups: ((jid: string) => Promise<unknown>)[] = [
        async (jid) => {
          const other = await person("web:friend");
          await prisma.userRelationship.create({
            data: { gameId, actorJunjoUserId: jid, targetJunjoUserId: other, type: "blocked" },
          });
        },
        async (jid) => {
          const m = await prisma.groupMember.create({
            data: { groupId, junjoUserId: jid, status: "active" },
          });
          await prisma.memberPermissionOverride.create({
            data: { groupMemberId: m.id, permissionKey: "x", grant: true },
          });
        },
        (jid) =>
          prisma.groupMember.create({
            data: { groupId, junjoUserId: jid, status: "active", metadata: { coins: 3 } },
          }),
        (jid) =>
          prisma.banHistory.create({
            data: { gameId, junjoUserId: jid, scope: "game", kind: "lifted" },
          }),
      ];
      for (const setup of setups) {
        await prisma.$executeRawUnsafe(
          'TRUNCATE TABLE "LinkCode", "UserRelationship", "BanHistory", "MemberPermissionOverride", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser" CASCADE',
        );
        await person(MC, [rankRoleId]);
        await setup(await person(WEB));
        const res = await redeem(await issueCode(MC), WEB);
        expect(res.status).toBe(409);
      }
    });

    it("does not count left rows or default-only memberships", async () => {
      await person(MC, [rankRoleId]);
      const webPerson = await person(WEB);
      const other = await prisma.group.create({
        data: { gameId, kind: "party", name: "P", visibility: "public", metadata: {} },
      });
      await prisma.groupMember.create({
        data: { groupId: other.id, junjoUserId: webPerson, status: "left" },
      });
      const m = await prisma.groupMember.create({
        data: { groupId, junjoUserId: webPerson, status: "active" },
      });
      await prisma.memberRole.create({ data: { groupMemberId: m.id, roleId: defaultRoleId } });

      expect((await redeem(await issueCode(MC), WEB)).status).toBe(200);
      const survivor = await prisma.externalIdentity.findFirst({ where: { externalUserId: MC } });
      const rows = await prisma.groupMember.findMany({
        where: { junjoUserId: survivor?.junjoUserId },
      });
      // The colliding default row is dropped; the left row moves over.
      expect(rows.map((r) => [r.groupId, r.status]).sort()).toEqual(
        [
          [groupId, "active"],
          [other.id, "left"],
        ].sort(),
      );
    });

    it("refuses while either person is banned", async () => {
      await person(MC);
      const webPerson = await person(WEB);
      await prisma.groupMember.create({
        data: { groupId, junjoUserId: webPerson, status: "banned" },
      });
      const res = await redeem(await issueCode(MC), WEB);
      expect(res.status).toBe(403);
      expect((await read(res)).code).toBe("banned");
    });

    it("refuses two different ids of one person as friends or blocks", async () => {
      await person(MC);
      await redeem(await issueCode(MC), WEB);
      const fr = await api(`/v1/users/${MC}/friend-requests`, {
        method: "POST",
        body: { targetJunjoUserId: WEB },
      });
      expect(fr.status).toBe(400);
      const block = await api(`/v1/users/${MC}/blocks`, {
        method: "POST",
        body: { targetJunjoUserId: WEB },
      });
      expect(block.status).toBe(400);
    });

    it("drops cached permission answers for the moved id", async () => {
      await person(MC, [rankRoleId]);
      const check = () =>
        read(api(`/v1/permissions/check?userId=${WEB}&groupId=${groupId}&permission=staff`));
      expect((await check()).allowed).toBe(false);
      await redeem(await issueCode(MC), WEB);
      expect((await check()).allowed).toBe(true);
    });

    it("audits the link with the acting key and stages a rendered event", async () => {
      await person(MC);
      await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://example.com/hook",
          secret: "s".repeat(32),
          events: ["identity.linked"],
          preferredNamespaces: ["mc"],
        },
      });
      await redeem(await issueCode(MC), WEB);

      const audit = await read(adminGet(`/v1/admin/games/${gameId}/audit?actions=identity.linked`));
      expect(audit.items).toHaveLength(1);
      expect(audit.items[0]).toMatchObject({
        action: "identity.linked",
        groupId: null,
        targetId: WEB,
        apiKey: { id: siteKeyId, name: "Website" },
      });
      expect(audit.items[0].payload).toMatchObject({ survivor: "issuer", identities: [MC, WEB] });

      const delivery = await prisma.webhookDelivery.findFirstOrThrow();
      expect(delivery.payload).toMatchObject({
        type: "identity.linked",
        userId: MC,
        linkedUserId: WEB,
        identities: [MC, WEB],
      });
    });
  });

  describe("unlinking", () => {
    beforeEach(async () => {
      await person(MC, [rankRoleId]);
      expect((await redeem(await issueCode(MC), WEB)).status).toBe(200);
    });

    it("moves the id to a fresh, empty person; roles stay behind", async () => {
      const res = await api(`/v1/users/${WEB}/unlink`, { method: "POST", key: siteKey });
      expect(res.status).toBe(200);
      const body = await read(res);
      expect(body).toMatchObject({ userId: MC, unlinkedUserId: WEB });
      expect(body.identities.map((i: { userId: string }) => i.userId)).toEqual([MC]);

      expect(await read(api(`/v1/users/${WEB}/members`))).toEqual([]);
      const mc = await read(api(`/v1/users/${MC}/members`));
      expect(mc[0].roles).toEqual([rankRoleId]);
      expect(await prisma.junjoUser.count()).toBe(2);

      const audit = await read(
        adminGet(`/v1/admin/games/${gameId}/audit?actions=identity.unlinked`),
      );
      expect(audit.items[0]).toMatchObject({ targetId: WEB, apiKey: { id: siteKeyId } });
    });

    it("refuses to unlink a person's only id", async () => {
      await api(`/v1/users/${WEB}/unlink`, { method: "POST" });
      const res = await api(`/v1/users/${MC}/unlink`, { method: "POST" });
      expect(res.status).toBe(400);
    });

    it("refuses while the person is banned", async () => {
      const mc = await prisma.externalIdentity.findFirstOrThrow({ where: { externalUserId: MC } });
      await prisma.gameBan.create({ data: { gameId, junjoUserId: mc.junjoUserId } });
      const res = await api(`/v1/users/${WEB}/unlink`, { method: "POST" });
      expect(res.status).toBe(403);
      expect((await read(res)).code).toBe("banned");
    });

    it("404s for a never-seen id", async () => {
      expect((await api("/v1/users/nobody/unlink", { method: "POST" })).status).toBe(404);
    });
  });

  describe("acting-key attribution", () => {
    it("stamps the key on audit entries from any route and leaves dashboard writes null", async () => {
      const res = await api("/v1/groups", {
        method: "POST",
        body: { kind: "guild", name: "Wolves", visibility: "public" },
      });
      expect(res.status).toBe(201);
      const created = await prisma.auditEntry.findFirstOrThrow({
        where: { action: "group.created" },
      });
      expect(created.apiKeyId).not.toBeNull();

      const adminRes = await app.request(`/v1/admin/games/${gameId}/config`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ config: { permissions: { mode: "nodes" } } }),
      });
      expect(adminRes.status).toBe(200);
      const modeSet = await prisma.auditEntry.findFirstOrThrow({
        where: { action: "game.permissions.mode.set" },
      });
      expect(modeSet.apiKeyId).toBeNull();
    });
  });
});
