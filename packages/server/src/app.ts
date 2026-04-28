import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { prisma as defaultPrisma } from "./db.js";
import { type ApiKeyStore, apiKeyMiddleware } from "./middleware/apiKey.js";
import { errorHandler } from "./middleware/error.js";

export interface CreateAppOptions {
  prisma?: PrismaClient;
  apiKeyStore?: ApiKeyStore;
}

// Builds a fresh Hono app per call so tests can boot one server per file
// without globals bleeding across cases. Production wires the real Prisma
// client; tests can substitute a fake.
export function createApp(opts: CreateAppOptions = {}): Hono {
  const prisma = opts.prisma ?? defaultPrisma;
  const store: ApiKeyStore = opts.apiKeyStore ?? {
    findByPrefix: async (prefix) =>
      prisma.apiKey.findUnique({
        where: { prefix },
        select: { gameId: true, hashedSecret: true, revokedAt: true },
      }),
  };

  const app = new Hono();
  app.onError(errorHandler);

  app.get("/", (c) => c.json({ name: "junjo-server", version: "0.0.0" }));
  app.get("/healthz", (c) => c.text("ok"));

  const v1 = new Hono();
  v1.use("*", apiKeyMiddleware(store));
  v1.get("/whoami", (c) => c.json({ gameId: c.var.gameId }));
  app.route("/v1", v1);

  return app;
}
