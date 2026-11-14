import type { GameId, GroupId, MemberLeftEvent, UserId } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";
import { seedLinkedPerson, waitFor } from "../testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-identity";
const MC = "mc:0f8fad5b-d9cb-469f-a165-70867728950e";
const MC_UPPER = "mc:0F8FAD5B-D9CB-469F-A165-70867728950E";
const WEB = "web:site_42";

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

describe.skipIf(!TEST_DATABASE_URL)("identity formats and rendering", () => {
  let app: Hono;
  let hub: EventHub;
  let gameId: string;
  let plainKey: string;
  let webKey: string;

  beforeAll(() => {
    hub = new EventHub();
    app = createApp({ prisma, adminToken: ADMIN_TOKEN, events: { hub } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Identity Game", prisma);
    gameId = game.id;
    plainKey = `Bearer ${(await createApiKey(gameId, prisma)).raw.full}`;
    const web = await createApiKey(gameId, prisma);
    await prisma.apiKey.update({
      where: { id: web.apiKey.id },
      data: { preferredNamespaces: ["web", "mc"] },
    });
    webKey = `Bearer ${web.raw.full}`;
  });

  function api(path: string, init: { method?: string; body?: unknown; key?: string } = {}) {
    return app.request(path, {
      method: init.method ?? "GET",
      headers: {
        authorization: init.key ?? plainKey,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  }

  function admin(path: string, method: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${ADMIN_TOKEN}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  function declareFormats(formats: Record<string, string>) {
    return admin(`/v1/admin/games/${gameId}/config`, "PATCH", {
      config: { identity: { formats } },
    });
  }

  async function seedGroup() {
    return prisma.group.create({
      data: { gameId, kind: "guild", name: "Wolves", visibility: "public", metadata: {} },
    });
  }

  describe("declared formats", () => {
    it("stores and returns identity.formats; an empty map undeclares", async () => {
      let res = await declareFormats({ mc: "uuid" });
      expect(res.status).toBe(200);
      expect((await read(res)).config.identity).toEqual({ formats: { mc: "uuid" } });

      res = await declareFormats({});
      expect((await read(res)).config.identity).toEqual({ formats: {} });
    });

    it("defaults to no formats", async () => {
      const res = await admin(`/v1/admin/games/${gameId}/config`, "GET");
      expect((await read(res)).config.identity).toEqual({ formats: {} });
    });

    it("rejects bad namespaces, unknown formats and too many entries", async () => {
      expect((await declareFormats({ MC: "uuid" })).status).toBe(400);
      expect((await declareFormats({ mc: "ulid" })).status).toBe(400);
      const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`n${i}`, "uuid"]));
      expect((await declareFormats(many)).status).toBe(400);
    });

    it("refuses to declare a format stored ids would break", async () => {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId: MC_UPPER },
      });
      const res = await declareFormats({ mc: "uuid" });
      expect(res.status).toBe(409);
      const body = await read(res);
      expect(body.code).toBe("identity_format_conflict");
      expect(body.message).toContain(MC_UPPER);
    });

    it("treats namespace prefixes literally, not as LIKE patterns", async () => {
      const user = await prisma.junjoUser.create({ data: {} });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId: "mcx:whatever" },
      });
      expect((await declareFormats({ m_: "uuid" })).status).toBe(200);
    });

    describe("with mc declared as uuid", () => {
      let groupId: string;

      beforeEach(async () => {
        expect((await declareFormats({ mc: "uuid" })).status).toBe(200);
        groupId = (await seedGroup()).id;
      });

      const cases: [string, () => Response | Promise<Response>][] = [
        ["members for user (read)", () => api(`/v1/users/${MC_UPPER}/members`)],
        ["identities (read)", () => api(`/v1/users/${MC_UPPER}/identities`)],
        [
          "join (write)",
          () => api(`/v1/groups/${groupId}/join`, { method: "POST", body: { userId: MC_UPPER } }),
        ],
        [
          "permission check (read)",
          () => api(`/v1/permissions/check?userId=${MC_UPPER}&groupId=${groupId}&permission=x`),
        ],
        [
          "friend request target",
          () =>
            api(`/v1/users/${WEB}/friend-requests`, {
              method: "POST",
              body: { targetJunjoUserId: MC_UPPER },
            }),
        ],
        ["game ban (read)", () => api(`/v1/bans/${MC_UPPER}`)],
        [
          "invitation target",
          () =>
            api(`/v1/groups/${groupId}/invitations`, {
              method: "POST",
              body: { targetUserId: MC_UPPER },
            }),
        ],
      ];

      for (const [name, call] of cases) {
        it(`rejects a malformed id: ${name}`, async () => {
          const res = await call();
          expect(res.status).toBe(400);
          expect((await read(res)).code).toBe("invalid_user_id");
        });
      }

      it("accepts canonical ids and ids in other namespaces", async () => {
        let res = await api(`/v1/groups/${groupId}/join`, { method: "POST", body: { userId: MC } });
        expect(res.status).toBe(201);
        res = await api(`/v1/groups/${groupId}/join`, {
          method: "POST",
          body: { userId: "WEB:Anything" },
        });
        expect(res.status).toBe(201);
      });

      it("rejects even when an answer for that spelling is cached", async () => {
        await declareFormats({});
        const url = `/v1/permissions/check?userId=${MC_UPPER}&groupId=${groupId}&permission=x`;
        expect((await api(url)).status).toBe(200);
        await declareFormats({ mc: "uuid" });
        expect((await api(url)).status).toBe(400);
      });

      it("reports malformed bulk-invite rows without failing the batch", async () => {
        const res = await app.request(`/v1/groups/${groupId}/bulk-invite`, {
          method: "POST",
          headers: { authorization: plainKey, "content-type": "text/plain" },
          body: `${MC}\n${MC_UPPER}\n`,
        });
        expect(res.status).toBe(200);
        const body = await read(res);
        expect(body.invited).toBe(1);
        expect(body.errors).toEqual([{ row: 2, reason: expect.stringContaining("format") }]);
      });

      it("rejects through the admin surface too", async () => {
        const res = await admin(
          `/v1/admin/games/${gameId}/permissions/check?userId=${MC_UPPER}&groupId=${groupId}&permission=x`,
          "GET",
        );
        expect(res.status).toBe(400);
        expect((await read(res)).code).toBe("invalid_user_id");
      });
    });
  });

  describe("rendering a person with several ids", () => {
    it("names them by the earliest-linked id without a preference", async () => {
      const group = await seedGroup();
      await seedLinkedPerson(prisma, gameId, MC, WEB, group.id);

      for (const asked of [MC, WEB]) {
        const res = await api(`/v1/users/${asked}/members`);
        const items = await read(res);
        expect(items.map((m: { userId: string }) => m.userId)).toEqual([MC]);
      }
      const list = await read(api(`/v1/groups/${group.id}/members`));
      expect(list.items.map((m: { userId: string }) => m.userId)).toEqual([MC]);
    });

    it("names them in the key's preferred namespace", async () => {
      const group = await seedGroup();
      await seedLinkedPerson(prisma, gameId, MC, WEB, group.id);

      for (const asked of [MC, WEB]) {
        const items = await read(api(`/v1/users/${asked}/members`, { key: webKey }));
        expect(items.map((m: { userId: string }) => m.userId)).toEqual([WEB]);
      }
      const one = await read(api(`/v1/groups/${group.id}/members/${MC}`, { key: webKey }));
      expect(one.userId).toBe(WEB);
      const access = await read(
        api(`/v1/groups/${group.id}/members/${MC}/access`, { key: webKey }),
      );
      expect(access.userId).toBe(WEB);
    });

    it("falls back to the earliest id when no preferred namespace matches", async () => {
      const group = await seedGroup();
      await seedLinkedPerson(prisma, gameId, MC, WEB, group.id);
      const steam = await createApiKey(gameId, prisma);
      await prisma.apiKey.update({
        where: { id: steam.apiKey.id },
        data: { preferredNamespaces: ["steam"] },
      });
      const items = await read(
        api(`/v1/users/${WEB}/members`, { key: `Bearer ${steam.raw.full}` }),
      );
      expect(items[0].userId).toBe(MC);
    });

    it("lists a person's ids earliest-linked first", async () => {
      await seedLinkedPerson(prisma, gameId, MC, WEB);
      const res = await api(`/v1/users/${WEB}/identities`);
      expect(res.status).toBe(200);
      const body = await read(res);
      expect(body.items).toEqual([
        { userId: MC, namespace: "mc", linkedAt: "2026-11-01T00:00:00.000Z", displayName: null },
        {
          userId: WEB,
          namespace: "web",
          linkedAt: "2026-11-01T00:01:00.000Z",
          displayName: null,
        },
      ]);
    });

    it("answers an empty list for a never-seen id", async () => {
      const body = await read(api("/v1/users/nobody/identities"));
      expect(body).toEqual({ items: [] });
    });

    it("renders one row per game on the admin user view", async () => {
      const person = await seedLinkedPerson(prisma, gameId, MC, WEB);
      const body = await read(admin(`/v1/users/${person}/games`, "GET"));
      expect(body.games).toEqual([{ gameId, externalUserId: MC, joinedGroupCount: 0 }]);
    });

    it("renders webhook payloads per endpoint preference", async () => {
      const group = await seedGroup();
      await seedLinkedPerson(prisma, gameId, MC, WEB, group.id);
      const plain = await prisma.webhookEndpoint.create({
        data: { gameId, url: "https://example.com/a", secret: "s".repeat(32), events: [] },
      });
      const web = await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://example.com/b",
          secret: "s".repeat(32),
          events: [],
          preferredNamespaces: ["web"],
        },
      });

      const res = await api(`/v1/groups/${group.id}/leave`, {
        method: "POST",
        body: { userId: WEB },
      });
      expect(res.status).toBe(200);

      const deliveries = await prisma.webhookDelivery.findMany();
      const byEndpoint = new Map(
        deliveries.map((d) => [d.webhookEndpointId, d.payload as unknown as MemberLeftEvent]),
      );
      expect(byEndpoint.get(plain.id)?.userId).toBe(MC);
      expect(byEndpoint.get(web.id)?.userId).toBe(WEB);
      expect(byEndpoint.get(plain.id)?.id).toBe(byEndpoint.get(web.id)?.id);
    });

    it("renders SSE events per stream preference", async () => {
      const group = await seedGroup();
      await seedLinkedPerson(prisma, gameId, MC, WEB, group.id);
      const res = await api(`/v1/events/${group.id}`, { key: webKey });
      expect(res.status).toBe(200);
      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      await waitFor(() => hub.subscriberCount(group.id as GroupId) > 0);
      const event: MemberLeftEvent = {
        id: "evt_render_1",
        type: "member.left",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        occurredAt: new Date(),
        origin: { apiKeyId: null, tag: null },
        userId: MC as UserId,
        reason: "left",
        memberVersion: 1,
      };
      hub.publish(event);
      let text = "";
      const decoder = new TextDecoder();
      const deadline = Date.now() + 2000;
      while (!text.includes("\n\n") && Date.now() < deadline) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      await reader.cancel();
      const data = text
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      expect(JSON.parse(data ?? "{}").userId).toBe(WEB);
    });
  });

  describe("namespace preferences", () => {
    it("mints a key with a name and preference, and patches both", async () => {
      let res = await admin(`/v1/admin/games/${gameId}/api-keys`, "POST", {
        name: "Lobby server",
        preferredNamespaces: ["mc"],
      });
      expect(res.status).toBe(201);
      const created = await read(res);
      expect(created).toMatchObject({ name: "Lobby server", preferredNamespaces: ["mc"] });

      res = await admin(`/v1/admin/games/${gameId}/api-keys/${created.id}`, "PATCH", {
        name: null,
        preferredNamespaces: ["discord", "mc"],
      });
      expect(res.status).toBe(200);
      expect(await read(res)).toMatchObject({
        name: null,
        preferredNamespaces: ["discord", "mc"],
      });
    });

    it("still mints without a body", async () => {
      const res = await admin(`/v1/admin/games/${gameId}/api-keys`, "POST");
      expect(res.status).toBe(201);
      expect(await read(res)).toMatchObject({ name: null, preferredNamespaces: [] });
    });

    it("rejects repeated, malformed and oversized preference lists", async () => {
      for (const preferredNamespaces of [
        ["mc", "mc"],
        ["Mc"],
        Array.from({ length: 9 }, (_, i) => `n${i}`),
      ]) {
        const res = await admin(`/v1/admin/games/${gameId}/api-keys`, "POST", {
          preferredNamespaces,
        });
        expect(res.status).toBe(400);
      }
    });

    it("sets a webhook endpoint's preference on create and update", async () => {
      let res = await api("/v1/webhooks", {
        method: "POST",
        body: { url: "https://example.com/hook", preferredNamespaces: ["web"] },
      });
      expect(res.status).toBe(201);
      const created = await read(res);
      expect(created.preferredNamespaces).toEqual(["web"]);

      res = await api(`/v1/webhooks/${created.id}`, {
        method: "PATCH",
        body: { preferredNamespaces: ["mc", "web"] },
      });
      expect((await read(res)).preferredNamespaces).toEqual(["mc", "web"]);
    });
  });
});
