import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { prisma as defaultPrisma } from "./db.js";
import { type EventHub, eventHub as defaultHub } from "./eventHub.js";
import { type ApiKeyStore, apiKeyMiddleware } from "./middleware/apiKey.js";
import { errorHandler } from "./middleware/error.js";
import { subscribeEventsHandler } from "./routes/events.js";
import { groupsRouter } from "./routes/groups.js";
import {
  acceptInvitationByCodeHandler,
  declineInvitationByCodeHandler,
  deleteInvitationByCodeHandler,
  getInvitationByCodeHandler,
} from "./routes/invitations.js";
import { getMemberByIdHandler, listMembersForUserHandler } from "./routes/members.js";
import { checkPermissionHandler } from "./routes/permissions.js";
import {
  deleteRoleByIdHandler,
  getRoleByIdHandler,
  grantPermissionHandler,
  revokePermissionHandler,
  updateRoleByIdHandler,
} from "./routes/roles.js";

export interface CreateAppOptions {
  prisma?: PrismaClient;
  apiKeyStore?: ApiKeyStore;
  // Test seam for the SSE route: tests pass a fresh hub plus a tiny
  // heartbeat interval so they can observe heartbeats without sleeping.
  events?: {
    hub?: EventHub;
    heartbeatIntervalMs?: number;
  };
}

// Builds a fresh Hono app per call so tests can boot one server per file
// without globals bleeding across cases. Production wires the real Prisma
// client; tests can substitute a fake.
export function createApp(opts: CreateAppOptions = {}): Hono {
  const prisma = opts.prisma ?? defaultPrisma;
  const hub = opts.events?.hub ?? defaultHub;
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
  // Public route registered before the auth middleware. Hono composes
  // matched handlers in registration order; because this handler returns
  // a Response without calling next(), the apiKey middleware is bypassed
  // even though it would otherwise match `*`. Anyone with the code can
  // fetch the invitation preview the dev's frontend renders.
  v1.get("/invitations/:code", getInvitationByCodeHandler(prisma));
  v1.use("*", apiKeyMiddleware(store));
  v1.get("/whoami", (c) => c.json({ gameId: c.var.gameId }));
  v1.route("/groups", groupsRouter(prisma, hub));
  v1.delete("/invitations/:code", deleteInvitationByCodeHandler(prisma));
  v1.post("/invitations/:code/accept", acceptInvitationByCodeHandler(prisma, hub));
  v1.post("/invitations/:code/decline", declineInvitationByCodeHandler(prisma));
  v1.get("/members/:id", getMemberByIdHandler(prisma));
  v1.get("/users/:userId/members", listMembersForUserHandler(prisma));
  v1.get("/roles/:id", getRoleByIdHandler(prisma));
  v1.patch("/roles/:id", updateRoleByIdHandler(prisma));
  v1.delete("/roles/:id", deleteRoleByIdHandler(prisma, hub));
  v1.post("/roles/:id/permissions", grantPermissionHandler(prisma, hub));
  v1.delete("/roles/:id/permissions/:permission", revokePermissionHandler(prisma, hub));
  v1.get("/permissions/check", checkPermissionHandler(prisma));
  v1.get("/events/:groupId", subscribeEventsHandler(prisma, opts.events));
  app.route("/v1", v1);

  return app;
}
