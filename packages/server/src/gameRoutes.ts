import type { PrismaClient } from "@prisma/client";
import type { Handler, Hono } from "hono";
import type { EventHub } from "./eventHub.js";
import { bansRouter, getUserModerationHandler } from "./routes/bans.js";
import { subscribeEventsHandler } from "./routes/events.js";
import { exportHandler } from "./routes/export.js";
import {
  createFriendTagHandler,
  deleteFriendTagHandler,
  listFriendTagsHandler,
  setFriendTagsHandler,
  updateFriendTagHandler,
} from "./routes/friendTags.js";
import {
  acceptFriendRequestHandler,
  addBlockHandler,
  cancelFriendRequestHandler,
  declineFriendRequestHandler,
  getRelationshipHandler,
  listBlocksHandler,
  listFriendRequestsHandler,
  listFriendsHandler,
  removeBlockHandler,
  sendFriendRequestHandler,
  unfriendHandler,
} from "./routes/friends.js";
import { type GameStreamOptions, gameEventsHandlers } from "./routes/gameEvents.js";
import { groupsRouter } from "./routes/groups.js";
import {
  findIdentitiesByNameHandler,
  identityLinkHandlers,
  listLinkedIdentitiesHandler,
  setDisplayNameHandler,
} from "./routes/identities.js";
import {
  acceptInvitationByCodeHandler,
  declineInvitationByCodeHandler,
  deleteInvitationByCodeHandler,
} from "./routes/invitations.js";
import { getMemberByIdHandler, listMembersForUserHandler } from "./routes/members.js";
import {
  checkPermissionBatchHandler,
  checkPermissionHandler,
  getPermissionConfigHandler,
} from "./routes/permissions.js";
import {
  deleteRoleByIdHandler,
  getRoleByIdHandler,
  grantPermissionHandler,
  replaceRoleEntriesHandler,
  revokePermissionHandler,
  setRoleParentsHandler,
  updateRoleByIdHandler,
} from "./routes/roles.js";
import {
  listUserSanctionHistoryHandler,
  listUserSanctionsHandler,
  sanctionsRouter,
} from "./routes/sanctions.js";
import { listFriendSuggestionsHandler } from "./routes/suggestions.js";
import { getUserVisibilityHandler, setUserVisibilityHandler } from "./routes/visibility.js";
import { webhooksRouter } from "./routes/webhooks.js";

export interface GameRouteOptions {
  events?: GameStreamOptions;
  // Clock for link-code expiry and its rate limits.
  identityLinks?: { now?: () => number };
  webhooks?: { allowPrivateHosts?: boolean };
}

// The per-game route set's dependencies. The routers and handler groups
// that keep in-memory state (rate limit budgets, stream slots, shared
// feeds) are built once here, so every mount of the route set shares
// that state instead of each mount holding its own copy.
export interface GameRoutes {
  prisma: PrismaClient;
  hub: EventHub;
  groups: Hono;
  bans: Hono;
  sanctions: Hono;
  webhooks: Hono;
  identityLinks: { issue: Handler; redeem: Handler; unlink: Handler };
  gameEvents: { subscribe: Handler; position: Handler };
  groupEvents: Handler;
}

export function buildGameRoutes(
  prisma: PrismaClient,
  hub: EventHub,
  opts: GameRouteOptions = {},
): GameRoutes {
  return {
    prisma,
    hub,
    groups: groupsRouter(prisma, hub),
    bans: bansRouter(prisma, hub),
    sanctions: sanctionsRouter(prisma, hub),
    webhooks: webhooksRouter(prisma, { allowPrivateHosts: opts.webhooks?.allowPrivateHosts }),
    identityLinks: identityLinkHandlers(prisma, { hub, now: opts.identityLinks?.now }),
    gameEvents: gameEventsHandlers(prisma, { ...opts.events, hub }),
    groupEvents: subscribeEventsHandler(prisma, opts.events),
  };
}

export interface GameRouteMount {
  // Registers the routes that read the authenticating API key itself
  // (`c.var.apiKeyPrefix` or the key row): the game and group event
  // streams, which re-check the key's revocation and hold per-key stream
  // slots; the export, which checks the key's `canExport`; and link-code
  // redeem, which spends a per-key failure budget. A mount whose
  // requests carry no key leaves them out.
  keyBound: boolean;
}

