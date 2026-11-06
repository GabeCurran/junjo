import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createApiKey, createGame } from "../seed";
import { loggedEvents } from "../testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const TRUNCATE = `TRUNCATE TABLE "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "Sanction", "SanctionHistory", "GameBan", "BanHistory", "ModerationState", "IdempotencyRecord", "EventLog", "GameEventCounter", "ExternalIdentity", "JunjoUser", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

interface WireSanction {
  id: string;
  userId: string;
  type: string;
  reason: string | null;
  issuer: string | null;
  issuedBy: string | null;
  startedAt: string;
  expiresAt: string | null;
  version: number;
}

interface Envelope {
  code: string;
  status: number;
  message: string;
  details?: Record<string, unknown>;
}

describe.skipIf(!TEST_DATABASE_URL)("sanctions", () => {
  let prisma: PrismaClient;
  let app: Hono;
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
    const game = await createGame("Sanctions", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma });
  });

  async function call(
    method: string,
    path: string,
    opts: { body?: unknown; ifMatch?: string } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: key,
      "content-type": "application/json",
    };
    if (opts.ifMatch !== undefined) headers["if-match"] = opts.ifMatch;
    return app.request(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  const sanction = (body: Record<string, unknown>, ifMatch?: string) =>
    call("POST", "/v1/sanctions", { body, ifMatch });
  const lift = (userId: string, type: string, body?: unknown, ifMatch?: string) =>
    call("DELETE", `/v1/sanctions/${encodeURIComponent(userId)}/${type}`, { body, ifMatch });
  const json = async <T>(res: Response) => (await res.json()) as T;

  async function moderation(userId: string) {
    const res = await call("GET", `/v1/users/${encodeURIComponent(userId)}/moderation`);
    expect(res.status).toBe(200);
    return { etag: res.headers.get("etag"), body: await json<Record<string, unknown>>(res) };
  }

  describe("POST /v1/sanctions", () => {
    it("creates a sanction with 201 and returns every field", async () => {
      const res = await sanction({
        userId: "alice",
        type: "mute",
        reason: "spam",
        issuer: "Console",
        actorUserId: "mod",
      });
      expect(res.status).toBe(201);
      expect(res.headers.get("etag")).toBe('"1"');
      const body = await json<WireSanction>(res);
      expect(body).toMatchObject({
        userId: "alice",
        type: "mute",
        reason: "spam",
        issuer: "Console",
        issuedBy: "mod",
        expiresAt: null,
        version: 1,
      });
      expect(typeof body.id).toBe("string");
      expect(Date.parse(body.startedAt)).not.toBeNaN();
    });

    it("replaces an active sanction of the same type with 200 and keeps its start", async () => {
      const first = await json<WireSanction>(
        await sanction({ userId: "alice", type: "mute", reason: "spam" }),
      );
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const res = await sanction({ userId: "alice", type: "mute", reason: "flood", expiresAt });
      expect(res.status).toBe(200);
      const body = await json<WireSanction>(res);
      expect(body).toMatchObject({ id: first.id, reason: "flood", expiresAt, version: 2 });
      expect(body.startedAt).toBe(first.startedAt);
      expect(await prisma.sanction.count()).toBe(1);
    });

    it("answers an identical repeat with 200 and no write, event or version step", async () => {
      const body = { userId: "alice", type: "mute", reason: "spam", issuer: "Console" };
      const first = await json<WireSanction>(await sanction(body));
      const res = await sanction(body);
      expect(res.status).toBe(200);
      expect(res.headers.get("etag")).toBe('"1"');
      expect(await json<WireSanction>(res)).toEqual(first);
      expect(await loggedEvents(prisma, gameId, "game.user.sanctioned")).toHaveLength(1);
      expect(await prisma.sanctionHistory.count()).toBe(1);
      expect(await prisma.auditEntry.count({ where: { action: "game.user.sanctioned" } })).toBe(1);
    });

    it("keeps one active sanction per type and allows several types", async () => {
      await sanction({ userId: "alice", type: "mute" });
      await sanction({ userId: "alice", type: "trade.lock" });
      const res = await call("GET", "/v1/users/alice/sanctions");
      const { items } = await json<{ items: WireSanction[] }>(res);
      expect(items.map((s) => s.type).sort()).toEqual(["mute", "trade.lock"]);
      expect(items.every((s) => s.version === 2)).toBe(true);
    });

    it("refuses the reserved ban type and malformed types", async () => {
      for (const type of ["ban", "Mute", "-mute", "", "a".repeat(33), "mu te"]) {
        const res = await sanction({ userId: "alice", type });
        expect(res.status, type).toBe(400);
        expect((await json<Envelope>(res)).code).toBe("bad_request");
      }
      expect((await sanction({ userId: "alice", type: "a".repeat(32) })).status).toBe(201);
    });

    it("accepts a past startedAt and refuses one more than 60 s ahead", async () => {
      const past = "2025-01-01T00:00:00.000Z";
      const res = await sanction({ userId: "alice", type: "mute", startedAt: past });
      expect(res.status).toBe(201);
      expect((await json<WireSanction>(res)).startedAt).toBe(past);
      const future = new Date(Date.now() + 5 * 60_000).toISOString();
      expect((await sanction({ userId: "bob", type: "mute", startedAt: future })).status).toBe(400);
    });

    it("stores the issuer literally and renders issuedBy", async () => {
      await sanction({ userId: "alice", type: "mute", issuer: "mc:mod", actorUserId: "mc:mod" });
      const mod = await prisma.externalIdentity.findFirstOrThrow({
        where: { externalUserId: "mc:mod" },
      });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: mod.junjoUserId, externalUserId: "web:mod" },
      });
      await prisma.apiKey.updateMany({ data: { preferredNamespaces: ["web"] } });
      const { items } = await json<{ items: WireSanction[] }>(
        await call("GET", "/v1/users/alice/sanctions"),
      );
      expect(items[0]).toMatchObject({ issuer: "mc:mod", issuedBy: "web:mod" });
    });

    it("checks If-Match against the moderation version shared with bans", async () => {
      const ban = await call("POST", "/v1/bans", { body: { userId: "alice" } });
      expect(ban.headers.get("etag")).toBe('"1"');
      const stale = await sanction({ userId: "alice", type: "mute" }, '"0"');
      expect(stale.status).toBe(412);
      expect((await json<Envelope>(stale)).code).toBe("precondition_failed");
      const ok = await sanction({ userId: "alice", type: "mute" }, '"1"');
      expect(ok.status).toBe(201);
      expect(ok.headers.get("etag")).toBe('"2"');
      const unban = await call("DELETE", "/v1/bans/alice", { ifMatch: '"2"' });
      expect(unban.status).toBe(204);
      expect(unban.headers.get("etag")).toBe('"3"');
      expect((await sanction({ userId: "alice", type: "mute", reason: "x" }, "3")).status).toBe(
        200,
      );
    });

    it("emits game.user.sanctioned to the event log and webhooks and writes audit", async () => {
      await prisma.webhookEndpoint.create({
        data: { gameId, url: "https://example.test/hook", secret: "s".repeat(32), events: [] },
      });
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await sanction({ userId: "alice", type: "mute", reason: "spam", expiresAt });
      const [event] = await loggedEvents(prisma, gameId, "game.user.sanctioned");
      expect(event).toMatchObject({
        type: "game.user.sanctioned",
        gameId,
        userId: "alice",
        sanctionType: "mute",
        reason: "spam",
        expiresAt,
        moderationVersion: 1,
      });
      const deliveries = await prisma.webhookDelivery.findMany();
      expect(deliveries.map((d) => (d.payload as { type: string }).type)).toEqual([
        "game.user.sanctioned",
      ]);
      const audit = await prisma.auditEntry.findMany({ where: { gameId } });
      expect(audit.map((a) => [a.action, a.targetId, a.groupId])).toEqual([
        ["game.user.sanctioned", "alice", null],
      ]);
    });

    it("renders userId with the key's namespace preference", async () => {
      const preferring = await createApiKey(gameId, prisma);
      await prisma.apiKey.update({
        where: { id: preferring.apiKey.id },
        data: { preferredNamespaces: ["web"] },
      });
      await sanction({ userId: "mc:alice", type: "mute" });
      const person = await prisma.externalIdentity.findFirstOrThrow({
        where: { externalUserId: "mc:alice" },
      });
      await prisma.externalIdentity.create({
        data: { gameId, junjoUserId: person.junjoUserId, externalUserId: "web:alice" },
      });
      const res = await app.request("/v1/sanctions", {
        headers: { authorization: `Bearer ${preferring.raw.full}` },
      });
      const { items } = await json<{ items: WireSanction[] }>(res);
      expect(items[0]?.userId).toBe("web:alice");
    });
  });

  describe("DELETE /v1/sanctions/:userId/:type", () => {
    it("lifts with 204, bumps the version and emits game.user.unsanctioned", async () => {
      await sanction({ userId: "alice", type: "mute" });
      const res = await lift("alice", "mute", { actorUserId: "mod" });
      expect(res.status).toBe(204);
      expect(res.headers.get("etag")).toBe('"2"');
      expect(await prisma.sanction.count()).toBe(0);
      const [event] = await loggedEvents(prisma, gameId, "game.user.unsanctioned");
      expect(event).toMatchObject({ userId: "alice", sanctionType: "mute", moderationVersion: 2 });
      const audit = await prisma.auditEntry.findFirstOrThrow({
        where: { action: "game.user.unsanctioned" },
      });
      expect(audit.targetId).toBe("alice");
      expect(audit.actorUserId).not.toBeNull();
    });

    it("answers 404 not_active when nothing is active, including unknown users", async () => {
      for (const res of [
        await lift("ghost", "mute"),
        await (async () => {
          await sanction({ userId: "alice", type: "mute" });
          await lift("alice", "mute");
          return lift("alice", "mute");
        })(),
      ]) {
        expect(res.status).toBe(404);
        const body = await json<Envelope>(res);
        expect(body.code).toBe("not_found");
        expect(body.details).toEqual({ reason: "not_active" });
      }
    });

    it("treats a lapsed sanction as not active", async () => {
      await sanction({
        userId: "alice",
        type: "mute",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const res = await lift("alice", "mute");
      expect(res.status).toBe(404);
      expect((await json<Envelope>(res)).details).toEqual({ reason: "not_active" });
    });

    it("refuses the reserved type with 400", async () => {
      expect((await lift("alice", "ban")).status).toBe(400);
    });

    it("checks If-Match, after the not_active answer", async () => {
      await sanction({ userId: "alice", type: "mute" });
      expect((await lift("alice", "mute", undefined, '"0"')).status).toBe(412);
      expect(await prisma.sanction.count()).toBe(1);
      expect((await lift("alice", "mute", undefined, '"1"')).status).toBe(204);
      const replay = await lift("alice", "mute", undefined, '"1"');
      expect(replay.status).toBe(404);
      expect((await json<Envelope>(replay)).details).toEqual({ reason: "not_active" });
    });
  });

  describe("reads", () => {
    it("lists active sanctions newest first, filtered and paged, with the stream position", async () => {
      await sanction({ userId: "a", type: "mute", startedAt: "2026-01-01T00:00:00.000Z" });
      await sanction({ userId: "b", type: "mute", startedAt: "2026-01-02T00:00:00.000Z" });
      await sanction({ userId: "c", type: "freeze", startedAt: "2026-01-03T00:00:00.000Z" });
      await sanction({
        userId: "d",
        type: "mute",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });

      const all = await call("GET", "/v1/sanctions");
      expect(all.headers.get("junjo-stream-position")).not.toBeNull();
      const page1 = await json<{ items: WireSanction[]; nextCursor: string | null }>(all);
      expect(page1.items.map((s) => s.userId)).toEqual(["c", "b", "a"]);

      const muted = await json<{ items: WireSanction[] }>(
        await call("GET", "/v1/sanctions?type=mute"),
      );
      expect(muted.items.map((s) => s.userId)).toEqual(["b", "a"]);

      const first = await json<{ items: WireSanction[]; nextCursor: string | null }>(
        await call("GET", "/v1/sanctions?limit=2"),
      );
      expect(first.items.map((s) => s.userId)).toEqual(["c", "b"]);
      const second = await json<{ items: WireSanction[]; nextCursor: string | null }>(
        await call("GET", `/v1/sanctions?limit=2&cursor=${first.nextCursor}`),
      );
      expect(second.items.map((s) => s.userId)).toEqual(["a"]);
      expect(second.nextCursor).toBeNull();
    });

    it("lists one person's active sanctions with the moderation version as ETag", async () => {
      await sanction({ userId: "alice", type: "mute" });
      await sanction({
        userId: "alice",
        type: "freeze",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      });
      const res = await call("GET", "/v1/users/alice/sanctions");
      expect(res.headers.get("etag")).toBe('"2"');
      const { items } = await json<{ items: WireSanction[] }>(res);
      expect(items.map((s) => s.type)).toEqual(["mute"]);
      const ghost = await call("GET", "/v1/users/ghost/sanctions");
      expect(await json(ghost)).toEqual({ items: [] });
      expect(ghost.headers.get("etag")).toBe('"0"');
    });

    it("adds active sanctions to the moderation read", async () => {
      await sanction({ userId: "alice", type: "mute", reason: "spam" });
      const { etag, body } = await moderation("alice");
      expect(etag).toBe('"1"');
      expect(body.ban).toBeNull();
      expect(body.sanctions).toMatchObject([{ type: "mute", reason: "spam", version: 1 }]);
      expect((await moderation("ghost")).body).toEqual({
        userId: "ghost",
        version: 0,
        ban: null,
        sanctions: [],
      });
    });

    it("keeps history of sets and lifts, newest first, with who lifted", async () => {
      await sanction({
        userId: "alice",
        type: "mute",
        reason: "spam",
        issuer: "Console",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      await sanction({ userId: "alice", type: "freeze", actorUserId: "mod" });
      await lift("alice", "mute", { actorUserId: "admin" });
      const res = await call("GET", "/v1/users/alice/sanctions/history");
      const { items } = await json<{
        items: {
          type: string;
          kind: string;
          actorUserId: string | null;
          issuer: string | null;
          reason: string | null;
          eventAt: string;
        }[];
      }>(res);
      expect(items.map((i) => [i.type, i.kind, i.actorUserId])).toEqual([
        ["mute", "lifted", "admin"],
        ["freeze", "set", "mod"],
        ["mute", "set", null],
      ]);
      expect(items[2]).toMatchObject({
        issuer: "Console",
        reason: "spam",
        eventAt: "2026-01-01T00:00:00.000Z",
      });

      const muteOnly = await json<{ items: { type: string }[] }>(
        await call("GET", "/v1/users/alice/sanctions/history?type=mute"),
      );
      expect(muteOnly.items.every((i) => i.type === "mute")).toBe(true);
      const paged = await json<{ items: unknown[]; nextCursor: string | null }>(
        await call("GET", "/v1/users/alice/sanctions/history?limit=2"),
      );
      expect(paged.items).toHaveLength(2);
      const rest = await json<{ items: unknown[]; nextCursor: string | null }>(
        await call("GET", `/v1/users/alice/sanctions/history?limit=2&cursor=${paged.nextCursor}`),
      );
      expect(rest.items).toHaveLength(1);
      expect(await json(await call("GET", "/v1/users/ghost/sanctions/history"))).toEqual({
        items: [],
        nextCursor: null,
      });
    });

    it("treats a lapsed sanction as absent and replaces it with a new one (201)", async () => {
      const lapsed = await json<WireSanction>(
        await sanction({
          userId: "alice",
          type: "mute",
          startedAt: "2026-01-01T00:00:00.000Z",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        }),
      );
      expect((await moderation("alice")).body.sanctions).toEqual([]);
      const res = await sanction({ userId: "alice", type: "mute" });
      expect(res.status).toBe(201);
      const fresh = await json<WireSanction>(res);
      expect(fresh.startedAt).not.toBe(lapsed.startedAt);
      // Lazy expiry writes nothing.
      expect(await loggedEvents(prisma, gameId, "game.user.unsanctioned")).toEqual([]);
    });
  });

  describe("identity links", () => {
    async function link(issuer: string, redeemer: string) {
      const issued = await call("POST", `/v1/users/${encodeURIComponent(issuer)}/link-codes`);
      expect(issued.status).toBeLessThan(300);
      const { code } = (await issued.json()) as { code: string };
      return call("POST", "/v1/link-codes/redeem", { body: { code, userId: redeemer } });
    }

    it("keeps a sanction when the sanctioned id links to a clean one", async () => {
      expect((await sanction({ userId: "mc:muted", type: "mute" })).status).toBe(201);
      // The issuer is clean; the redeemer holds the sanction, so the
      // redeemer's person must survive and keep it.
      expect((await link("web:clean", "mc:muted")).status).toBeLessThan(300);
      const viaClean = await moderation("web:clean");
      const held = viaClean.body.sanctions as { type: string }[];
      expect(held.map((x) => x.type)).toEqual(["mute"]);
      expect(await prisma.sanctionHistory.count()).toBeGreaterThan(0);
    });

    it("refuses to link two people who both hold sanctions", async () => {
      expect((await sanction({ userId: "mc:a", type: "mute" })).status).toBe(201);
      expect((await sanction({ userId: "web:a", type: "mute" })).status).toBe(201);
      const res = await link("mc:a", "web:a");
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("link_refused");
    });
  });
});
