import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { disconnectPrisma, prisma } from "./db.js";
import { loadEnv } from "./env.js";
import { startHardDeleteSweeper } from "./softDelete.js";
import { startWebhookWorker } from "./webhookWorker.js";

const env = loadEnv();
const app = createApp({
  adminToken: env.JUNJO_ADMIN_TOKEN,
  rateLimit: { perMinute: env.RATE_LIMIT_PER_MINUTE, burst: env.RATE_LIMIT_BURST },
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`junjo-server listening on http://localhost:${info.port}`);
});

const sweeper = startHardDeleteSweeper(prisma);
const webhookWorker = startWebhookWorker(prisma);

const shutdown = async (signal: string) => {
  console.log(`junjo-server shutting down (${signal})`);
  sweeper.stop();
  webhookWorker.stop();
  server.close();
  await disconnectPrisma();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
