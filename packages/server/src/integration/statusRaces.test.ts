import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Status-changing member writes decide from the row as locked inside
// their transaction, so a write that read the member earlier cannot
// overwrite a status another write set in the meantime.
describe.skipIf(!TEST_DATABASE_URL)("member status races", { timeout: 60_000 }, () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let group: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "BanHistory", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Races", prisma);
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma, rateLimit: null, events: { hub: new EventHub() } });
    const res = await call("POST", "/v1/groups", {
      kind: "guild",
      name: "G",
      visibility: "public",
    });
    group = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function call(method: string, path: string, body?: unknown) {
    return app.request(path, {
      method,
      headers: { authorization: key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async function statusOf(userId: string): Promise<string> {
    const res = await call("GET", `/v1/groups/${group}/members/${userId}`);
    return ((await res.json()) as { status: string }).status;
  }

  it("a kick racing a ban never overwrites the ban", async () => {
    for (let round = 0; round < 8; round++) {
      const user = `k${round}`;
      expect((await call("POST", `/v1/groups/${group}/members`, { userId: user })).status).toBe(
        201,
      );
      const results = await Promise.all([
        call("POST", `/v1/groups/${group}/members/${user}/ban`, {}),
        call("POST", `/v1/groups/${group}/members/${user}/kick`, {}),
      ]);
      expect(results.map((r) => r.status).filter((s) => s >= 500)).toEqual([]);
      expect(await statusOf(user)).toBe("banned");
    }
  });

  it("two concurrent unbans lift the ban once", async () => {
    for (let round = 0; round < 5; round++) {
      const user = `u${round}`;
      await call("POST", `/v1/groups/${group}/members`, { userId: user });
      expect((await call("POST", `/v1/groups/${group}/members/${user}/ban`, {})).status).toBe(200);
      const results = await Promise.all([
        call("DELETE", `/v1/groups/${group}/members/${user}/ban`),
        call("DELETE", `/v1/groups/${group}/members/${user}/ban`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
      const lifts = await prisma.banHistory.count({ where: { kind: "lifted", scope: "group" } });
      expect(lifts).toBe(round + 1);
    }
  });
});
