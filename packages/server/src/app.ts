import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { prisma as defaultPrisma } from "./db.js";
import { type EventHub, eventHub as defaultHub } from "./eventHub.js";
import { adminAuthMiddleware } from "./middleware/adminAuth.js";
import { type ApiKeyStore, apiKeyMiddleware } from "./middleware/apiKey.js";
import { errorHandler } from "./middleware/error.js";
import { type RateLimiter, buildRateLimiter, rateLimitMiddleware } from "./middleware/rateLimit.js";
import {
  checkAdminPermissionHandler,
  clearAdminGroupRelationshipHandler,
  clearAdminMemberPermissionOverrideHandler,
  createAdminApiKeyHandler,
  createAdminGameHandler,
  createAdminGroupInvitationHandler,
  createAdminGroupRoleHandler,
  deleteAdminRoleHandler,
  getAdminGameHandler,
  getAdminGroupHandler,
  getAdminGroupRelationshipHandler,
  getAdminStatsHandler,
  getGroupChurnHandler,
  getGroupGrowthHandler,
  getMemberActivityHandler,
  getPermissionUsageHandler,
  getRoleDistributionHandler,
  grantAdminRolePermissionHandler,
  kickAdminGroupMemberHandler,
  listAdminApiKeysHandler,
  listAdminGameAuditHandler,
  listAdminGamePermissionsHandler,
  listAdminGamesHandler,
  listAdminGroupAuditHandler,
  listAdminGroupChildrenHandler,
  listAdminGroupMembersHandler,
  listAdminGroupRelationshipsHandler,
  listAdminGroupRolesHandler,
  listAdminGroupsForGameHandler,
  listAdminMemberPermissionOverridesHandler,
  listRecentAuditHandler,
  listUserGamesHandler,
  revokeAdminApiKeyHandler,
  revokeAdminRolePermissionHandler,
  setAdminGroupParentHandler,
  setAdminGroupRelationshipHandler,
  setAdminMemberPermissionOverrideHandler,
  updateAdminGroupMemberHandler,
  updateAdminRoleHandler,
} from "./routes/admin.js";
import { subscribeEventsHandler } from "./routes/events.js";
import { groupsRouter } from "./routes/groups.js";
import { type WorkerHeartbeatProvider, healthCheckHandler } from "./routes/health.js";
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
  events?: {
    hub?: EventHub;
    heartbeatIntervalMs?: number;
  };
  // When undefined, every admin route 401s; a self-host setup with no
  // operator endpoints can leave it unset.
  adminToken?: string;
  // Null or a zero field disables rate limiting; tests can pass a
  // pre-built `RateLimiter` for fixed-clock control.
  rateLimit?: { perMinute?: number; burst?: number } | RateLimiter | null;
  // When `worker` is omitted the worker leg of `/healthz` reports ok
  // (the deployment did not configure a worker to check).
  healthz?: {
    worker?: WorkerHeartbeatProvider;
    workerStaleMs?: number;
    dbTimeoutMs?: number;
  };
}

