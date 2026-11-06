import type { PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { withAuditAttribution } from "./auditAttribution.js";
import { prisma as defaultPrisma } from "./db.js";
import { eventHub as defaultHub } from "./eventHub.js";
import { withEventLog } from "./eventLog.js";
import { buildGameRoutes, registerGameRoutes } from "./gameRoutes.js";
import { idempotencyMiddleware } from "./idempotency.js";
import { adminAsGameMiddleware } from "./middleware/adminAsGame.js";
import { adminAuthMiddleware } from "./middleware/adminAuth.js";
import { type ApiKeyStore, apiKeyMiddleware } from "./middleware/apiKey.js";
import { errorHandler } from "./middleware/error.js";
import { type RateLimiter, buildRateLimiter, rateLimitMiddleware } from "./middleware/rateLimit.js";
import { requestIdMiddleware } from "./middleware/requestId.js";
import { newRequestContext, runWithRequestContext } from "./requestContext.js";
import { getAdminGameConfigHandler, updateAdminGameConfigHandler } from "./routes/admin.config.js";
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
  getAdminGroupRoleGraphHandler,
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
  replaceAdminRoleEntriesHandler,
  revokeAdminApiKeyHandler,
  revokeAdminRolePermissionHandler,
  setAdminGroupParentHandler,
  setAdminGroupRelationshipHandler,
  setAdminMemberPermissionOverrideHandler,
  setAdminRoleParentsHandler,
  updateAdminApiKeyHandler,
  updateAdminGroupHandler,
  updateAdminGroupMemberHandler,
  updateAdminRoleHandler,
} from "./routes/admin.js";
import type { GameStreamOptions } from "./routes/gameEvents.js";
import { type WorkerHeartbeatProvider, healthCheckHandler } from "./routes/health.js";
import { getInvitationByCodeHandler } from "./routes/invitations.js";

export interface CreateAppOptions {
  prisma?: PrismaClient;
  apiKeyStore?: ApiKeyStore;
  events?: GameStreamOptions;
  // When undefined, every admin route 401s; a self-host setup with no
  // operator endpoints can leave it unset.
  adminToken?: string;
  // Null or a zero field disables rate limiting; tests can pass a
  // pre-built `RateLimiter` for fixed-clock control.
  rateLimit?: { perMinute?: number; burst?: number } | RateLimiter | null;
  // See TRUST_PROXY in env.ts. Controls which source address the rate
  // limiter trusts for keyless traffic.
  trustProxy?: boolean;
  // When `worker` is omitted the worker leg of `/healthz` reports ok
  // (the deployment did not configure a worker to check).
  healthz?: {
    worker?: WorkerHeartbeatProvider;
    workerStaleMs?: number;
    dbTimeoutMs?: number;
  };
  // Clock for link-code expiry and its rate limits; tests freeze it.
  identityLinks?: { now?: () => number };
  // Clock for Idempotency-Key record ages; tests freeze it.
  idempotency?: { now?: () => number };
  webhooks?: {
    // Production cloud must leave this false. Self-host development sets it
    // when receivers run on the same machine; index.ts derives it from the
    // WEBHOOK_ALLOW_PRIVATE_HOSTS env var.
    allowPrivateHosts?: boolean;
  };
}

