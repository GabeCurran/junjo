import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { setMaxPageSize } from "./config/runtime.js";
import { disconnectPrisma, prisma } from "./db.js";
import { loadEnv } from "./env.js";
import { createLogger, logger, setLogger } from "./logger.js";
import { startHardDeleteSweeper } from "./softDelete.js";
import { startWebhookWorker } from "./webhookWorker.js";

const env = loadEnv();
setLogger(createLogger({ level: env.LOG_LEVEL, nodeEnv: env.NODE_ENV }));
setMaxPageSize(env.JUNJO_MAX_PAGE_SIZE);

// Workers must boot before `createApp` so the webhook worker's heartbeat
// handle can be threaded into `/healthz`.
const sweeper = startHardDeleteSweeper(prisma);
const webhookWorker = startWebhookWorker(prisma);

const app = createApp({
  adminToken: env.JUNJO_ADMIN_TOKEN,
  rateLimit: { perMinute: env.RATE_LIMIT_PER_MINUTE, burst: env.RATE_LIMIT_BURST },
  healthz: { worker: webhookWorker },
  webhooks: { allowPrivateHosts: env.WEBHOOK_ALLOW_PRIVATE_HOSTS },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  logger.info({ port: info.port }, "junjo-server listening");
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, "junjo-server shutting down");
  sweeper.stop();
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
