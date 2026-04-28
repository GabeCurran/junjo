import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { disconnectPrisma, prisma } from "./db.js";
import { loadEnv } from "./env.js";
import { startHardDeleteSweeper } from "./softDelete.js";

const env = loadEnv();
const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`junjo-server listening on http://localhost:${info.port}`);
});

const sweeper = startHardDeleteSweeper(prisma);

const shutdown = async (signal: string) => {
  console.log(`junjo-server shutting down (${signal})`);
  sweeper.stop();
  server.close();
  await disconnectPrisma();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
