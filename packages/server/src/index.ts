import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { setMaxPageSize } from "./config/runtime.js";
import { disconnectPrisma, prisma } from "./db.js";
import { loadEnv } from "./env.js";
import { eventHub } from "./eventHub.js";
import { startEventLogSweeper } from "./eventLog.js";
import { startIdleGroupSweeper } from "./groupKinds.js";
import { startIdempotencySweeper } from "./idempotency.js";
import { startLastActivityJob } from "./lastActivity.js";
import { createLogger, logger, setLogger } from "./logger.js";
import { permissionCache, startPermissionCacheSweeper } from "./permissionCache.js";
import { startHardDeleteSweeper } from "./softDelete.js";
import { startWebhookDeliverySweeper, startWebhookWorker } from "./webhookWorker.js";

const env = loadEnv();
setLogger(createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV }));
setMaxPageSize(env.JUNJO_MAX_PAGE_SIZE);
permissionCache.setMaxEntries(env.PERMISSION_CACHE_MAX_ENTRIES);

// Workers must boot before `createApp` so the webhook worker's heartbeat
// handle can be threaded into `/healthz`.
const sweeper = startHardDeleteSweeper(prisma);
const eventLogSweeper = startEventLogSweeper(prisma, {
  retentionHours: env.EVENT_LOG_RETENTION_HOURS,
});
const idempotencySweeper = startIdempotencySweeper(prisma);
const idleGroupSweeper = startIdleGroupSweeper(prisma, eventHub);
const webhookWorker = startWebhookWorker(prisma);
const deliverySweeper = startWebhookDeliverySweeper(prisma, {
  retentionDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
});
const permissionCacheSweeper = startPermissionCacheSweeper(permissionCache);
const lastActivityJob = startLastActivityJob(prisma, {
  intervalMs: env.LAST_ACTIVITY_INTERVAL_MS,
});

const app = createApp({
  adminToken: env.JUNJO_ADMIN_TOKEN,
  rateLimit: { perMinute: env.RATE_LIMIT_PER_MINUTE, burst: env.RATE_LIMIT_BURST },
  trustProxy: env.TRUST_PROXY,
  healthz: { worker: webhookWorker },
  webhooks: { allowPrivateHosts: env.WEBHOOK_ALLOW_PRIVATE_HOSTS },
  events: { pollIntervalMs: env.EVENT_STREAM_POLL_MS },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "junjo-server listening");
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "junjo-server shutting down");
  sweeper.stop();
  eventLogSweeper.stop();
  idempotencySweeper.stop();
  idleGroupSweeper.stop();
  deliverySweeper.stop();
  permissionCacheSweeper.stop();
  lastActivityJob.stop();
  // Drains the in-flight webhook delivery (if any). Capped at
  // WEBHOOK_WORKER_DRAIN_MS (30s) to stay inside a typical orchestrator's
  // terminationGracePeriod.
  await webhookWorker.stop();
  server.close();
  await disconnectPrisma();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