// One Hono app per call so tests can boot one server per file without
// globals bleeding across cases.
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
  const limiter: RateLimiter | null =
    opts.rateLimit instanceof Object && "consume" in opts.rateLimit
      ? (opts.rateLimit as RateLimiter)
      : buildRateLimiter(opts.rateLimit ?? undefined);

  const app = new Hono();
  app.onError(errorHandler);

  app.get("/", (c) => c.json({ name: "junjo-server", version: "0.0.0" }));
  app.get(
    "/healthz",
    healthCheckHandler(prisma, {
      worker: opts.healthz?.worker,
      workerStaleMs: opts.healthz?.workerStaleMs,
      dbTimeoutMs: opts.healthz?.dbTimeoutMs,
    }),
  );

  const v1 = new Hono();
  // Every public + admin route below MUST register before the per-game
  // `apiKeyMiddleware` further down. Hono runs middleware in registration
  // order, and the wildcard apiKey middleware would otherwise reject these
  // as missing-per-game-key.
  v1.get("/invitations/:code", getInvitationByCodeHandler(prisma));
  v1.get(
    "/users/:junjoUserId/games",
    adminAuthMiddleware(opts.adminToken),
    listUserGamesHandler(prisma),
  );
  v1.get("/admin/stats", adminAuthMiddleware(opts.adminToken), getAdminStatsHandler(prisma));
  v1.get("/admin/audit", adminAuthMiddleware(opts.adminToken), listRecentAuditHandler(prisma));
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
  v1.get(
    "/admin/games/:gameId/groups",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupsForGameHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId",
    adminAuthMiddleware(opts.adminToken),
    getAdminGroupHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId/members",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupMembersHandler(prisma),
  );
  // The mutation handlers below take the event hub so SSE subscribers
  // and webhook endpoints see the same events a per-game-key call would
  // emit (admin and per-game surfaces share one event surface).
  v1.post(
    "/admin/games/:gameId/groups/:groupId/members/:userId/kick",
    adminAuthMiddleware(opts.adminToken),
    kickAdminGroupMemberHandler(prisma, hub),
  );
  v1.patch(
    "/admin/games/:gameId/groups/:groupId/members/:userId",
    adminAuthMiddleware(opts.adminToken),
    updateAdminGroupMemberHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId/members/:userId/permissions",
    adminAuthMiddleware(opts.adminToken),
    listAdminMemberPermissionOverridesHandler(prisma),
  );
  v1.post(
    "/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission",
    adminAuthMiddleware(opts.adminToken),
    setAdminMemberPermissionOverrideHandler(prisma),
  );
  v1.delete(
    "/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission",
    adminAuthMiddleware(opts.adminToken),
    clearAdminMemberPermissionOverrideHandler(prisma),
  );
  v1.post(
    "/admin/games/:gameId/groups/:groupId/invitations",
    adminAuthMiddleware(opts.adminToken),
    createAdminGroupInvitationHandler(prisma, hub),
  );
  // Role PATCH does NOT take the hub: there is no `RoleUpdatedEvent` in
  // the JunjoEvent union; rename / priority / color edits are audit-only.
  v1.get(
    "/admin/games/:gameId/groups/:groupId/roles",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupRolesHandler(prisma),
  );
  v1.post(
    "/admin/games/:gameId/groups/:groupId/roles",
    adminAuthMiddleware(opts.adminToken),
    createAdminGroupRoleHandler(prisma, hub),
  );
  v1.patch(
    "/admin/games/:gameId/roles/:roleId",
    adminAuthMiddleware(opts.adminToken),
    updateAdminRoleHandler(prisma),
  );
  v1.delete(
    "/admin/games/:gameId/roles/:roleId",
    adminAuthMiddleware(opts.adminToken),
    deleteAdminRoleHandler(prisma, hub),
  );
  v1.post(
    "/admin/games/:gameId/roles/:roleId/permissions",
    adminAuthMiddleware(opts.adminToken),
    grantAdminRolePermissionHandler(prisma, hub),
  );
  v1.delete(
    "/admin/games/:gameId/roles/:roleId/permissions/:permission",
    adminAuthMiddleware(opts.adminToken),
    revokeAdminRolePermissionHandler(prisma, hub),
  );
  v1.get(
    "/admin/games/:gameId/permissions",
    adminAuthMiddleware(opts.adminToken),
    listAdminGamePermissionsHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId/audit",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupAuditHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/audit",
    adminAuthMiddleware(opts.adminToken),
    listAdminGameAuditHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/groups/:a/relationships",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupRelationshipsHandler(prisma),
  );
  v1.put(
    "/admin/games/:gameId/groups/:a/relationships/:b",
    adminAuthMiddleware(opts.adminToken),
    setAdminGroupRelationshipHandler(prisma, hub),
  );
  v1.delete(
    "/admin/games/:gameId/groups/:a/relationships/:b",
    adminAuthMiddleware(opts.adminToken),
    clearAdminGroupRelationshipHandler(prisma, hub),
  );
  v1.get(
    "/admin/games/:gameId/groups/:a/relationships/:b",
    adminAuthMiddleware(opts.adminToken),
    getAdminGroupRelationshipHandler(prisma),
  );
  v1.put(
    "/admin/games/:gameId/groups/:groupId/parent",
    adminAuthMiddleware(opts.adminToken),
    setAdminGroupParentHandler(prisma, hub),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId/children",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupChildrenHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/permissions/check",
    adminAuthMiddleware(opts.adminToken),
    checkAdminPermissionHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/analytics/group-churn",
    adminAuthMiddleware(opts.adminToken),
    getGroupChurnHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/analytics/group-growth",
    adminAuthMiddleware(opts.adminToken),
    getGroupGrowthHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/analytics/member-activity",
    adminAuthMiddleware(opts.adminToken),
    getMemberActivityHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/analytics/role-distribution",
    adminAuthMiddleware(opts.adminToken),
    getRoleDistributionHandler(prisma),
  );
  v1.get(
    "/admin/games/:gameId/analytics/permission-usage",
    adminAuthMiddleware(opts.adminToken),
    getPermissionUsageHandler(prisma),
  );
  // Rate limit must run BEFORE the apiKey middleware: it buckets on the
  // raw key prefix (a cheap string parse) so noisy keys are rejected
  // before paying the scrypt verify cost. Hono's wildcard composes onion-
  // style, so this only applies to routes registered after this line; the
  // public + admin routes above are unaffected.
  v1.use("*", rateLimitMiddleware(limiter));
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
