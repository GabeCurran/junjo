import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import {
  HEALTHZ_DB_TIMEOUT_MS,
  HEALTHZ_WORKER_STALE_MS,
  type WorkerHeartbeatProvider,
} from "./health";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

interface HealthBody {
  status: "ok" | "degraded";
  db: { ok: true } | { ok: false; reason: string };
  webhookWorker: { ok: true } | { ok: false; reason: string; ageMs?: number };
  timestamp: string;
}

function fakeWorker(getLastHeartbeat: () => Date | null): WorkerHeartbeatProvider {
  return { getLastHeartbeat };
}

// Stub Prisma whose `$queryRaw` always rejects. Used to simulate the
// "DB down" case without tearing down the real test database. Cast via
// `unknown` because the route only touches `$queryRaw`.
function fakePrismaThatRejectsQueryRaw(reason: string): PrismaClient {
  const stub = {
    $queryRaw: () => Promise.reject(new Error(reason)),
  };
  return stub as unknown as PrismaClient;
}

// Stub Prisma whose `$queryRaw` never resolves. Used to verify the
// route's own timeout fires when Postgres is wedged.
function fakePrismaThatHangs(): PrismaClient {
  const stub = {
    $queryRaw: () => new Promise<never>(() => {}),
  };
  return stub as unknown as PrismaClient;
}

describe("HEALTHZ constants", () => {
  it("exports a 60s worker stale threshold (12x worker tick interval)", () => {
    expect(HEALTHZ_WORKER_STALE_MS).toBe(60_000);
  });

  it("exports a 2s db ping timeout", () => {
    expect(HEALTHZ_DB_TIMEOUT_MS).toBe(2_000);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("GET /healthz", () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    if (!TEST_DATABASE_URL) return;
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  afterAll(async () => {
    if (!TEST_DATABASE_URL) return;
    await prisma.$disconnect();
  });

  it("returns 200 with status:ok when DB ping succeeds and worker is fresh", async () => {
    const worker = fakeWorker(() => new Date(Date.now() - 1_000));
    const app = createApp({ prisma, healthz: { worker } });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.db).toEqual({ ok: true });
    expect(body.webhookWorker).toEqual({ ok: true });
    expect(typeof body.timestamp).toBe("string");
    expect(() => new Date(body.timestamp).toISOString()).not.toThrow();
  });

  it("treats a missing worker provider as ok (no worker configured)", async () => {
    const app = createApp({ prisma });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("ok");
    expect(body.webhookWorker).toEqual({ ok: true });
  });

  it("does not require an Authorization header", async () => {
    const app = createApp({ prisma });
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("returns 503 with status:degraded and worker reason when heartbeat is stale", async () => {
    const stale = new Date(Date.now() - 5 * 60_000);
    const worker = fakeWorker(() => stale);
    const app = createApp({ prisma, healthz: { worker } });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.db).toEqual({ ok: true });
    expect(body.webhookWorker.ok).toBe(false);
    if (body.webhookWorker.ok === false) {
      expect(body.webhookWorker.reason).toMatch(/heartbeat is \d+ms old/);
      expect(body.webhookWorker.ageMs).toBeGreaterThan(HEALTHZ_WORKER_STALE_MS);
    }
  });

  it("returns 503 when worker has never completed a tick (heartbeat null)", async () => {
    const worker = fakeWorker(() => null);
    const app = createApp({ prisma, healthz: { worker } });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.webhookWorker.ok).toBe(false);
    if (body.webhookWorker.ok === false) {
      expect(body.webhookWorker.reason).toMatch(/has not completed a tick/);
    }
  });

  it("respects a custom workerStaleMs threshold", async () => {
    const heartbeat = new Date(Date.now() - 15_000);
    const worker = fakeWorker(() => heartbeat);
    const tightApp = createApp({ prisma, healthz: { worker, workerStaleMs: 5_000 } });
    const tightRes = await tightApp.request("/healthz");
    expect(tightRes.status).toBe(503);
    const looseApp = createApp({ prisma, healthz: { worker, workerStaleMs: 60_000 } });
    const looseRes = await looseApp.request("/healthz");
    expect(looseRes.status).toBe(200);
  });

  it("returns 503 with status:degraded and db reason when DB ping rejects", async () => {
    const broken = fakePrismaThatRejectsQueryRaw("connection refused");
    const worker = fakeWorker(() => new Date(Date.now() - 1_000));
    const app = createApp({ prisma: broken, healthz: { worker } });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.db.ok).toBe(false);
    if (body.db.ok === false) {
      expect(body.db.reason).toBe("connection refused");
    }
    expect(body.webhookWorker).toEqual({ ok: true });
  });

  it("returns 503 when DB ping exceeds the timeout", async () => {
    const hanging = fakePrismaThatHangs();
    const worker = fakeWorker(() => new Date(Date.now() - 1_000));
    const app = createApp({
      prisma: hanging,
      healthz: { worker, dbTimeoutMs: 50 },
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.db.ok).toBe(false);
    if (body.db.ok === false) {
      expect(body.db.reason).toMatch(/db ping timeout after 50ms/);
    }
  });

  it("returns 503 when both DB and worker are unhealthy at once", async () => {
    const broken = fakePrismaThatRejectsQueryRaw("postgres down");
    const worker = fakeWorker(() => null);
    const app = createApp({ prisma: broken, healthz: { worker } });
    const res = await app.request("/healthz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe("degraded");
    expect(body.db.ok).toBe(false);
    expect(body.webhookWorker.ok).toBe(false);
  });

  it("does not break the cheap liveness probe at /", async () => {
    const app = createApp({ prisma });
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; version: string };
    expect(body.name).toBe("junjo-server");
    expect(typeof body.version).toBe("string");
  });
});
