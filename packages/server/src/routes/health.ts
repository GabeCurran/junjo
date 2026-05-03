import type { PrismaClient } from "@prisma/client";
import type { Context } from "hono";
import { logger } from "../logger.js";

// Worker stale threshold is 12x the production worker tick interval (5s):
// a worker that has not completed a tick in a full minute is broken, not
// slow. DB timeout is short enough to keep load balancers from holding
// the probe open while Postgres is wedged.
export const HEALTHZ_WORKER_STALE_MS = 60_000;
export const HEALTHZ_DB_TIMEOUT_MS = 2_000;

export interface WorkerHeartbeatProvider {
  getLastHeartbeat(): Date | null;
}

export interface HealthCheckOptions {
  worker?: WorkerHeartbeatProvider;
  workerStaleMs?: number;
  dbTimeoutMs?: number;
  now?: () => Date;
}

export interface HealthCheckOk {
  ok: true;
}
export interface HealthCheckFailed {
  ok: false;
  reason: string;
  ageMs?: number;
}
export type HealthCheckComponent = HealthCheckOk | HealthCheckFailed;

export interface HealthCheckBody {
  status: "ok" | "degraded";
  db: HealthCheckComponent;
  webhookWorker: HealthCheckComponent;
  timestamp: string;
}

async function pingDb(prisma: PrismaClient, timeoutMs: number): Promise<HealthCheckComponent> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`db ping timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
      if (typeof timer.unref === "function") timer.unref();
    });
    await Promise.race([prisma.$queryRaw`SELECT 1`, timeout]);
    return { ok: true };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function checkWorker(
  provider: WorkerHeartbeatProvider | undefined,
  staleMs: number,
  now: Date,
): HealthCheckComponent {
  // No provider means the deployment did not wire a worker handle into
  // createApp (e.g., a test harness, or a deployment that disables it).
  if (!provider) return { ok: true };
  const last = provider.getLastHeartbeat();
  if (last === null) {
    return { ok: false, reason: "worker has not completed a tick yet" };
  }
  const ageMs = now.getTime() - last.getTime();
  if (ageMs > staleMs) {
    return {
      ok: false,
      reason: `worker heartbeat is ${ageMs}ms old (threshold ${staleMs}ms)`,
      ageMs,
    };
  }
  return { ok: true };
}

// Deep readiness check (DB ping + worker heartbeat). The `/` route stays
// as the cheap liveness probe.
export function healthCheckHandler(prisma: PrismaClient, opts: HealthCheckOptions = {}) {
  const workerStaleMs = opts.workerStaleMs ?? HEALTHZ_WORKER_STALE_MS;
  const dbTimeoutMs = opts.dbTimeoutMs ?? HEALTHZ_DB_TIMEOUT_MS;
  const now = opts.now ?? (() => new Date());

  return async (c: Context) => {
    const ts = now();
    const db = await pingDb(prisma, dbTimeoutMs);
    const worker = checkWorker(opts.worker, workerStaleMs, ts);
    const allOk = db.ok && worker.ok;
    const body: HealthCheckBody = {
      status: allOk ? "ok" : "degraded",
      db,
      webhookWorker: worker,
      timestamp: ts.toISOString(),
    };
    if (!allOk) {
      logger.warn({ db, webhookWorker: worker }, "healthz reports degraded");
    }
    return c.json(body, allOk ? 200 : 503);
  };
}
