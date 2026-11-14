import type { GroupId, JunjoEvent } from "@junjo.io/shared";
import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { permissionCache } from "../permissionCache";
import { createApiKey, createGame } from "../seed";
import { waitFor } from "../testHelpers";
import { STREAM_POSITION_HEADER } from "./gameEvents";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const ADMIN_TOKEN = "test-admin-token-permission-config";
const ADMIN = `Bearer ${ADMIN_TOKEN}`;

const TRUNCATE = `TRUNCATE TABLE "EventLog", "GameEventCounter", "AuditEntry", "WebhookDelivery", "WebhookEndpoint", "GameBan", "BanHistory", "MemberRole", "RolePermission", "RoleParent", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE`;

const INHERIT = { world: { inherit: { nether: ["overworld"], end: ["nether"] } } };

interface Frame {
  id?: string;
  event?: string;
  data?: string;
}

// Reads frames until `until` holds or the deadline passes, then cancels
// the reader. Never waits unbounded.
async function readFrames(
  res: Response,
  opts: { timeoutMs: number; until?: (frames: Frame[]) => boolean },
): Promise<Frame[]> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("response has no body");
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + opts.timeoutMs;
  try {
    while (Date.now() < deadline && !(opts.until?.(frames) ?? false)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), deadline - Date.now());
        }),
      ]);
      clearTimeout(timer);
      if (chunk === "timeout" || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame: Frame = {};
        for (const line of block.split("\n")) {
          if (line.startsWith("id: ")) frame.id = line.slice(4);
          else if (line.startsWith("event: ")) frame.event = line.slice(7);
          else if (line.startsWith("data: ")) frame.data = line.slice(6);
        }
        if (frame.event !== undefined) frames.push(frame);
        idx = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

describe.skipIf(!TEST_DATABASE_URL)("permission config reads and change events", () => {
  let prisma: PrismaClient;
  let hub: EventHub;
  let app: Hono;
  let gameId: string;
  let key: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    permissionCache.clear();
    const game = await createGame("Config Game", prisma);
    gameId = game.id;
    key = `Bearer ${(await createApiKey(gameId, prisma)).raw.full}`;
    hub = new EventHub();
    app = createApp({
      prisma,
      adminToken: ADMIN_TOKEN,
      rateLimit: null,
      events: { hub, heartbeatIntervalMs: 30_000, pollIntervalMs: 0 },
    });
  });

  afterEach(() => hub.clear());

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function call(method: string, path: string, body?: unknown, auth: string | null = key) {
    const headers: Record<string, string> = {};
    if (auth !== null) headers.authorization = auth;
    if (body !== undefined) headers["content-type"] = "application/json";
    return app.request(path, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  function patchConfig(config: unknown, target = gameId) {
    return call("PATCH", `/v1/admin/games/${target}/config`, { config }, ADMIN);
  }

  async function makeGroup(): Promise<string> {
    const res = await call("POST", "/v1/groups", {
      kind: "guild",
      name: "G",
      visibility: "public",
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function configEvents() {
    const rows = await prisma.eventLog.findMany({
      where: { gameId, type: "permissions.config.updated" },
      orderBy: { seq: "asc" },
    });
    return rows.map((r) => ({ seq: r.seq, payload: r.payload as Record<string, unknown> }));
  }

  describe("GET /v1/groups/:id/role-graph", () => {
    it("carries an empty contexts map by default and the game's inheritance once set", async () => {
      const groupId = await makeGroup();
      const before = await call("GET", `/v1/groups/${groupId}/role-graph`);
      expect(before.status).toBe(200);
      const fresh = (await before.json()) as Record<string, unknown>;
      expect(fresh.mode).toBe("exact");
      expect(fresh.contexts).toEqual({});

      expect(
        (await patchConfig({ permissions: { mode: "nodes", contexts: INHERIT } })).status,
      ).toBe(200);
      const after = (await (
        await call("GET", `/v1/groups/${groupId}/role-graph`)
      ).json()) as Record<string, unknown>;
      expect(after.mode).toBe("nodes");
      expect(after.contexts).toEqual(INHERIT);
      expect(Object.keys(after)).toEqual(["groupId", "mode", "contexts", "defaultRoleId", "roles"]);
    });

    it("is served with the same contexts on the admin role-graph route", async () => {
      const groupId = await makeGroup();
      await patchConfig({ permissions: { contexts: INHERIT } });
      const res = await call(
        "GET",
        `/v1/admin/games/${gameId}/groups/${groupId}/role-graph`,
        undefined,
        ADMIN,
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as { contexts: unknown }).contexts).toEqual(INHERIT);
    });
  });

  describe("GET /v1/permissions/config", () => {
    it("answers the defaults for a fresh game", async () => {
      const res = await call("GET", "/v1/permissions/config");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "exact", contexts: {} });
      expect(res.headers.get(STREAM_POSITION_HEADER)).toBe("0");
    });

    it("answers the resolved mode and folded inheritance after a change", async () => {
      await patchConfig({
        permissions: { mode: "nodes", contexts: { world: { inherit: { Nether: ["OverWorld"] } } } },
      });
      const res = await call("GET", "/v1/permissions/config");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        mode: "nodes",
        contexts: { world: { inherit: { nether: ["overworld"] } } },
      });
      // The header reflects the change event the write logged.
      expect(res.headers.get(STREAM_POSITION_HEADER)).toBe("1");
    });

    it("requires a game key and is scoped to the key's game", async () => {
      expect((await call("GET", "/v1/permissions/config", undefined, null)).status).toBe(401);
      expect((await call("GET", "/v1/permissions/config", undefined, ADMIN)).status).toBe(401);

      const other = await createGame("Other Game", prisma);
      const otherKey = `Bearer ${(await createApiKey(other.id, prisma)).raw.full}`;
      await patchConfig({ permissions: { mode: "nodes", contexts: INHERIT } });

      const mine = await call("GET", "/v1/permissions/config");
      expect(await mine.json()).toEqual({ mode: "nodes", contexts: INHERIT });
      const theirs = await call("GET", "/v1/permissions/config", undefined, otherKey);
      expect(await theirs.json()).toEqual({ mode: "exact", contexts: {} });
    });

    it("is served on the admin as-game mount", async () => {
      await patchConfig({ permissions: { contexts: INHERIT } });
      const res = await call(
        "GET",
        `/v1/admin/games/${gameId}/as-game/permissions/config`,
        undefined,
        ADMIN,
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ mode: "exact", contexts: INHERIT });
      const missing = await call(
        "GET",
        "/v1/admin/games/no-such-game/as-game/permissions/config",
        undefined,
        ADMIN,
      );
      expect(missing.status).toBe(404);
    });
  });

  describe("permissions.config.updated", () => {
    it("is logged once per change with the new values", async () => {
      const published: JunjoEvent[] = [];
      hub.subscribeGame(gameId, (e) => published.push(e));

      expect((await patchConfig({ permissions: { mode: "nodes" } })).status).toBe(200);
      let logged = await configEvents();
      expect(logged).toHaveLength(1);
      expect(logged[0]?.payload).toMatchObject({
        type: "permissions.config.updated",
        gameId,
        mode: "nodes",
        contexts: {},
      });
      expect(typeof logged[0]?.payload.id).toBe("string");
      expect(typeof logged[0]?.payload.occurredAt).toBe("string");
      expect(Object.keys(logged[0]?.payload ?? {}).sort()).toEqual(
        ["contexts", "gameId", "id", "mode", "occurredAt", "origin", "type"].sort(),
      );

      expect((await patchConfig({ permissions: { contexts: INHERIT } })).status).toBe(200);
      logged = await configEvents();
      expect(logged).toHaveLength(2);
      expect(logged[1]?.payload).toMatchObject({ mode: "nodes", contexts: INHERIT });

      // Both reached the hub after their commits.
      expect(published.map((e) => e.type)).toEqual([
        "permissions.config.updated",
        "permissions.config.updated",
      ]);
    });

    it("is not emitted by a no-op patch or an unrelated config change", async () => {
      await patchConfig({ permissions: { mode: "nodes", contexts: INHERIT } });
      expect(await configEvents()).toHaveLength(1);

      // The same values again, restated in another case and key order.
      await patchConfig({ permissions: { mode: "nodes" } });
      await patchConfig({
        permissions: {
          contexts: { world: { inherit: { End: ["Nether"], nether: ["OVERWORLD"] } } },
        },
      });
      await patchConfig({ friends: { enabled: false, maxFriends: 10 } });
      await patchConfig({ blocks: { enabled: false } });
      await call("PATCH", `/v1/admin/games/${gameId}/config`, { networkId: "net-a" }, ADMIN);
      expect(await configEvents()).toHaveLength(1);
      expect(await prisma.eventLog.count({ where: { gameId } })).toBe(1);
    });

    it("is not emitted by a patch that fails validation", async () => {
      const res = await patchConfig({ permissions: { mode: "nodes", contexts: { BAD: {} } } });
      expect(res.status).toBe(400);
      expect(await configEvents()).toHaveLength(0);
    });

    it("lands on the game stream in position order and on no group stream", async () => {
      const groupId = await makeGroup();
      const groupEvents: JunjoEvent[] = [];
      hub.subscribe(groupId as GroupId, (e) => groupEvents.push(e));

      const stream = await call("GET", "/v1/events");
      expect(stream.status).toBe(200);
      expect(stream.headers.get(STREAM_POSITION_HEADER)).toBe("0");
      const filtered = await call("GET", "/v1/events?types=permissions.config.updated");
      expect(filtered.status).toBe(200);
      await waitFor(() => hub.gameSubscriberCount(gameId) > 0);

      expect((await call("POST", "/v1/bans", { userId: "u1" })).status).toBeLessThan(300);
      await patchConfig({ permissions: { mode: "nodes", contexts: INHERIT } });
      expect((await call("POST", "/v1/bans", { userId: "u2" })).status).toBeLessThan(300);

      const [all, only] = await Promise.all([
        readFrames(stream, { timeoutMs: 3000, until: (f) => f.length >= 3 }),
        readFrames(filtered, { timeoutMs: 3000, until: (f) => f.length >= 1 }),
      ]);
      expect(all.map((f) => [f.event, f.id])).toEqual([
        ["game.user.banned", "1"],
        ["permissions.config.updated", "2"],
        ["game.user.banned", "3"],
      ]);
      const data = JSON.parse(all[1]?.data ?? "{}") as Record<string, unknown>;
      expect(data).toMatchObject({
        type: "permissions.config.updated",
        gameId,
        mode: "nodes",
        contexts: INHERIT,
      });
      expect("groupId" in data).toBe(false);
      expect(only.map((f) => [f.event, f.id])).toEqual([["permissions.config.updated", "2"]]);
      expect(groupEvents.some((e) => e.type === "permissions.config.updated")).toBe(false);
    });

    it("resumes from a position read with the config", async () => {
      await patchConfig({ permissions: { mode: "nodes" } });
      const read = await call("GET", "/v1/permissions/config");
      const position = read.headers.get(STREAM_POSITION_HEADER) ?? "";
      expect(position).toBe("1");

      await patchConfig({ permissions: { contexts: INHERIT } });
      const resumed = await app.request("/v1/events", {
        headers: { authorization: key, "last-event-id": position },
      });
      expect(resumed.status).toBe(200);
      const frames = await readFrames(resumed, { timeoutMs: 3000, until: (f) => f.length >= 1 });
      expect(frames.map((f) => [f.event, f.id])).toEqual([["permissions.config.updated", "2"]]);
    });

    it("enqueues a webhook delivery for a subscribed endpoint", async () => {
      await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://example.com/hook",
          secret: "deadbeef",
          events: ["permissions.config.updated"],
        },
      });
      await prisma.webhookEndpoint.create({
        data: {
          gameId,
          url: "https://example.com/other",
          secret: "deadbeef",
          events: ["game.user.banned"],
        },
      });
      await patchConfig({ permissions: { contexts: INHERIT } });
      const deliveries = await prisma.webhookDelivery.findMany({ include: { endpoint: true } });
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.endpoint.url).toBe("https://example.com/hook");
      expect(deliveries[0]?.payload).toMatchObject({
        type: "permissions.config.updated",
        mode: "exact",
        contexts: INHERIT,
      });
    });

    it("is accepted as a webhook subscription type", async () => {
      const res = await call("POST", "/v1/webhooks", {
        url: "https://example.com/hook",
        events: ["permissions.config.updated"],
      });
      expect(res.status).toBe(201);
    });
  });
});
