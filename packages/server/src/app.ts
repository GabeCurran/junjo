import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { prisma as defaultPrisma } from "./db.js";
import { type EventHub, eventHub as defaultHub } from "./eventHub.js";
import { adminAuthMiddleware } from "./middleware/adminAuth.js";
import { type ApiKeyStore, apiKeyMiddleware } from "./middleware/apiKey.js";
import { errorHandler } from "./middleware/error.js";
import {
  createAdminApiKeyHandler,
  createAdminGameHandler,
  getAdminGameHandler,
  getAdminStatsHandler,
  listAdminApiKeysHandler,
  listAdminGamesHandler,
  listAdminGroupsForGameHandler,
  listRecentAuditHandler,
  listUserGamesHandler,
  revokeAdminApiKeyHandler,
} from "./routes/admin.js";
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
import { webhooksRouter } from "./routes/webhooks.js";

export interface CreateAppOptions {
  prisma?: PrismaClient;
  apiKeyStore?: ApiKeyStore;
  // Test seam for the SSE route: tests pass a fresh hub plus a tiny
  // heartbeat interval so they can observe heartbeats without sleeping.
  events?: {
    hub?: EventHub;
    heartbeatIntervalMs?: number;
  };
  // Cloud-only admin token (Phase 10.2). Threaded in from `JUNJO_ADMIN_TOKEN`
  // by the server entry point; tests pass a literal value. Routes gated by
  // `adminAuthMiddleware` 401 every request when this is undefined, so a
  // self-host setup that never configured one effectively disables those
  // endpoints.
  adminToken?: string;
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
  // Admin-token-gated cross-game endpoint (Phase 10.2). Registered before
  // the per-game `apiKeyMiddleware` so the per-route admin middleware is
  // the only auth check that runs; the apiKey middleware would otherwise
  // match `*` and reject the request as a missing per-game key.
  v1.get(
    "/users/:junjoUserId/games",
    adminAuthMiddleware(opts.adminToken),
    listUserGamesHandler(prisma),
  );
  // Admin-token-gated cross-game stats + activity feed (Phase 11.2a).
  // Both routes registered BEFORE the per-game `apiKeyMiddleware` so the
  // admin middleware is the only auth check that runs (per the same
  // pattern used by `/v1/users/:junjoUserId/games`).
  v1.get("/admin/stats", adminAuthMiddleware(opts.adminToken), getAdminStatsHandler(prisma));
  v1.get("/admin/audit", adminAuthMiddleware(opts.adminToken), listRecentAuditHandler(prisma));
  // Admin-token-gated games + API key management (Phase 11.3a). Same
  // before-the-apiKey-middleware placement as the other admin routes.
  v1.get("/admin/games", adminAuthMiddleware(opts.adminToken), listAdminGamesHandler(prisma));
  v1.post("/admin/games", adminAuthMiddleware(opts.adminToken), createAdminGameHandler(prisma));
  v1.get("/admin/games/:gameId", adminAuthMiddleware(opts.adminToken), getAdminGameHandler(prisma));
  v1.get(
    "/admin/games/:gameId/api-keys",
    adminAuthMiddleware(opts.adminToken),
    listAdminApiKeysHandler(prisma),
  );
  v1.post(
    "/admin/games/:gameId/api-keys",
    adminAuthMiddleware(opts.adminToken),
    createAdminApiKeyHandler(prisma),
  );
  v1.post(
    "/admin/games/:gameId/api-keys/:keyId/revoke",
    adminAuthMiddleware(opts.adminToken),
    revokeAdminApiKeyHandler(prisma),
  );
  // Admin-token-gated cross-game group browser (Phase 11.4a). Backs the
  // dashboard's per-game groups page (TanStack Table with search, filter,
  // sort, paginate). Same before-the-apiKey-middleware placement.
  v1.get(
    "/admin/games/:gameId/groups",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupsForGameHandler(prisma),
  );
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
  v1.route("/webhooks", webhooksRouter(prisma));
  app.route("/v1", v1);

  return app;
}
