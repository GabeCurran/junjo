import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { disconnectPrisma, prisma } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger, logger, setLogger } from "./logger.js";
import { startHardDeleteSweeper } from "./softDelete.js";
import { startWebhookWorker } from "./webhookWorker.js";

const env = loadEnv();
setLogger(createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV }));

// Workers boot before `createApp` so the webhook worker's heartbeat
// handle can be passed into the deep `/healthz` route (Phase 14.3). The
// soft-delete sweeper does not need a heartbeat surface in V1; if a
// future deployment wants to surface its tick liveness too, add a
// matching `getLastHeartbeat()` to its handle and thread it through
// `healthz.workers`.
const sweeper = startHardDeleteSweeper(prisma);
const webhookWorker = startWebhookWorker(prisma);

const app = createApp({
  adminToken: env.JUNJO_ADMIN_TOKEN,
  rateLimit: { perMinute: env.RATE_LIMIT_PER_MINUTE, burst: env.RATE_LIMIT_BURST },
  healthz: { worker: webhookWorker },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "junjo-server listening");
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "junjo-server shutting down");
  sweeper.stop();
  // Phase 14.4: drain the in-flight webhook delivery (if any) before
  // closing the HTTP listener. Capped at WEBHOOK_WORKER_DRAIN_MS (30s)
  // so a hung receiver cannot block process exit beyond a typical
  // orchestrator's terminationGracePeriod.
  await webhookWorker.stop();
  server.close();
  await disconnectPrisma();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
