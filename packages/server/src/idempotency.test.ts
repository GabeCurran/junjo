import { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { Errors } from "./errors";
import {
  IDEMPOTENCY_ABANDON_MS,
  IDEMPOTENCY_RETENTION_HOURS,
  idempotencyMiddleware,
  sweepIdempotencyRecords,
} from "./idempotency";
import { errorHandler } from "./middleware/error";
import { newRequestContext, runWithRequestContext } from "./requestContext";
import { createApiKey, createGame } from "./seed";
import { waitFor } from "./testHelpers";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;

let prisma: PrismaClient;

beforeAll(() => {
  if (!TEST_DATABASE_URL) return;
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
});

afterAll(async () => {
  if (!TEST_DATABASE_URL) return;
  await prisma.$disconnect();
});

async function reset(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "IdempotencyRecord", "AuditEntry", "GroupMember", "ExternalIdentity", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
  );
}

describe.skipIf(!TEST_DATABASE_URL)("Idempotency-Key middleware", () => {
  let keyA: string;
  let keyB: string;
  let clock: number;
  let runs: number;
  let gate: Promise<void> | null;

  // A minimal app around the middleware: the key id comes from a header
  // so a test can act as either key, and the routes count their runs.
  function buildApp(): Hono {
    const app = new Hono();
    app.onError(errorHandler);
    app.use("*", (c, next) => {
      const ctx = newRequestContext();
      ctx.apiKeyId = c.req.header("x-test-key") ?? null;
      return runWithRequestContext(ctx, next);
    });
    app.use("*", idempotencyMiddleware(prisma, { now: () => clock }));
    app.post("/things", async (c) => {
      runs++;
      if (gate) await gate;
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      c.header("ETag", `"${runs}"`);
      return c.json({ run: runs, echo: body }, 201);
    });
    app.post("/missing", () => {
      runs++;
      throw Errors.notFound("thing");
    });
    app.post("/crash", () => {
      runs++;
      throw new Error("boom");
    });
    app.post("/unavailable", (c) => {
      runs++;
      return c.json({ code: "internal" }, 503);
    });
    app.delete("/things/:id", (c) => {
      runs++;
      return c.body(null, 204);
    });
    app.get("/things", (c) => {
      runs++;
      return c.json({ run: runs });
    });
    return app;
  }

  let app: Hono;

  beforeEach(async () => {
    await reset();
    const game = await createGame("Idem", prisma);
    keyA = (await createApiKey(game.id, prisma)).apiKey.id;
    keyB = (await createApiKey(game.id, prisma)).apiKey.id;
    clock = Date.parse("2026-11-01T00:00:00.000Z");
    runs = 0;
    gate = null;
    app = buildApp();
  });

  function send(
    path: string,
    opts: { key?: string; idem?: string; body?: unknown; method?: string } = {},
  ) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (opts.key !== undefined) headers["x-test-key"] = opts.key;
    if (opts.idem !== undefined) headers["idempotency-key"] = opts.idem;
    return app.request(path, {
      method: opts.method ?? "POST",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  it("replays the stored response without running the handler again", async () => {
    const first = await send("/things", { key: keyA, idem: "k1", body: { a: 1 } });
    expect(first.status).toBe(201);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    const firstBody = await first.json();

    const second = await send("/things", { key: keyA, idem: "k1", body: { a: 1 } });
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.headers.get("content-type")).toContain("application/json");
    expect(second.headers.get("etag")).toBe('"1"');
    expect(await second.json()).toEqual(firstBody);
    expect(runs).toBe(1);
  });

  it("replays a stored 4xx answer", async () => {
    const first = await send("/missing", { key: keyA, idem: "k404" });
    expect(first.status).toBe(404);
    const second = await send("/missing", { key: keyA, idem: "k404" });
    expect(second.status).toBe(404);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(((await second.json()) as { code: string }).code).toBe("not_found");
    expect(runs).toBe(1);
  });

  it("replays a 204 with no body", async () => {
    await send("/things/1", { key: keyA, idem: "del", method: "DELETE" });
    const again = await send("/things/1", { key: keyA, idem: "del", method: "DELETE" });
    expect(again.status).toBe(204);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.text()).toBe("");
    expect(runs).toBe(1);
  });

  it("answers 422 when the key is reused with a different body, path or query", async () => {
    await send("/things", { key: keyA, idem: "k2", body: { a: 1 } });
    for (const variant of [
      { path: "/things", body: { a: 2 } },
      { path: "/things?x=1", body: { a: 1 } },
      { path: "/missing", body: { a: 1 } },
    ]) {
      const res = await send(variant.path, { key: keyA, idem: "k2", body: variant.body });
      expect(res.status).toBe(422);
      expect(((await res.json()) as { code: string }).code).toBe("idempotency_key_reused");
    }
    expect(runs).toBe(1);
  });

  it("answers 409 with Retry-After while the first request is still running", async () => {
    let release: () => void = () => undefined;
    gate = new Promise<void>((r) => {
      release = r;
    });
    const first = send("/things", { key: keyA, idem: "slow", body: {} });
    await waitFor(() => runs > 0);
    expect(runs).toBe(1);

    const second = await send("/things", { key: keyA, idem: "slow", body: {} });
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toBe("1");
    expect(((await second.json()) as { code: string }).code).toBe("idempotency_key_in_progress");

    release();
    expect((await first).status).toBe(201);
    const third = await send("/things", { key: keyA, idem: "slow", body: {} });
    expect(third.headers.get("idempotent-replayed")).toBe("true");
    expect(runs).toBe(1);
  });

  it("stores nothing for a 5xx or a thrown error, so a retry runs again", async () => {
    expect((await send("/unavailable", { key: keyA, idem: "u" })).status).toBe(503);
    expect((await send("/unavailable", { key: keyA, idem: "u" })).status).toBe(503);
    expect((await send("/crash", { key: keyA, idem: "c" })).status).toBe(500);
    expect((await send("/crash", { key: keyA, idem: "c" })).status).toBe(500);
    expect(runs).toBe(4);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("scopes keys per API key", async () => {
    const a = await send("/things", { key: keyA, idem: "shared", body: { who: "a" } });
    const b = await send("/things", { key: keyB, idem: "shared", body: { who: "b" } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBeNull();
    expect(runs).toBe(2);
  });

  it("treats a record older than the retention window as absent", async () => {
    await send("/things", { key: keyA, idem: "old", body: { a: 1 } });
    clock += IDEMPOTENCY_RETENTION_HOURS * HOUR + 1;
    const res = await send("/things", { key: keyA, idem: "old", body: { a: 2 } });
    expect(res.status).toBe(201);
    expect(res.headers.get("idempotent-replayed")).toBeNull();
    expect(runs).toBe(2);
  });

  it("claims an abandoned in-progress record but not a fresh one", async () => {
    await prisma.idempotencyRecord.create({
      data: {
        apiKeyId: keyA,
        key: "fresh",
        fingerprint: "x",
        state: "in_progress",
        createdAt: new Date(clock - 1000),
      },
    });
    const blocked = await send("/things", { key: keyA, idem: "fresh", body: {} });
    // A fresh record with another fingerprint is a reuse, not a retry.
    expect(blocked.status).toBe(422);

    await prisma.idempotencyRecord.create({
      data: {
        apiKeyId: keyA,
        key: "dead",
        fingerprint: "x",
        state: "in_progress",
        createdAt: new Date(clock - IDEMPOTENCY_ABANDON_MS - 1000),
      },
    });
    const res = await send("/things", { key: keyA, idem: "dead", body: {} });
    expect(res.status).toBe(201);
    const row = await prisma.idempotencyRecord.findUnique({
      where: { apiKeyId_key: { apiKeyId: keyA, key: "dead" } },
    });
    expect(row?.state).toBe("completed");
    expect(row?.createdAt.getTime()).toBe(clock);
  });

  it("answers 409 for a fresh in-progress record with the same fingerprint", async () => {
    let release: () => void = () => undefined;
    gate = new Promise<void>((r) => {
      release = r;
    });
    const first = send("/things", { key: keyA, idem: "same", body: { z: 1 } });
    await waitFor(() => runs > 0);
    clock += IDEMPOTENCY_ABANDON_MS - 1000;
    const res = await send("/things", { key: keyA, idem: "same", body: { z: 1 } });
    expect(res.status).toBe(409);
    release();
    await first;
  });

  it("rejects malformed keys with 400", async () => {
    for (const bad of ["", "has space", "x".repeat(256), "tab\there", "café"]) {
      const res = await Promise.resolve()
        .then(() =>
          app.request("/things", {
            method: "POST",
            headers: { "x-test-key": keyA, "idempotency-key": bad },
            body: "{}",
          }),
        )
        .catch(() => null);
      // Some values cannot be sent as a header at all; those never reach us.
      if (!res) continue;
      expect(res.status).toBe(400);
    }
    const ok = await send("/things", { key: keyA, idem: "x".repeat(255), body: {} });
    expect(ok.status).toBe(201);
  });

  it("ignores the header on reads and on requests without an API key", async () => {
    await send("/things", { key: keyA, idem: "g", method: "GET" });
    await send("/things", { key: keyA, idem: "g", method: "GET" });
    await send("/things", { idem: "nokey", body: {} });
    await send("/things", { idem: "nokey", body: {} });
    expect(runs).toBe(4);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("sweeps records older than the retention window", async () => {
    await send("/things", { key: keyA, idem: "s1", body: {} });
    clock += 2 * HOUR;
    await send("/things", { key: keyA, idem: "s2", body: {} });
    const removed = await sweepIdempotencyRecords(prisma, {
      now: () => clock + (IDEMPOTENCY_RETENTION_HOURS - 1) * HOUR,
    });
    expect(removed).toBe(1);
    const left = await prisma.idempotencyRecord.findMany();
    expect(left.map((r) => r.key)).toEqual(["s2"]);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("Idempotency-Key on the API", () => {
  let auth: string;
  let otherGameAuth: string;
  let app: Hono;

  beforeEach(async () => {
    await reset();
    app = createApp({ prisma });
    const game = await createGame("Idem API", prisma);
    auth = `Bearer ${(await createApiKey(game.id, prisma)).raw.full}`;
    const other = await createGame("Other", prisma);
    otherGameAuth = `Bearer ${(await createApiKey(other.id, prisma)).raw.full}`;
  });

  it("creates one group for a replayed POST and returns the same body", async () => {
    const send = () =>
      app.request("/v1/groups", {
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "idempotency-key": "create-guild-1",
        },
        body: JSON.stringify({ kind: "guild", name: "Knights" }),
      });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
    expect(await prisma.group.count()).toBe(1);
  });

  it("does not store a request that matched no route", async () => {
    const send = () =>
      app.request("/v1/no-such-route", {
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/json",
          "idempotency-key": "typo-1",
        },
        body: JSON.stringify({}),
      });
    expect((await send()).status).toBe(404);
    const again = await send();
    expect(again.status).toBe(404);
    expect(again.headers.get("idempotent-replayed")).toBeNull();
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("rejects strings holding U+0000 with 400 instead of a 500", async () => {
    const created = await app.request("/v1/groups", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ kind: "guild", name: "Nul" }),
    });
    const { id } = (await created.json()) as { id: string };
    const add = await app.request(`/v1/groups/${id}/members`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ userId: "a\u0000b" }),
    });
    expect(add.status).toBe(400);
    expect(((await add.json()) as { code: string }).code).toBe("bad_request");
    const joined = await app.request(`/v1/groups/${id}/members`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ userId: "ok-user" }),
    });
    expect(joined.status).toBeLessThan(300);
    const patched = await app.request(`/v1/groups/${id}/members/ok-user`, {
      method: "PATCH",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { tag: "x\u0000y" } }),
    });
    expect(patched.status).toBe(400);
  });

  it("does not apply to admin-token routes", async () => {
    const admin = createApp({ prisma, adminToken: "t0ken" });
    const send = () =>
      admin.request("/v1/admin/games", {
        method: "POST",
        headers: {
          authorization: "Bearer t0ken",
          "content-type": "application/json",
          "idempotency-key": "admin-1",
        },
        body: JSON.stringify({ name: "Admin game" }),
      });
    expect((await send()).status).toBe(201);
    const again = await send();
    expect(again.headers.get("idempotent-replayed")).toBeNull();
    expect(await prisma.idempotencyRecord.count()).toBe(0);
  });

  it("lets two keys of different games reuse one string", async () => {
    const send = (authorization: string) =>
      app.request("/v1/groups", {
        method: "POST",
        headers: {
          authorization,
          "content-type": "application/json",
          "idempotency-key": "same",
        },
        body: JSON.stringify({ kind: "guild", name: "G" }),
      });
    expect((await send(auth)).status).toBe(201);
    const other = await send(otherGameAuth);
    expect(other.status).toBe(201);
    expect(other.headers.get("idempotent-replayed")).toBeNull();
    expect(await prisma.group.count()).toBe(2);
  });
});
