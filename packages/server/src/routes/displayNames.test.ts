import type { JunjoEvent } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadRenderTable, renderEvent } from "../eventRender";
import { createApiKey, createGame } from "../seed";
import { seedLinkedPerson } from "../testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "UserRelationship", "GroupMember", "EventLog", "GameEventCounter", "IdempotencyRecord", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

const MC = "mc:steve";
const WEB = "web:steve";

describe.skipIf(!TEST_DATABASE_URL)("display names", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let webKey: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    const game = await createGame("Names", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    const preferring = await createApiKey(game.id, prisma);
    await prisma.apiKey.update({
      where: { id: preferring.apiKey.id },
      data: { preferredNamespaces: ["web"] },
    });
    webKey = `Bearer ${preferring.raw.full}`;
    app = createApp({ prisma });
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    auth: string = key,
  ): Promise<Response> {
    return app.request(path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  const setName = (userId: string, displayName: string | null) =>
    call("PUT", `/v1/users/${encodeURIComponent(userId)}/display-name`, { displayName });

  async function json<T>(res: Response | Promise<Response>): Promise<T> {
    return (await (await res).json()) as T;
  }

  async function updatedEvents(): Promise<JunjoEvent[]> {
    const rows = await prisma.eventLog.findMany({
      where: { gameId, type: "identity.updated" },
      orderBy: { seq: "asc" },
    });
    return rows.map((r) => r.payload as unknown as JunjoEvent);
  }

  describe("PUT /v1/users/:userId/display-name", () => {
    it("sets the name of that exact id, creating an unknown person", async () => {
      const res = await setName("newbie", "Newbie");
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({
        userId: "newbie",
        namespace: null,
        displayName: "Newbie",
      });
      const row = await prisma.externalIdentity.findFirstOrThrow({
        where: { externalUserId: "newbie" },
      });
      expect(row.displayName).toBe("Newbie");
      expect(row.displayNameUpdatedAt).not.toBeNull();
    });

    it("does nothing for an unchanged name and emits identity.updated on a change", async () => {
      await setName(MC, "Steve");
      const again = await setName(MC, "Steve");
      expect(again.status).toBe(200);
      expect(await updatedEvents()).toHaveLength(1);
      await setName(MC, null);
      const events = await updatedEvents();
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({
        type: "identity.updated",
        userId: MC,
        changedUserId: MC,
        displayName: "Steve",
        changed: ["displayName"],
      });
      expect(events[1]).toMatchObject({ displayName: null });
      const row = await prisma.externalIdentity.findFirstOrThrow({ where: { externalUserId: MC } });
      expect(row.displayName).toBeNull();
      expect(row.displayNameUpdatedAt).toBeNull();
      // Names change often; no audit entry is written.
      expect(await prisma.auditEntry.count()).toBe(0);
    });

    it("renders userId per subscriber and keeps changedUserId literal", async () => {
      await seedLinkedPerson(prisma, gameId, MC, WEB);
      await setName(MC, "Steve");
      const [event] = await updatedEvents();
      if (!event) throw new Error("no event");
      const table = await loadRenderTable(prisma, gameId, [event]);
      const seenByWeb = renderEvent(event, table, ["web"]) as JunjoEvent & {
        userId: string;
        changedUserId: string;
      };
      expect(seenByWeb.userId).toBe(WEB);
      expect(seenByWeb.changedUserId).toBe(MC);
    });

    it("validates the body", async () => {
      for (const body of [
        { displayName: "" },
        { displayName: "x".repeat(65) },
        {},
        { displayName: 5 },
        { displayName: "ok", extra: 1 },
      ]) {
        const res = await call("PUT", "/v1/users/a/display-name", body);
        expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect((await setName("a", "x".repeat(64))).status).toBe(200);
    });
  });

  describe("person-level display name", () => {
    it("uses the rendered id's name, else the most recently set name", async () => {
      const person = await seedLinkedPerson(prisma, gameId, MC, WEB);
      const group = await prisma.group.create({
        data: { gameId, kind: "guild", name: "g", visibility: "public" },
      });
      const member = await prisma.groupMember.create({
        data: { groupId: group.id, junjoUserId: person, status: "active" },
      });

      const memberRead = async (auth: string) =>
        json<{ userId: string; displayName: string | null }>(
          call("GET", `/v1/groups/${group.id}/members/${encodeURIComponent(WEB)}`, undefined, auth),
        );

      expect((await memberRead(key)).displayName).toBeNull();

      // Only WEB has a name: the default key renders MC and falls back.
      await setName(WEB, "Steve");
      expect(await memberRead(key)).toMatchObject({ userId: MC, displayName: "Steve" });

      // MC gets its own name: each key sees its rendered id's name.
      await setName(MC, "Notch");
      expect(await memberRead(key)).toMatchObject({ userId: MC, displayName: "Notch" });
      expect(await memberRead(webKey)).toMatchObject({ userId: WEB, displayName: "Steve" });

      // Clearing MC's name falls back to the latest remaining one.
      await setName(MC, null);
      expect((await memberRead(key)).displayName).toBe("Steve");

      // Every member surface carries it.
      const list = await json<{ items: { displayName: string | null }[] }>(
        call("GET", `/v1/groups/${group.id}/members`),
      );
      expect(list.items[0]?.displayName).toBe("Steve");
      const byId = await json<{ displayName: string | null }>(
        call("GET", `/v1/members/${member.id}`),
      );
      expect(byId.displayName).toBe("Steve");
      const mine = await json<{ displayName: string | null }[]>(
        call("GET", `/v1/users/${encodeURIComponent(MC)}/members`),
      );
      expect(mine[0]?.displayName).toBe("Steve");
      const access = await json<{ displayName: string | null }>(
        call("GET", `/v1/groups/${group.id}/members/${encodeURIComponent(MC)}/access`),
      );
      expect(access.displayName).toBe("Steve");
      const joined = await json<{ displayName: string | null }>(
        call("POST", `/v1/groups/${group.id}/join`, { userId: "other" }),
      );
      expect(joined.displayName).toBeNull();
    });

    it("picks the most recently set name when the rendered id has none", async () => {
      const person = await seedLinkedPerson(prisma, gameId, MC, WEB);
      const third = "xb:steve";
      await prisma.externalIdentity.create({
        data: {
          gameId,
          junjoUserId: person,
          externalUserId: third,
          linkedAt: new Date("2026-11-01T00:02:00Z"),
        },
      });
      await prisma.externalIdentity.update({
        where: { gameId_externalUserId: { gameId, externalUserId: WEB } },
        data: { displayName: "Older", displayNameUpdatedAt: new Date("2026-01-01T00:00:00Z") },
      });
      await prisma.externalIdentity.update({
        where: { gameId_externalUserId: { gameId, externalUserId: third } },
        data: { displayName: "Newer", displayNameUpdatedAt: new Date("2026-02-01T00:00:00Z") },
      });
      const group = await prisma.group.create({
        data: { gameId, kind: "guild", name: "g", visibility: "public" },
      });
      await prisma.groupMember.create({
        data: { groupId: group.id, junjoUserId: person, status: "active" },
      });
      const read = await json<{ userId: string; displayName: string | null }>(
        call("GET", `/v1/groups/${group.id}/members/${encodeURIComponent(MC)}`),
      );
      expect(read).toMatchObject({ userId: MC, displayName: "Newer" });
    });

    it("lists each identity with its own name", async () => {
      await seedLinkedPerson(prisma, gameId, MC, WEB);
      await setName(WEB, "Steve");
      const { items } = await json<{ items: { userId: string; displayName: string | null }[] }>(
        call("GET", `/v1/users/${encodeURIComponent(MC)}/identities`),
      );
      expect(items.map((i) => [i.userId, i.displayName])).toEqual([
        [MC, null],
        [WEB, "Steve"],
      ]);
    });

    it("adds the friend's name to friends list entries", async () => {
      await prisma.game.update({
        where: { id: gameId },
        data: { config: { friends: { requestsRequired: false } } },
      });
      const sent = await call("POST", "/v1/users/alex/friend-requests", {
        targetJunjoUserId: "sam",
      });
      expect(sent.status).toBe(201);
      await setName("sam", "Sammy");
      const { items } = await json<{
        items: { junjoUserId: string; displayName: string | null }[];
      }>(call("GET", "/v1/users/alex/friends"));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ junjoUserId: "sam", displayName: "Sammy" });
    });
  });

  describe("GET /v1/identities/by-name", () => {
    async function lookup(query: string) {
      return json<{
        items: { userId: string; displayName: string; displayNameUpdatedAt: string }[];
      }>(call("GET", `/v1/identities/by-name?${query}`));
    }

    it("matches ignoring case, newest first, with the matching id literal", async () => {
      await seedLinkedPerson(prisma, gameId, MC, WEB);
      await setName(MC, "Steve");
      await setName("web:other", "STEVE");
      await setName("bob", "Bob");
      const { items } = await lookup("name=steve");
      expect(items.map((i) => [i.userId, i.displayName])).toEqual([
        ["web:other", "STEVE"],
        [MC, "Steve"],
      ]);
      expect(Date.parse(items[0]?.displayNameUpdatedAt ?? "")).not.toBeNaN();
      // The key's namespace preference does not rewrite the matching id.
      const viaWeb = await json<{ items: { userId: string }[] }>(
        call("GET", "/v1/identities/by-name?name=Steve", undefined, webKey),
      );
      expect(viaWeb.items.map((i) => i.userId)).toContain(MC);
    });

    it("filters by namespace", async () => {
      await setName("mc:a", "Steve");
      await setName("web:b", "Steve");
      await setName("steve_no_ns", "Steve");
      expect((await lookup("name=Steve&namespace=mc")).items.map((i) => i.userId)).toEqual([
        "mc:a",
      ]);
      expect((await lookup("name=Steve&namespace=xb")).items).toEqual([]);
    });

    it("returns at most 20 matches", async () => {
      await prisma.junjoUser.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({ id: `p${i}` })),
      });
      await prisma.externalIdentity.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          gameId,
          junjoUserId: `p${i}`,
          externalUserId: `u${i}`,
          displayName: "Same",
          displayNameUpdatedAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
        })),
      });
      const { items } = await lookup("name=same");
      expect(items).toHaveLength(20);
      expect(items[0]?.userId).toBe("u24");
    });

    it("validates the query", async () => {
      expect((await call("GET", "/v1/identities/by-name")).status).toBe(400);
      expect((await call("GET", `/v1/identities/by-name?name=${"x".repeat(65)}`)).status).toBe(400);
      expect((await call("GET", "/v1/identities/by-name?name=a&namespace=BAD!")).status).toBe(400);
    });
  });
});
