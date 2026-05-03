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
  // Per-API-key rate limit (Phase 14.1). Threaded in from
  // `RATE_LIMIT_PER_MINUTE` + `RATE_LIMIT_BURST` by the server entry point;
  // tests pass literal values or `null` to disable. When either field is
  // zero or the whole option is null, rate limiting is disabled and
  // requests pass through with no bucket bookkeeping. Tests can also pass
  // a pre-built `RateLimiter` instance for fixed-clock control.
  rateLimit?: { perMinute?: number; burst?: number } | RateLimiter | null;
  // Phase 14.3: deep `/healthz` consults the webhook worker's last-tick
  // heartbeat alongside the DB ping. Production wires the worker handle
  // returned from `startWebhookWorker` (`WorkerHandle.getLastHeartbeat`
  // satisfies `WorkerHeartbeatProvider`); tests pass a stub. When the
  // option is omitted, the worker leg of `/healthz` reports trivially ok
  // (the deployment did not configure a worker to check).
  healthz?: {
    worker?: WorkerHeartbeatProvider;
    workerStaleMs?: number;
    dbTimeoutMs?: number;
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
  const limiter: RateLimiter | null =
    opts.rateLimit instanceof Object && "consume" in opts.rateLimit
      ? (opts.rateLimit as RateLimiter)
      : buildRateLimiter(opts.rateLimit ?? undefined);

  const app = new Hono();
  app.onError(errorHandler);

  app.get("/", (c) => c.json({ name: "junjo-server", version: "0.0.0" }));
  // Real `/healthz` (Phase 14.3): pings the DB and reads the worker
  // heartbeat. Returns 200 when both pass, 503 with per-component
  // `reason` strings otherwise. The cheap liveness probe stays at `/`.
  app.get(
    "/healthz",
    healthCheckHandler(prisma, {
      worker: opts.healthz?.worker,
      workerStaleMs: opts.healthz?.workerStaleMs,
      dbTimeoutMs: opts.healthz?.dbTimeoutMs,
    }),
  );

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
  // Admin-token-gated single-group detail + member listing (Phase 11.5a).
  // Backs the dashboard's group detail page (members tab as the default).
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
  // Admin-token-gated member row actions (Phase 11.5c-i). Back the
  // dashboard's MembersTable row action dialogs (kick / edit notes /
  // override permission / view all overrides). The kick handler takes
  // the event hub so SSE subscribers and webhook endpoints see the same
  // `member.left` event a per-game-key kick would emit.
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
  // Admin-token-gated invitation creation (Phase 11.5d-i). Backs the
  // dashboard's MembersTable invite-member dialog (three tabs:
  // by-userId / by-code / by-link). Takes the event hub so SSE
  // subscribers and webhook endpoints see the same `member.invited`
  // event a per-game-key invite would emit.
  v1.post(
    "/admin/games/:gameId/groups/:groupId/invitations",
    adminAuthMiddleware(opts.adminToken),
    createAdminGroupInvitationHandler(prisma, hub),
  );
  // Admin-token-gated roles CRUD (Phase 11.6a-i). Backs the dashboard's
  // group detail Roles tab. Group-scoped list + create live under the
  // group prefix; by-id update + delete live under `/admin/games/:gameId/roles/:roleId`
  // (mirroring the per-game `/v1/groups/:id/roles` + `/v1/roles/:id`
  // split). Create + delete take the event hub so SSE subscribers and
  // webhook endpoints see the same `role.created` / `role.deleted`
  // events a per-game-key call would emit; PATCH does NOT dispatch
  // because there is no `RoleUpdatedEvent` in the JunjoEvent union.
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
  // Admin-token-gated role-permission grant + revoke (Phase 11.6a-ii).
  // Mirrors the per-game `POST/DELETE /v1/roles/:id/permissions` semantics
  // exactly: idempotent on already-granted / already-revoked, auto-registers
  // `PermissionDef` rows on first sight (grant), preserves them on revoke,
  // dispatches `permission.granted` / `permission.revoked` events, and
  // invalidates the per-group permission cache. Backs the dashboard's
  // group detail Permissions matrix tab (Phase 11.6c).
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
  // Admin-token-gated per-game permission catalog (Phase 11.6a-ii).
  // Lists every `PermissionDef` row registered for the game; backs the
  // matrix tab's column list. Bare `WireAdminPermissionDef[]` (no
  // pagination); sorted by `key` asc.
  v1.get(
    "/admin/games/:gameId/permissions",
    adminAuthMiddleware(opts.adminToken),
    listAdminGamePermissionsHandler(prisma),
  );
  // Admin-token-gated per-group audit feed (Phase 11.7a-i). Mirrors the
  // per-game `GET /v1/groups/:id/audit` (iter 028) byte-for-byte: same
  // `listAuditQuery` schema, same timestamp-based pagination, same
  // `Page<WireAuditEntry>` response shape. Backs the dashboard's group
  // detail Audit tab (Phase 11.7a-ii). 404-collapses missing /
  // cross-game / soft-deleted groups.
  v1.get(
    "/admin/games/:gameId/groups/:groupId/audit",
    adminAuthMiddleware(opts.adminToken),
    listAdminGroupAuditHandler(prisma),
  );
  // Admin-token-gated per-game audit feed (Phase 11.8a). Cross-group
  // (every group in the game, including soft-deleted ones), with
  // filters for `actions[]`, `actorUserId`, `targetId`, and a
  // `since`/`before` date range. Timestamp-based pagination via
  // `nextCursor`. Backs the dashboard's game-wide audit log viewer
  // (Phase 11.8b). 404 only on missing gameId; soft-deleted groups
  // are intentionally included since the audit log preserves history
  // regardless of group lifecycle.
  v1.get(
    "/admin/games/:gameId/audit",
    adminAuthMiddleware(opts.adminToken),
    listAdminGameAuditHandler(prisma),
  );
  // Admin-token-gated per-group relationships (Phase 11.7b-i). Mirrors
  // the per-game `PUT/DELETE/GET /v1/groups/:a/relationships/:b` and
  // `GET /v1/groups/:a/relationships` semantics byte-for-byte (same
  // body / query shapes, same idempotence rules, same audit shapes,
  // same `group.relationship.changed` JunjoEvent dispatch). Backs the
  // dashboard's group detail Relationships tab (Phase 11.7b-ii). The
  // set + clear handlers take the event hub so SSE subscribers and
  // webhook endpoints see the same events a per-game-key call would
  // emit; the get + list handlers are read-only.
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
  // Admin-token-gated per-group sub-group hierarchy (Phase 11.7c-i).
  // Mirrors the per-game `PUT /v1/groups/:id/parent` and
  // `GET /v1/groups/:id/children` semantics byte-for-byte (same body
  // shape, same idempotence rules, same audit shape, same cycle
  // detection bounded at `ADMIN_MAX_PARENT_DEPTH`). Backs the
  // dashboard's group detail Sub-groups tab (Phase 11.7c-ii). The set
  // handler takes the event hub so SSE subscribers and webhook
  // endpoints see the same `group.updated` event a per-game-key call
  // would emit; the children list is read-only.
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
  // Admin-token-gated cross-game permission check (Phase 11.9a-i).
  // Mirrors the per-game `GET /v1/permissions/check` byte-for-byte (same
  // query shape, same `PermissionCheckResult` wire format, same in-process
  // cache via the `permissionCache` singleton). Backs the dashboard's
  // permission check tester (Phase 11.9a-ii).
  v1.get(
    "/admin/games/:gameId/permissions/check",
    adminAuthMiddleware(opts.adminToken),
    checkAdminPermissionHandler(prisma),
  );
  // Admin-token-gated cross-game group-churn analytics (Phase 12.2a). Backs
  // the dashboard's group churn chart (Phase 12.2b). Returns the binned
  // tenure histogram of departures (kicked + left members) across every
  // group created in the supplied date window.
  v1.get(
    "/admin/games/:gameId/analytics/group-churn",
    adminAuthMiddleware(opts.adminToken),
    getGroupChurnHandler(prisma),
  );
  // Admin-token-gated cross-game group-growth analytics (Phase 12.3a). Backs
  // the dashboard's group growth chart (Phase 12.3b). Returns time-bucketed
  // cumulative active member counts across the supplied window for the
  // top-N groups (default 5) plus an "All others" aggregated series.
  v1.get(
    "/admin/games/:gameId/analytics/group-growth",
    adminAuthMiddleware(opts.adminToken),
    getGroupGrowthHandler(prisma),
  );
  // Admin-token-gated cross-game member-activity heatmap (Phase 12.4a). Backs
  // the dashboard's member activity heatmap (Phase 12.4b). Returns a 7x24
  // grid of audit-entry counts pivoted by UTC day-of-week and hour-of-day
  // across every group in the game (cross-group fan-in; soft-deleted-group
  // entries included since the audit log preserves history).
  v1.get(
    "/admin/games/:gameId/analytics/member-activity",
    adminAuthMiddleware(opts.adminToken),
    getMemberActivityHandler(prisma),
  );
  // Admin-token-gated cross-game role distribution snapshot (Phase 12.5a).
  // Backs the dashboard's role distribution donut chart (Phase 12.5b).
  // Returns a top-10 list of role names ranked by active-member assignment
  // count, aggregated across every non-soft-deleted group in the game.
  v1.get(
    "/admin/games/:gameId/analytics/role-distribution",
    adminAuthMiddleware(opts.adminToken),
    getRoleDistributionHandler(prisma),
  );
  // Admin-token-gated cross-game permission usage snapshot (Phase 12.5a).
  // Backs the dashboard's permission usage horizontal bar chart (Phase
  // 12.5b). Returns a top-15 list of permission keys ranked by combined
  // RolePermission + MemberPermissionOverride row count.
  v1.get(
    "/admin/games/:gameId/analytics/permission-usage",
    adminAuthMiddleware(opts.adminToken),
    getPermissionUsageHandler(prisma),
  );
  // Per-API-key rate limit (Phase 14.1). Mounted just BEFORE
  // `apiKeyMiddleware` so it applies to every per-game route registered
  // afterward but NOT to the public / admin routes registered above (they
  // already returned a Response before this middleware runs in Hono's
  // onion). The bucket key is the API key prefix (cheap parse from the
  // Authorization header; no scrypt verify required), so rate limiting
  // happens before any DB work and protects the per-game routes from a
  // single noisy key. Disabled when `limiter` is null.
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
