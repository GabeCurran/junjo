import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Parent writes hold a graph lock instead of running SERIALIZABLE; these
// cases pin both halves of that: no failures from unrelated events in
// the same game, and still no cycle from two racing writes.
describe.skipIf(!TEST_DATABASE_URL)("parent graph locks", { timeout: 60_000 }, () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "RoleParent", "RolePermission", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Graph", prisma);
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma, rateLimit: null, events: { hub: new EventHub() } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function makeGroup(name: string): Promise<string> {
    const res = await call("POST", "/v1/groups", { kind: "guild", name, visibility: "public" });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  async function makeRole(groupId: string, name: string): Promise<string> {
    const res = await call("POST", `/v1/groups/${groupId}/roles`, { name, priority: 1 });
    expect(res.status).toBe(201);
    return ((await res.json()) as { id: string }).id;
  }

  it("parent writes succeed while other events in the game commit", async () => {
    const g = await makeGroup("G");
    const roles = await Promise.all(["a", "b", "c", "d"].map((n) => makeRole(g, n)));
    const busy = await makeGroup("Busy");
    const other = await makeGroup("Other");
    let n = 0;
    const statuses: number[] = [];
    for (let round = 0; round < 4; round++) {
      const results = await Promise.all([
        call("PUT", `/v1/roles/${roles[0]}/parents`, { parents: round % 2 ? [] : [roles[1]] }),
        call("PUT", `/v1/roles/${roles[2]}/parents`, { parents: round % 2 ? [] : [roles[3]] }),
        call("PUT", `/v1/groups/${other}/parent`, { parentGroupId: round % 2 ? null : g }),
        ...Array.from({ length: 12 }, () =>
          call("POST", `/v1/groups/${busy}/members`, { userId: `u${n++}` }),
        ),
      ]);
      statuses.push(...results.map((r) => r.status));
    }
    expect(statuses.filter((s) => s >= 500)).toEqual([]);
  });

  it("two reciprocal role parent writes never close a cycle", async () => {
    const g = await makeGroup("G");
    for (let round = 0; round < 5; round++) {
      const a = await makeRole(g, `a${round}`);
      const b = await makeRole(g, `b${round}`);
      const [ra, rb] = await Promise.all([
        call("PUT", `/v1/roles/${a}/parents`, { parents: [b] }),
        call("PUT", `/v1/roles/${b}/parents`, { parents: [a] }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([200, 400]);
      const refused = ra.status === 400 ? ra : rb;
      expect(((await refused.json()) as { code: string }).code).toBe("parent_cycle");
    }
  });
});
