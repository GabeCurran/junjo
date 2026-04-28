import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { disconnectPrisma } from "./db.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const app = createApp();

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`junjo-server listening on http://localhost:${info.port}`);
});

const shutdown = async (signal: string) => {
  console.log(`junjo-server shutting down (${signal})`);
  server.close();
  await disconnectPrisma();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
