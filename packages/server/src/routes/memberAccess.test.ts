import { PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";
import { STREAM_POSITION_HEADER } from "./gameEvents";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface Access {
  userId: string;
  status: string;
  roleIds: string[];
  version: number;
  metadata: Record<string, unknown>;
}

describe.skipIf(!TEST_DATABASE_URL)("member access reads", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let key: string;
  let group: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberRole", "GroupMember", "ExternalIdentity", "JunjoUser", "Role", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Access", prisma);
    key = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    app = createApp({ prisma, rateLimit: null, events: { hub: new EventHub() } });
    const res = await call("POST", "/v1/groups", { kind: "guild", name: "G" });
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

  async function addWithPrefix(userId: string, prefix: string) {
    expect((await call("POST", `/v1/groups/${group}/members`, { userId })).status).toBe(201);
    const patched = await call("PATCH", `/v1/groups/${group}/members/${userId}`, {
      metadata: { prefix },
    });
    expect(patched.status).toBe(200);
  }

  const batch = (userIds: unknown) =>
    call("POST", `/v1/groups/${group}/members/access`, { userIds });

  it("includes the member's metadata on the single read", async () => {
    await addWithPrefix("mc:a", "[VIP]");
    const res = await call("GET", `/v1/groups/${group}/members/mc:a/access`);
    expect(res.status).toBe(200);
    const access = (await res.json()) as Access;
    expect(access.metadata).toEqual({ prefix: "[VIP]" });
    expect(res.headers.get("etag")).toBe(`"${access.version}"`);
  });

  it("answers a batch in request order with null for non-members", async () => {
    await addWithPrefix("mc:a", "[A]");
    await addWithPrefix("mc:b", "[B]");
    // Known person who is not a member of this group.
    const other = await call("POST", "/v1/groups", { kind: "guild", name: "Other" });
    const otherId = ((await other.json()) as { id: string }).id;
    await call("POST", `/v1/groups/${otherId}/members`, { userId: "mc:c" });

    const res = await batch(["mc:b", "mc:never", "mc:a", "mc:c"]);
    expect(res.status).toBe(200);
    expect(res.headers.get(STREAM_POSITION_HEADER)).toMatch(/^\d+$/);
    const { items } = (await res.json()) as { items: (Access | null)[] };
    expect(items.map((i) => i?.userId ?? null)).toEqual(["mc:b", null, "mc:a", null]);
    expect(items[0]?.metadata).toEqual({ prefix: "[B]" });
  });

  it("finds a member by any of their linked ids", async () => {
    await addWithPrefix("mc:java", "[J]");
    const issued = await call("POST", "/v1/users/mc%3Ajava/link-codes");
    const { code } = (await issued.json()) as { code: string };
    const redeemed = await call("POST", "/v1/link-codes/redeem", { code, userId: "mc:bedrock" });
    expect(redeemed.status).toBe(200);
    const { items } = (await (await batch(["mc:bedrock"])).json()) as {
      items: (Access | null)[];
    };
    expect(items[0]?.metadata).toEqual({ prefix: "[J]" });
  });

  it("validates the request", async () => {
    expect((await batch([])).status).toBe(400);
    expect((await batch(Array.from({ length: 101 }, (_, i) => `u${i}`))).status).toBe(400);
    expect((await batch("mc:a")).status).toBe(400);
    const missing = await app.request("/v1/groups/nope/members/access", {
      method: "POST",
      headers: { authorization: key, "content-type": "application/json" },
      body: JSON.stringify({ userIds: ["mc:a"] }),
    });
    expect(missing.status).toBe(404);
  });
});