// One Hono app per call so tests can boot one server per file without
// globals bleeding across cases.
export function createApp(opts: CreateAppOptions = {}): Hono {
  // Every audit row written through this app records the acting key, and
  // every transaction writes the events it staged to the event log as
  // its last statement.
  const prisma = withEventLog(withAuditAttribution(opts.prisma ?? defaultPrisma));
  const hub = opts.events?.hub ?? defaultHub;
  const store: ApiKeyStore = opts.apiKeyStore ?? {
    findByPrefix: async (prefix) =>
      prisma.apiKey
        .findUnique({
          where: { prefix },
          select: {
            id: true,
            gameId: true,
            hashedSecret: true,
            revokedAt: true,
            preferredNamespaces: true,
            game: { select: { config: true } },
          },
        })
        .then((row) => (row ? { ...row, gameConfig: row.game.config } : null)),
  };
  const limiter: RateLimiter | null =
    opts.rateLimit instanceof Object && "consume" in opts.rateLimit
      ? (opts.rateLimit as RateLimiter)
      : buildRateLimiter(opts.rateLimit ?? undefined);

  // Built once so both mounts below share the per-game handlers' state.
  const gameRoutes = buildGameRoutes(prisma, hub, {
    events: opts.events,
    identityLinks: opts.identityLinks,
    webhooks: opts.webhooks,
  });

  const app = new Hono();
  app.use("*", requestIdMiddleware());
  // Opens the per-request context the identity, rendering and audit
  // helpers read; the API key middleware fills in the key's part.
  app.use("*", (_c, next) => runWithRequestContext(newRequestContext(), next));
  app.onError(errorHandler);

  // Same response as the framework default; the flag tells the
  // idempotency middleware that no handler ran.
  app.notFound((c) => {
    c.set("routeUnmatched", true);
    return c.text("404 Not Found", 404);
  });

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
  // Rate limit covers the ENTIRE /v1 surface, including the
  // unauthenticated invitation preview and the admin-token routes:
  // per-game keys bucket on their prefix (a cheap string parse, so
  // noisy keys are rejected before paying the scrypt verify cost);
  // everything else buckets per source IP. Registered first because
  // Hono's wildcard composes onion-style over routes registered after
  // it.
  v1.use("*", rateLimitMiddleware(limiter, { trustProxy: opts.trustProxy }));
  // Request-body-size cap across the whole /v1 surface. Normal API bodies
  // are tiny (a handful of JSON fields), so 1 MB is already generous. The
  // largest legitimate body is bulk-invite at its row cap: 1000 rows x the
  // 255-char userId ceiling is ~256 KB, comfortably under 1 MB, so a
  // single global cap covers every route and no route needs its own
  // higher limit. Hono's bodyLimit returns 413 when exceeded.
  v1.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
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
    "/admin/games/:gameId/config",
    adminAuthMiddleware(opts.adminToken),
    getAdminGameConfigHandler(prisma),
  );
  v1.patch(
    "/admin/games/:gameId/config",
    adminAuthMiddleware(opts.adminToken),
    updateAdminGameConfigHandler(prisma),
  );
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
  v1.patch(
    "/admin/games/:gameId/api-keys/:keyId",
    adminAuthMiddleware(opts.adminToken),
    updateAdminApiKeyHandler(prisma),
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
  v1.patch(
    "/admin/games/:gameId/groups/:groupId",
    adminAuthMiddleware(opts.adminToken),
    updateAdminGroupHandler(prisma, hub),
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
    updateAdminGroupMemberHandler(prisma, hub),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId/members/:userId/permissions",
    adminAuthMiddleware(opts.adminToken),
    listAdminMemberPermissionOverridesHandler(prisma),
  );
  v1.post(
    "/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission",
    adminAuthMiddleware(opts.adminToken),
    setAdminMemberPermissionOverrideHandler(prisma, hub),
  );
  v1.delete(
    "/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission",
    adminAuthMiddleware(opts.adminToken),
    clearAdminMemberPermissionOverrideHandler(prisma, hub),
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
    updateAdminRoleHandler(prisma, hub),
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
  v1.put(
    "/admin/games/:gameId/roles/:roleId/entries",
    adminAuthMiddleware(opts.adminToken),
    replaceAdminRoleEntriesHandler(prisma, hub),
  );
  v1.put(
    "/admin/games/:gameId/roles/:roleId/parents",
    adminAuthMiddleware(opts.adminToken),
    setAdminRoleParentsHandler(prisma, hub),
  );
  v1.get(
    "/admin/games/:gameId/groups/:groupId/role-graph",
    adminAuthMiddleware(opts.adminToken),
    getAdminGroupRoleGraphHandler(prisma),
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
  // Every per-game route for any game, authenticated by the admin token
  // instead of a key for that game. The admin token already reads and
  // writes every game through the routes above, so this grants nothing
  // new. Registered before the per-game `apiKeyMiddleware` for the same
  // reason as the admin routes.
  const asGame = new Hono();
  asGame.use("*", adminAuthMiddleware(opts.adminToken));
  asGame.use("*", adminAsGameMiddleware(prisma));
  // Requests here carry no API key, so the idempotency middleware only
  // validates an Idempotency-Key header and then runs the request without
  // claiming or replaying a record: a retried write runs again.
  asGame.use("*", idempotencyMiddleware(prisma, { now: opts.idempotency?.now }));
  registerGameRoutes(asGame, gameRoutes, { keyBound: false });
  // Ends the chain for unmatched paths, including the key-bound routes
  // this mount leaves out, so they answer 404 instead of reaching the
  // per-game key check registered later on `v1`.
  asGame.all("*", (c) => c.notFound());
  v1.route("/admin/games/:gameId/as-game", asGame);
  v1.use("*", apiKeyMiddleware(store));
  // Per-key Idempotency-Key handling for every mutating route below.
  v1.use("*", idempotencyMiddleware(prisma, { now: opts.idempotency?.now }));
  registerGameRoutes(v1, gameRoutes, { keyBound: true });
  app.route("/v1", v1);

  return app;
}