// Registers every per-game route on `router`. The caller mounts the
// authentication that sets `c.var.gameId` (and, for key-bound mounts,
// `c.var.apiKeyPrefix`) ahead of this call. Route order is significant:
// literal segments register before the parameterized paths they overlap.
export function registerGameRoutes(router: Hono, routes: GameRoutes, mount: GameRouteMount): void {
  const { prisma, hub } = routes;
  router.get("/whoami", (c) => c.json({ gameId: c.var.gameId }));
  router.route("/groups", routes.groups);
  router.route("/bans", routes.bans);
  router.route("/sanctions", routes.sanctions);
  if (mount.keyBound) router.get("/export", exportHandler(prisma));
  router.delete("/invitations/:code", deleteInvitationByCodeHandler(prisma));
  router.post("/invitations/:code/accept", acceptInvitationByCodeHandler(prisma, hub));
  router.post("/invitations/:code/decline", declineInvitationByCodeHandler(prisma));
  router.get("/members/:id", getMemberByIdHandler(prisma));
  router.get("/users/:userId/members", listMembersForUserHandler(prisma));
  router.get("/users/:userId/identities", listLinkedIdentitiesHandler(prisma));
  router.get("/users/:userId/moderation", getUserModerationHandler(prisma));
  router.get("/users/:userId/sanctions", listUserSanctionsHandler(prisma));
  router.get("/users/:userId/sanctions/history", listUserSanctionHistoryHandler(prisma));
  router.put("/users/:userId/display-name", setDisplayNameHandler(prisma, hub));
  router.get("/identities/by-name", findIdentitiesByNameHandler(prisma));
  router.post("/users/:userId/link-codes", routes.identityLinks.issue);
  if (mount.keyBound) router.post("/link-codes/redeem", routes.identityLinks.redeem);
  router.post("/users/:userId/unlink", routes.identityLinks.unlink);
  router.get("/roles/:id", getRoleByIdHandler(prisma));
  router.patch("/roles/:id", updateRoleByIdHandler(prisma, hub));
  router.delete("/roles/:id", deleteRoleByIdHandler(prisma, hub));
  router.post("/roles/:id/permissions", grantPermissionHandler(prisma, hub));
  router.delete("/roles/:id/permissions/:permission", revokePermissionHandler(prisma, hub));
  router.put("/roles/:id/entries", replaceRoleEntriesHandler(prisma, hub));
  router.put("/roles/:id/parents", setRoleParentsHandler(prisma, hub));
  router.get("/permissions/check", checkPermissionHandler(prisma));
  router.get("/permissions/config", getPermissionConfigHandler(prisma));
  router.post("/permissions/check-batch", checkPermissionBatchHandler(prisma));
  router.post("/users/:userId/friend-requests", sendFriendRequestHandler(prisma, hub));
  router.get("/users/:userId/friend-requests", listFriendRequestsHandler(prisma));
  router.post("/friend-requests/:id/accept", acceptFriendRequestHandler(prisma, hub));
  router.post("/friend-requests/:id/decline", declineFriendRequestHandler(prisma, hub));
  router.delete("/friend-requests/:id", cancelFriendRequestHandler(prisma, hub));
  router.get("/users/:userId/friends", listFriendsHandler(prisma));
  router.get(
    "/users/:viewerUserId/friends/:otherUserId/relationship",
    getRelationshipHandler(prisma),
  );
  router.delete("/users/:userId/friends/:otherUserId", unfriendHandler(prisma, hub));
  router.post("/users/:userId/blocks", addBlockHandler(prisma, hub));
  router.delete("/users/:userId/blocks/:otherUserId", removeBlockHandler(prisma, hub));
  router.get("/users/:userId/blocks", listBlocksHandler(prisma));
  router.get("/users/:userId/friend-tags", listFriendTagsHandler(prisma));
  router.post("/users/:userId/friend-tags", createFriendTagHandler(prisma));
  router.patch("/friend-tags/:id", updateFriendTagHandler(prisma));
  router.delete("/friend-tags/:id", deleteFriendTagHandler(prisma));
  router.put("/users/:userId/friends/:otherUserId/tags", setFriendTagsHandler(prisma));
  router.get("/users/:userId/visibility", getUserVisibilityHandler(prisma));
  router.patch("/users/:userId/visibility", setUserVisibilityHandler(prisma));
  router.get("/users/:userId/friends/suggestions", listFriendSuggestionsHandler(prisma));
  if (mount.keyBound) router.get("/events", routes.gameEvents.subscribe);
  router.get("/events/position", routes.gameEvents.position);
  if (mount.keyBound) router.get("/events/:groupId", routes.groupEvents);
  router.route("/webhooks", routes.webhooks);
}
