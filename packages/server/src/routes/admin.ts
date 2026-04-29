// @cloud-only
//
// Cross-tenant admin endpoints (Phase 10.2 + 11.2a). All routes here are gated
// by the admin token (separate auth scheme from per-game API keys), so they
// live outside the per-game `apiKeyMiddleware` chain. Mirror SDK is
// intentionally NOT shipped in V1 per VISION; the dashboard calls these
// endpoints directly via fetch.

import type { GameId, GroupId, MemberLeftEvent, UserId } from "@junjo/shared";
import type {
  ApiKey,
  AuditEntry,
  Game,
  Group,
  GroupMember,
  MemberPermissionOverride,
  Prisma,
  PrismaClient,
  Role,
} from "@prisma/client";
import type { Handler } from "hono";
import { generateApiKey } from "../apiKey.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { dispatchEvent } from "../events.js";
import { findJunjoUserId } from "../identity.js";
import { permissionCache } from "../permissionCache.js";
import {
  ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS,
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  adminKickMemberBody,
  adminOverridePermissionBody,
  adminUpdateMemberBody,
  createGameBody,
  listAdminGamesQuery,
  listAdminGroupMembersQuery,
  listAdminGroupsQuery,
  listRecentAuditQuery,
} from "./admin.schema.js";

export interface WireUserGameRow {
  gameId: string;
  externalUserId: string;
  joinedGroupCount: number;
}

export interface WireUserGames {
  junjoUserId: string;
  games: WireUserGameRow[];
}

// `GET /v1/users/:junjoUserId/games`. The `junjoUserId` path parameter is the
// internal cross-game id (a `JunjoUser.id`), not a dev-supplied external user
// id; the dashboard knows this id because it queried Postgres directly or
// observed it on a webhook payload.
//
// Response shape:
//
//   {
//     junjoUserId: "...",
//     games: [
//       { gameId, externalUserId, joinedGroupCount },
//       ...
//     ]
//   }
//
// Behavior:
//
//   - A `junjoUserId` with no `ExternalIdentity` rows returns 200 with
//     `games: []`. The route does not 404 because the user might exist but
//     have no cross-game footprint (newly-created JunjoUser whose first
//     ExternalIdentity is still pending), and "no games" is the same answer
//     for the consumer either way.
//
//   - `joinedGroupCount` is the count of `GroupMember` rows in `status:
//     "active"` whose group belongs to the listed game and is not
//     soft-deleted. Matches the `Group.memberCount` precedent (and the
//     permission resolver's "non-active = effectively not a member" rule).
//
//   - Games are sorted by `gameId` ascending for deterministic output;
//     pagination is intentionally absent (a single Junjo user across more
//     than a few hundred games is not a V1 concern).
export function listUserGamesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const junjoUserId = c.req.param("junjoUserId");
    // Hono's path-parameter typing widens to `string | undefined`; the
    // matched route guarantees a non-empty value at runtime, but the
    // type system needs a defensive narrow.
    if (!junjoUserId) throw Errors.badRequest("junjoUserId is required");

    const identities = await prisma.externalIdentity.findMany({
      where: { junjoUserId },
      select: { gameId: true, externalUserId: true },
      orderBy: { gameId: "asc" },
    });

    if (identities.length === 0) {
      return c.json<WireUserGames>({ junjoUserId, games: [] });
    }

    // Single batched query for active memberships across every game the
    // user has an identity in; the in-memory tally below avoids N+1 counts.
    const memberRows = await prisma.groupMember.findMany({
      where: {
        junjoUserId,
        status: "active",
        group: { softDeletedAt: null },
      },
      select: { group: { select: { gameId: true } } },
    });

    const counts = new Map<string, number>();
    for (const row of memberRows) {
      const id = row.group.gameId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const games: WireUserGameRow[] = identities.map((identity) => ({
      gameId: identity.gameId,
      externalUserId: identity.externalUserId,
      joinedGroupCount: counts.get(identity.gameId) ?? 0,
    }));

    return c.json<WireUserGames>({ junjoUserId, games });
  };
}

// =====================================================================
// Phase 11.2a: dashboard home aggregate stats + recent audit feed
// =====================================================================

export interface WireAdminStats {
  totalGames: number;
  totalGroups: number;
  totalActiveMembers: number;
  totalAuditEntriesLast24h: number;
}

const STATS_AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// `GET /v1/admin/stats` returns aggregate counts for the dashboard home
// overview cards. Four parallel `count` queries; the result is cheap to
// recompute and the dashboard caches it for 60s via Next.js `revalidate`.
//
// Counting rules:
//
//   - `totalGames`: every row in `Game` (no soft-delete column on `Game`).
//   - `totalGroups`: groups not soft-deleted. Soft-deleted-but-undeleted-
//     soon groups are excluded; the dashboard's "active groups" mental
//     model wins over including the 7-day pending-deletion window.
//   - `totalActiveMembers`: `status: "active"` members in non-soft-deleted
//     groups. Matches the `Group.memberCount` precedent and the permission
//     resolver's "non-active = effectively not a member" rule.
//   - `totalAuditEntriesLast24h`: every audit row whose `createdAt` falls
//     in `[now() - 24h, now()]`, regardless of group soft-delete state.
//     Soft-deleted-group entries are still part of the audit history, and
//     the dashboard's "events in last 24h" card reflects activity volume,
//     not surviving-group volume.
export function getAdminStatsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const since = new Date(Date.now() - STATS_AUDIT_WINDOW_MS);
    const [totalGames, totalGroups, totalActiveMembers, totalAuditEntriesLast24h] =
      await Promise.all([
        prisma.game.count(),
        prisma.group.count({ where: { softDeletedAt: null } }),
        prisma.groupMember.count({
          where: { status: "active", group: { softDeletedAt: null } },
        }),
        prisma.auditEntry.count({ where: { createdAt: { gte: since } } }),
      ]);
    return c.json<WireAdminStats>({
      totalGames,
      totalGroups,
      totalActiveMembers,
      totalAuditEntriesLast24h,
    });
  };
}

export interface WireAdminAuditEntry {
  id: string;
  action: string;
  gameId: string;
  gameName: string;
  groupId: string;
  groupName: string;
  groupSoftDeleted: boolean;
  actorUserId: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WireAdminAuditPage {
  items: WireAdminAuditEntry[];
}

// Prisma row shape we ask for via `include`. Defining it explicitly lets the
// serializer take a typed parameter rather than a structural subset, and
// keeps the call site in `listRecentAuditHandler` honest about which fields
// it requested.
type AdminAuditRow = AuditEntry & {
  group: Pick<Group, "name" | "gameId" | "softDeletedAt"> & {
    game: Pick<Game, "name">;
  };
};

export function serializeAdminAuditEntry(row: AdminAuditRow): WireAdminAuditEntry {
  return {
    id: row.id,
    action: row.action,
    gameId: row.group.gameId,
    gameName: row.group.game.name,
    groupId: row.groupId,
    groupName: row.group.name,
    groupSoftDeleted: row.group.softDeletedAt !== null,
    actorUserId: row.actorUserId,
    targetId: row.targetId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

// `GET /v1/admin/audit?limit=20` returns the most recent audit entries
// across every game on the deployment, with the parent group's name and
// the parent game's name pivoted into each item so the dashboard's
// activity-feed card can render `<game> / <group>` headings without an
// N+1 lookup.
//
// Behavior:
//
//   - Sorted by `(createdAt desc, id desc)`. The `id` tiebreaker keeps
//     ordering stable when two rows share the same millisecond timestamp.
//   - Soft-deleted-group entries are included; the audit log preserves
//     history regardless of the group's lifecycle state. `groupSoftDeleted`
//     on each item lets the dashboard mark the row visually.
//   - No pagination: the home page only renders 20-100 items. A future
//     game-wide audit page (Phase 11.8) will own paginated cross-game
//     audit; this endpoint stays terse on purpose.
//   - `limit` defaults to 20 and is capped at 100.
export function listRecentAuditHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const parsed = listRecentAuditQuery.safeParse({
      limit: c.req.query("limit"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit } = parsed.data;

    const rows = await prisma.auditEntry.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      include: {
        group: {
          select: {
            name: true,
            gameId: true,
            softDeletedAt: true,
            game: { select: { name: true } },
          },
        },
      },
    });

    return c.json<WireAdminAuditPage>({
      items: rows.map(serializeAdminAuditEntry),
    });
  };
}

// =====================================================================
// Phase 11.3a: cross-game games + API key management
// =====================================================================

export interface WireAdminGame {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  groupCount: number;
  activeMemberCount: number;
  apiKeyCount: number;
}

export interface WireAdminGameList {
  items: WireAdminGame[];
}

export interface WireAdminApiKey {
  id: string;
  gameId: string;
  prefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface WireAdminApiKeyList {
  items: WireAdminApiKey[];
}

// The dev-facing key string `prefix.secret` is included only on the create
// response. Subsequent `GET /v1/admin/games/:gameId/api-keys` calls return
// `WireAdminApiKey` (no key, no secret) - the secret is stored only as a
// scrypt hash and cannot be recovered. Mirrors the webhook endpoint
// `secret`-on-create-only convention from Phase 5.5.
export interface WireAdminApiKeyCreated extends WireAdminApiKey {
  key: string;
}

function toWireGame(
  row: Game,
  stats: { groupCount: number; activeMemberCount: number; apiKeyCount: number },
): WireAdminGame {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    groupCount: stats.groupCount,
    activeMemberCount: stats.activeMemberCount,
    apiKeyCount: stats.apiKeyCount,
  };
}

function toWireApiKey(row: ApiKey): WireAdminApiKey {
  return {
    id: row.id,
    gameId: row.gameId,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
  };
}

// `GET /v1/admin/games?limit=100` returns every game with batched stats per
// game (group / active member / non-revoked API key counts).
//
// Behavior:
//
//   - Sorted by `(createdAt desc, id desc)`. Newest games first matches the
//     dashboard's games list page; the id tiebreaker keeps ordering stable
//     across same-millisecond rows.
//   - `groupCount` and `activeMemberCount` exclude soft-deleted groups
//     (mirrors `WireAdminStats`: active-set semantics).
//   - `apiKeyCount` excludes revoked keys (the dashboard cares about
//     "currently usable keys", not lifetime issuance).
//   - No pagination cursor; capped at 200 rows, default 100. Additive
//     pagination is fine if a deployment grows past that.
//
// Implementation note: stats per game are computed via three batched
// queries (one Prisma `groupBy` for groups, one `findMany` over members
// joined to their group, one `groupBy` for API keys), tallied in memory.
// Avoids 3*N round-trips for N games.
export function listAdminGamesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const parsed = listAdminGamesQuery.safeParse({ limit: c.req.query("limit") });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit } = parsed.data;

    const games = await prisma.game.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    if (games.length === 0) {
      return c.json<WireAdminGameList>({ items: [] });
    }

    const gameIds = games.map((g) => g.id);

    const [groupRows, memberRows, apiKeyRows] = await Promise.all([
      prisma.group.groupBy({
        by: ["gameId"],
        where: { gameId: { in: gameIds }, softDeletedAt: null },
        _count: { _all: true },
      }),
      prisma.groupMember.findMany({
        where: {
          status: "active",
          group: { gameId: { in: gameIds }, softDeletedAt: null },
        },
        select: { group: { select: { gameId: true } } },
      }),
      prisma.apiKey.groupBy({
        by: ["gameId"],
        where: { gameId: { in: gameIds }, revokedAt: null },
        _count: { _all: true },
      }),
    ]);

    const groupCounts = new Map<string, number>();
    for (const row of groupRows) groupCounts.set(row.gameId, row._count._all);

    const apiKeyCounts = new Map<string, number>();
    for (const row of apiKeyRows) apiKeyCounts.set(row.gameId, row._count._all);

    const memberCounts = new Map<string, number>();
    for (const row of memberRows) {
      const id = row.group.gameId;
      memberCounts.set(id, (memberCounts.get(id) ?? 0) + 1);
    }

    return c.json<WireAdminGameList>({
      items: games.map((g) =>
        toWireGame(g, {
          groupCount: groupCounts.get(g.id) ?? 0,
          activeMemberCount: memberCounts.get(g.id) ?? 0,
          apiKeyCount: apiKeyCounts.get(g.id) ?? 0,
        }),
      ),
    });
  };
}

// `POST /v1/admin/games` with `{ name }` creates a new game. Returns
// `201 Created` with the full `WireAdminGame` shape (zero counts on a
// brand-new game). Names are not unique (matches the schema; the dashboard
// can enforce a UX-level uniqueness guard).
export function createAdminGameHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = createGameBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid body");
    }
    const { name } = parsed.data;
    const game = await prisma.game.create({ data: { name } });
    return c.json<WireAdminGame>(
      toWireGame(game, { groupCount: 0, activeMemberCount: 0, apiKeyCount: 0 }),
      201,
    );
  };
}

// `GET /v1/admin/games/:gameId` returns the same shape as the list, scoped
// to a single game. The dashboard uses this on the game detail page so the
// counts stay live (the list view's 60s `revalidate` cache could otherwise
// be stale relative to a recent membership change).
export function getAdminGameHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (!game) throw Errors.notFound("game");

    const [groupCount, activeMemberCount, apiKeyCount] = await Promise.all([
      prisma.group.count({ where: { gameId, softDeletedAt: null } }),
      prisma.groupMember.count({
        where: {
          status: "active",
          group: { gameId, softDeletedAt: null },
        },
      }),
      prisma.apiKey.count({ where: { gameId, revokedAt: null } }),
    ]);

    return c.json<WireAdminGame>(toWireGame(game, { groupCount, activeMemberCount, apiKeyCount }));
  };
}

// `GET /v1/admin/games/:gameId/api-keys` lists every API key for a game,
// active and revoked. The `revokedAt` field lets the dashboard render
// revoked badges on past keys without losing them from the operator's
// view. The secret is never on the wire (stored only as a scrypt hash).
export function listAdminApiKeysHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const rows = await prisma.apiKey.findMany({
      where: { gameId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return c.json<WireAdminApiKeyList>({ items: rows.map(toWireApiKey) });
  };
}

// `POST /v1/admin/games/:gameId/api-keys` issues a fresh API key. The
// returned `key` field carries the dev-facing `prefix.secret` form and is
// the ONLY time the secret will appear on the wire (it is stored only as
// scrypt-hashed). The dashboard surfaces `key` in a copy-to-clipboard
// dialog and warns the operator that they will not see it again.
//
// Mirrors `seed.createApiKey` and the webhook-secret-on-create-only
// convention from Phase 5.5.
export function createAdminApiKeyHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const raw = await generateApiKey();
    const apiKey = await prisma.apiKey.create({
      data: { gameId, prefix: raw.prefix, hashedSecret: raw.hashedSecret },
    });

    return c.json<WireAdminApiKeyCreated>({ ...toWireApiKey(apiKey), key: raw.full }, 201);
  };
}

// =====================================================================
// Phase 11.4a: cross-game group browser
// =====================================================================

export interface WireAdminGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WireAdminGroupList {
  items: WireAdminGroup[];
  total: number;
  hasMore: boolean;
}

function toWireAdminGroup(row: Group, memberCount: number): WireAdminGroup {
  return {
    id: row.id,
    gameId: row.gameId,
    kind: row.kind,
    name: row.name,
    visibility: row.visibility,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    defaultRoleId: row.defaultRoleId,
    parentGroupId: row.parentGroupId,
    memberCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function batchActiveMemberCounts(
  prisma: PrismaClient,
  groupIds: string[],
): Promise<Map<string, number>> {
  if (groupIds.length === 0) return new Map();
  const rows = await prisma.groupMember.groupBy({
    by: ["groupId"],
    where: { groupId: { in: groupIds }, status: "active" },
    _count: { _all: true },
  });
  return new Map(rows.map((r) => [r.groupId, r._count._all]));
}

// `GET /v1/admin/games/:gameId/groups` lists every (non-soft-deleted) group
// in a game with the dashboard's TanStack Table in mind: pagination via
// `offset` / `limit`, free-text name search via `q` (case-insensitive
// `contains`), exact filter on `kind` and `visibility`, and three sort
// fields (`createdAt`, `name`, `memberCount`) in either order.
//
// Response shape:
//
//   {
//     items: WireAdminGroup[],
//     total: number,
//     hasMore: boolean,
//   }
//
// Behavior:
//
//   - Soft-deleted groups are excluded; this is the operator's "what is
//     live now" view, not a lifecycle history. A future `?includeDeleted`
//     flag is additive.
//   - `q`, `kind`, `visibility` are AND-combined when supplied together.
//     Empty `q` ("") is rejected at the schema layer (the schema requires
//     `min(1)`); pass the parameter unset to drop the filter.
//   - `sort=createdAt` and `sort=name` order at the database level with
//     `(field <order>, id asc)` for stable tiebreaking. Pagination is
//     `skip` / `take`.
//   - `sort=memberCount` is computed (no denormalized counter on the
//     Group row), so the handler fetches every matching row, batches the
//     member count, sorts in memory by `(count <order>, id asc)`, then
//     slices to `[offset, offset+limit)`. To bound the work, the matching
//     set is hard-capped at `ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS`; if the
//     filtered count exceeds the cap, the route returns 400 with a hint
//     to narrow the filter. In practice the dashboard's filter chips make
//     this trivial.
//   - 404 when the game does not exist (existence-leak rules don't apply
//     here; this is admin-token-gated).
//   - `total` reflects the matching set BEFORE pagination so TanStack
//     Table can render an accurate page count. `hasMore` is the derived
//     `offset + items.length < total`.
export function listAdminGroupsForGameHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const parsed = listAdminGroupsQuery.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      q: c.req.query("q"),
      kind: c.req.query("kind"),
      visibility: c.req.query("visibility"),
      sort: c.req.query("sort"),
      order: c.req.query("order"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, offset, q, kind, visibility, sort, order } = parsed.data;

    const where: Prisma.GroupWhereInput = {
      gameId,
      softDeletedAt: null,
      ...(q !== undefined ? { name: { contains: q, mode: "insensitive" } } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(visibility !== undefined ? { visibility } : {}),
    };

    if (sort === "memberCount") {
      const total = await prisma.group.count({ where });
      if (total > ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS) {
        throw Errors.badRequest(
          `cannot sort by memberCount across more than ${ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS} groups; narrow with q, kind, or visibility`,
        );
      }
      const groups = await prisma.group.findMany({
        where,
        orderBy: [{ id: "asc" }],
      });
      const counts = await batchActiveMemberCounts(
        prisma,
        groups.map((g) => g.id),
      );
      const enriched = groups.map((g) => ({ row: g, count: counts.get(g.id) ?? 0 }));
      enriched.sort((a, b) => {
        if (a.count !== b.count) {
          return order === "asc" ? a.count - b.count : b.count - a.count;
        }
        // Stable tiebreaker by id asc so the same offset returns the same
        // row across calls (subject to inserts / deletes between calls,
        // which offset-based pagination already accepts as a quirk).
        return a.row.id.localeCompare(b.row.id);
      });
      const sliced = enriched.slice(offset, offset + limit);
      return c.json<WireAdminGroupList>({
        items: sliced.map(({ row, count }) => toWireAdminGroup(row, count)),
        total,
        hasMore: offset + sliced.length < total,
      });
    }

    const orderBy: Prisma.GroupOrderByWithRelationInput[] =
      sort === "name" ? [{ name: order }, { id: "asc" }] : [{ createdAt: order }, { id: "asc" }];

    const [groups, total] = await Promise.all([
      prisma.group.findMany({ where, orderBy, skip: offset, take: limit }),
      prisma.group.count({ where }),
    ]);
    const counts = await batchActiveMemberCounts(
      prisma,
      groups.map((g) => g.id),
    );

    return c.json<WireAdminGroupList>({
      items: groups.map((g) => toWireAdminGroup(g, counts.get(g.id) ?? 0)),
      total,
      hasMore: offset + groups.length < total,
    });
  };
}

// `POST /v1/admin/games/:gameId/api-keys/:keyId/revoke` flips `revokedAt`
// to now() if not already set. Idempotent on already-revoked: returns the
// unchanged row without bumping the timestamp (the original revoke
// timestamp is the one operators care about). The row is never hard-
// deleted so the historic prefix can resolve in audit/log lookups.
//
// Cross-game scope: a key id that exists but belongs to a different game
// returns 404 (existence is not leaked across the gameId path scope).
export function revokeAdminApiKeyHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const keyId = c.req.param("keyId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!keyId) throw Errors.badRequest("keyId is required");

    const existing = await prisma.apiKey.findUnique({ where: { id: keyId } });
    if (!existing || existing.gameId !== gameId) {
      throw Errors.notFound("api key");
    }
    if (existing.revokedAt) {
      return c.json<WireAdminApiKey>(toWireApiKey(existing));
    }
    const updated = await prisma.apiKey.update({
      where: { id: keyId },
      data: { revokedAt: new Date() },
    });
    return c.json<WireAdminApiKey>(toWireApiKey(updated));
  };
}

// =====================================================================
// Phase 11.5a: cross-game group detail + members listing
// =====================================================================

// Single-group fetch reuses `WireAdminGroup` from Phase 11.4a.

export interface WireAdminMemberRole {
  id: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
}

export interface WireAdminGroupMember {
  id: string;
  groupId: string;
  externalUserId: string;
  junjoUserId: string;
  status: string;
  metadata: Record<string, unknown>;
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: string;
  leftAt: string | null;
  roles: WireAdminMemberRole[];
}

export interface WireAdminGroupMemberList {
  items: WireAdminGroupMember[];
  total: number;
  hasMore: boolean;
}

function toWireAdminMemberRole(role: Role): WireAdminMemberRole {
  return {
    id: role.id,
    name: role.name,
    priority: role.priority,
    color: role.color,
    isDefault: role.isDefault,
  };
}

function toWireAdminGroupMember(
  member: GroupMember,
  externalUserId: string,
  roles: Role[],
): WireAdminGroupMember {
  return {
    id: member.id,
    groupId: member.groupId,
    externalUserId,
    junjoUserId: member.junjoUserId,
    status: member.status,
    metadata: (member.metadata ?? {}) as Record<string, unknown>,
    notesPublic: member.notesPublic,
    notesPrivate: member.notesPrivate,
    joinedAt: member.joinedAt.toISOString(),
    leftAt: member.leftAt ? member.leftAt.toISOString() : null,
    roles: roles.map(toWireAdminMemberRole),
  };
}

// `GET /v1/admin/games/:gameId/groups/:groupId` returns a single group's
// detail in the same wire shape as the list endpoint (Phase 11.4a). The
// dashboard's group detail page header consumes this; counts are computed
// fresh per request rather than reading the list's revalidated cache.
//
// 404 when the game does not exist OR when the group does not exist OR
// when the group exists but belongs to a different game OR when the group
// is soft-deleted. Cross-game existence is not leaked through the gameId
// path scope. The dashboard's not-found mapping (substring-match on the
// error envelope) routes the operator to Next.js's 404 page.
export function getAdminGroupHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw Errors.notFound("group");
    if (group.gameId !== gameId) throw Errors.notFound("group");
    if (group.softDeletedAt !== null) throw Errors.notFound("group");

    const memberCount = await prisma.groupMember.count({
      where: { groupId, status: "active" },
    });

    return c.json<WireAdminGroup>(toWireAdminGroup(group, memberCount));
  };
}

// `GET /v1/admin/games/:gameId/groups/:groupId/members` lists members of a
// single group with their roles populated for the dashboard's members tab
// (TanStack Table with role chips). Pagination is offset / limit; the
// status filter narrows to one of `active | left | kicked | invited` or
// returns every status with `?status=all`. Default is `active` since the
// roster panel is the dominant view.
//
// Behavior:
//
//   - Sorted by `(joinedAt desc, id desc)`. Newest joins first matches
//     the dashboard's mental model and the per-game `members.list` route.
//   - `q` performs a case-insensitive substring search against the dev's
//     external user id (the `ExternalIdentity.externalUserId` field, NOT
//     the internal `junjoUserId`). This is the field operators recognize.
//     The search runs as a Postgres `contains` on the joined identity row.
//   - Roles are populated via two batched queries: one `MemberRole.findMany`
//     for join rows scoped to the page's member ids, plus one
//     `Role.findMany` for the role rows themselves. The handler fans out
//     the result to per-member arrays in memory. This keeps the fetch at
//     four total queries (count + member page + member-roles + role rows
//     + identities) regardless of page size.
//   - 404 propagates from the same group existence checks the single-group
//     handler enforces.
//   - `total` reflects the matching set BEFORE pagination so the dashboard
//     can render an accurate page count.
//   - `hasMore` is `offset + items.length < total`.
export function listAdminGroupMembersHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true, gameId: true, softDeletedAt: true },
    });
    if (!group) throw Errors.notFound("group");
    if (group.gameId !== gameId) throw Errors.notFound("group");
    if (group.softDeletedAt !== null) throw Errors.notFound("group");

    const parsed = listAdminGroupMembersQuery.safeParse({
      limit: c.req.query("limit"),
      offset: c.req.query("offset"),
      status: c.req.query("status"),
      q: c.req.query("q"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, offset, status, q } = parsed.data;

    // Build the where clause. The status filter is straightforward; the q
    // filter has to traverse `JunjoUser -> ExternalIdentity (gameId, ...)`
    // because the wire shape's `externalUserId` lives on a related row.
    // Prisma's relation filters compose cleanly against the page query.
    const where: Prisma.GroupMemberWhereInput = {
      groupId,
      ...(status !== "all" ? { status } : {}),
      ...(q !== undefined
        ? {
            junjoUser: {
              externalIdentities: {
                some: {
                  gameId,
                  externalUserId: { contains: q, mode: "insensitive" },
                },
              },
            },
          }
        : {}),
    };

    const [members, total] = await Promise.all([
      prisma.groupMember.findMany({
        where,
        orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
        skip: offset,
        take: limit,
      }),
      prisma.groupMember.count({ where }),
    ]);

    if (members.length === 0) {
      return c.json<WireAdminGroupMemberList>({
        items: [],
        total,
        hasMore: false,
      });
    }

    const memberIds = members.map((m) => m.id);
    const junjoUserIds = members.map((m) => m.junjoUserId);

    const [memberRoleRows, identities] = await Promise.all([
      prisma.memberRole.findMany({
        where: { groupMemberId: { in: memberIds } },
        select: { groupMemberId: true, roleId: true },
      }),
      prisma.externalIdentity.findMany({
        where: { gameId, junjoUserId: { in: junjoUserIds } },
        select: { junjoUserId: true, externalUserId: true },
      }),
    ]);

    const roleIdsByMember = new Map<string, string[]>();
    const allRoleIds = new Set<string>();
    for (const row of memberRoleRows) {
      const list = roleIdsByMember.get(row.groupMemberId);
      if (list) list.push(row.roleId);
      else roleIdsByMember.set(row.groupMemberId, [row.roleId]);
      allRoleIds.add(row.roleId);
    }

    const roles =
      allRoleIds.size === 0
        ? []
        : await prisma.role.findMany({
            where: { id: { in: Array.from(allRoleIds) } },
          });
    const rolesById = new Map(roles.map((r) => [r.id, r]));

    const identityById = new Map(identities.map((i) => [i.junjoUserId, i.externalUserId]));

    const items = members.map((m) => {
      const externalUserId = identityById.get(m.junjoUserId) ?? "";
      const memberRoleIds = roleIdsByMember.get(m.id) ?? [];
      const memberRoles = memberRoleIds
        .map((id) => rolesById.get(id))
        .filter((r): r is Role => r !== undefined)
        .sort((a, b) => {
          if (a.priority !== b.priority) return b.priority - a.priority;
          return a.name.localeCompare(b.name);
        });
      return toWireAdminGroupMember(m, externalUserId, memberRoles);
    });

    return c.json<WireAdminGroupMemberList>({
      items,
      total,
      hasMore: offset + items.length < total,
    });
  };
}

// =====================================================================
// Phase 11.5c-i: cross-game member row actions
// (kick, edit notes / metadata, override permission set / clear, list overrides)
// =====================================================================

// Wire format for member-level permission overrides on the admin surface.
// Identical shape to the per-game route's response (the dashboard renders
// the same data either way); duplicated here so admin handlers do not
// reach across into the per-game `routes/members.ts` module for a single
// helper.
export interface WireAdminMemberPermissionOverride {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  setAt: string;
  setBy: string | null;
}

function toWireAdminMemberPermissionOverride(
  row: MemberPermissionOverride,
  groupId: string,
  externalUserId: string,
): WireAdminMemberPermissionOverride {
  return {
    groupId,
    userId: externalUserId,
    permission: row.permissionKey,
    grant: row.grant,
    setAt: row.setAt.toISOString(),
    setBy: null,
  };
}

interface AdminMemberContext {
  group: Group;
  member: GroupMember;
  junjoUserId: string;
  externalUserId: string;
}

// Resolve the (gameId, groupId, externalUserId) tuple to a concrete
// `Group` + `GroupMember`. Collapses every "doesn't exist" cause - missing
// game-scope, soft-deleted group, no `ExternalIdentity` for the user, no
// `GroupMember` row - into a single 404 to avoid leaking existence through
// the path scope. Mirrors the per-game leave / kick / patch precedent.
async function loadAdminMemberContext(
  prisma: PrismaClient,
  gameId: string,
  groupId: string,
  externalUserId: string,
): Promise<AdminMemberContext> {
  const group = await prisma.group.findUnique({ where: { id: groupId } });
  if (!group) throw Errors.notFound("member");
  if (group.gameId !== gameId) throw Errors.notFound("member");
  if (group.softDeletedAt !== null) throw Errors.notFound("member");

  const junjoUserId = await findJunjoUserId(prisma, gameId, externalUserId);
  if (!junjoUserId) throw Errors.notFound("member");

  const member = await prisma.groupMember.findUnique({
    where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
  });
  if (!member) throw Errors.notFound("member");

  return { group, member, junjoUserId, externalUserId };
}

// Reload a single GroupMember row, its roles, and its identity to build
// the post-mutation `WireAdminGroupMember` response. Same role-sort rule
// as the list endpoint (priority desc, name asc tiebreaker).
async function loadAdminGroupMemberAfterMutation(
  prisma: PrismaClient,
  gameId: string,
  memberId: string,
  externalUserId: string,
): Promise<WireAdminGroupMember> {
  const member = await prisma.groupMember.findUnique({ where: { id: memberId } });
  if (!member) throw Errors.notFound("member");

  const memberRoleRows = await prisma.memberRole.findMany({
    where: { groupMemberId: member.id },
    select: { roleId: true },
  });
  const roleIds = memberRoleRows.map((r) => r.roleId);
  const roles =
    roleIds.length === 0
      ? []
      : await prisma.role.findMany({
          where: { id: { in: roleIds } },
        });
  roles.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.name.localeCompare(b.name);
  });
  // `gameId` is in scope for callers; declared here only to mark the
  // identity lookup as scoped (the row's externalUserId is the caller's
  // path parameter so we round-trip it directly without re-querying).
  void gameId;
  return toWireAdminGroupMember(member, externalUserId, roles);
}

// `POST /v1/admin/games/:gameId/groups/:groupId/members/:userId/kick`
// kicks a member from the group. Mirrors the per-game route's semantics
// exactly: only transitions an active member to "kicked"; non-active
// rows return their current state with no audit entry. The optional
// `reason` lands on the audit `payload`. `actorUserId` is null on the
// admin surface (no auth-adapter actor wired); the operator is the
// dashboard itself, behind the admin token. Dispatches a `member.left`
// event with `reason: "kicked"` so SSE subscribers and webhooks see the
// change just like a per-game-key kick.
export function kickAdminGroupMemberHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");
    if (!userId) throw Errors.badRequest("userId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = adminKickMemberBody.safeParse(json ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const reasonValue = parsed.data.reason ?? null;

    const { group, member } = await loadAdminMemberContext(prisma, gameId, groupId, userId);

    if (member.status !== "active") {
      const wire = await loadAdminGroupMemberAfterMutation(prisma, gameId, member.id, userId);
      return c.json<WireAdminGroupMember>(wire);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "kicked", leftAt: new Date() },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "member.kicked",
          targetId: userId,
          payload: {
            memberId: result.id,
            reason: reasonValue,
          } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    await dispatchEvent<MemberLeftEvent>(prisma, hub, {
      type: "member.left",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      userId: userId as UserId,
      reason: "kicked",
    });

    const wire = await loadAdminGroupMemberAfterMutation(prisma, gameId, updated.id, userId);
    return c.json<WireAdminGroupMember>(wire);
  };
}

// `PATCH /v1/admin/games/:gameId/groups/:groupId/members/:userId`
// updates a member's metadata and / or notes. Body is partial:
// `{ metadata?, notesPublic?, notesPrivate? }`. Empty body returns 400.
// Metadata replaces wholesale and is always treated as a change when
// supplied (jsonb storage may not preserve key order; matches the
// `groups.update` precedent). Notes fields are diffed per-field; a
// notes-only PATCH where every supplied field equals the stored value is
// a no-op (no DB write, no audit). Up to two audit entries fire per call:
// `member.metadata.updated` and `member.notes.updated`. No JunjoEvent
// fires for either action (per VISION 5.1b: notes / metadata mutations
// have no `JunjoEvent`-union counterpart). `actorUserId` is null.
export function updateAdminGroupMemberHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");
    if (!userId) throw Errors.badRequest("userId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = adminUpdateMemberBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const { group, member } = await loadAdminMemberContext(prisma, gameId, groupId, userId);

    const data: Prisma.GroupMemberUpdateInput = {};
    const metadataChanged = body.metadata !== undefined;
    if (metadataChanged) {
      data.metadata = body.metadata as Prisma.InputJsonValue;
    }

    const notesBefore: Record<string, string | null> = {};
    const notesAfter: Record<string, string | null> = {};
    if (body.notesPublic !== undefined && body.notesPublic !== member.notesPublic) {
      notesBefore.notesPublic = member.notesPublic;
      notesAfter.notesPublic = body.notesPublic;
      data.notesPublic = body.notesPublic;
    }
    if (body.notesPrivate !== undefined && body.notesPrivate !== member.notesPrivate) {
      notesBefore.notesPrivate = member.notesPrivate;
      notesAfter.notesPrivate = body.notesPrivate;
      data.notesPrivate = body.notesPrivate;
    }
    const notesChanged = Object.keys(notesAfter).length > 0;

    if (Object.keys(data).length === 0) {
      const wire = await loadAdminGroupMemberAfterMutation(prisma, gameId, member.id, userId);
      return c.json<WireAdminGroupMember>(wire);
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data,
      });
      if (metadataChanged) {
        await tx.auditEntry.create({
          data: {
            groupId: group.id,
            actorUserId: null,
            action: "member.metadata.updated",
            targetId: userId,
            payload: {
              before: { metadata: (member.metadata ?? {}) as Prisma.InputJsonValue },
              after: { metadata: body.metadata as Prisma.InputJsonValue },
            } as Prisma.InputJsonValue,
          },
        });
      }
      if (notesChanged) {
        await tx.auditEntry.create({
          data: {
            groupId: group.id,
            actorUserId: null,
            action: "member.notes.updated",
            targetId: userId,
            payload: {
              before: notesBefore,
              after: notesAfter,
            } as Prisma.InputJsonValue,
          },
        });
      }
      return result;
    });

    const wire = await loadAdminGroupMemberAfterMutation(prisma, gameId, updated.id, userId);
    return c.json<WireAdminGroupMember>(wire);
  };
}

// `POST /v1/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission`
// sets or updates a member-level permission override. Body: `{ grant }`.
// Idempotent on matching `grant` (no audit, no DB write, no setAt bump).
// On change writes one `permission.override.set` audit entry with
// `before/after`. The permission key is auto-registered into
// `PermissionDef` on first sight per game (matches `roles.grantPermission`
// and the per-game override route). Invalidates the in-memory permission
// cache for the group after commit so the next `permissions.check`
// reflects the new value. `actorUserId` is null.
export function setAdminMemberPermissionOverrideHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    const permission = c.req.param("permission");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!permission) throw Errors.badRequest("permission must not be empty");
    if (permission.length > ADMIN_PERMISSION_KEY_MAX_LENGTH) {
      throw Errors.badRequest(
        `permission must be at most ${ADMIN_PERMISSION_KEY_MAX_LENGTH} characters`,
      );
    }

    const json = await c.req.json().catch(() => null);
    const parsed = adminOverridePermissionBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { grant } = parsed.data;

    const { group, member } = await loadAdminMemberContext(prisma, gameId, groupId, userId);

    const existing = await prisma.memberPermissionOverride.findUnique({
      where: {
        groupMemberId_permissionKey: {
          groupMemberId: member.id,
          permissionKey: permission,
        },
      },
    });
    if (existing && existing.grant === grant) {
      return c.json<WireAdminMemberPermissionOverride>(
        toWireAdminMemberPermissionOverride(existing, group.id, userId),
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.permissionDef.upsert({
        where: { gameId_key: { gameId, key: permission } },
        create: { gameId, key: permission },
        update: {},
      });
      const upserted = await tx.memberPermissionOverride.upsert({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: permission,
          },
        },
        create: {
          groupMemberId: member.id,
          permissionKey: permission,
          grant,
          setByUserId: null,
        },
        update: { grant, setAt: new Date() },
      });
      const auditPayload: Record<string, unknown> = {
        memberId: member.id,
        permission,
        grant,
      };
      if (existing) auditPayload.before = { grant: existing.grant };
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "permission.override.set",
          targetId: userId,
          payload: auditPayload as Prisma.InputJsonValue,
        },
      });
      return upserted;
    });
    permissionCache.invalidateGroup(group.id);

    return c.json<WireAdminMemberPermissionOverride>(
      toWireAdminMemberPermissionOverride(result, group.id, userId),
    );
  };
}

// `DELETE /v1/admin/games/:gameId/groups/:groupId/members/:userId/permissions/:permission`
// clears a member-level permission override. Idempotent: a missing row
// returns 204 with no audit entry. The `PermissionDef` registry row is
// preserved across clears (matches the per-game route's monotonic-catalog
// stance). Invalidates the in-memory permission cache after commit.
export function clearAdminMemberPermissionOverrideHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    const permission = c.req.param("permission");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");
    if (!userId) throw Errors.badRequest("userId is required");
    if (!permission) throw Errors.badRequest("permission must not be empty");

    const { group, member } = await loadAdminMemberContext(prisma, gameId, groupId, userId);

    const existing = await prisma.memberPermissionOverride.findUnique({
      where: {
        groupMemberId_permissionKey: {
          groupMemberId: member.id,
          permissionKey: permission,
        },
      },
    });
    if (!existing) return c.body(null, 204);

    await prisma.$transaction(async (tx) => {
      await tx.memberPermissionOverride.delete({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: permission,
          },
        },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "permission.override.cleared",
          targetId: userId,
          payload: {
            memberId: member.id,
            permission,
            grant: existing.grant,
          } as Prisma.InputJsonValue,
        },
      });
    });
    permissionCache.invalidateGroup(group.id);

    return c.body(null, 204);
  };
}

// `GET /v1/admin/games/:gameId/groups/:groupId/members/:userId/permissions`
// lists a member's permission overrides. Returns a bare array (no
// pagination wrapper); a member typically has a handful of overrides, not
// thousands. Sorted by `permissionKey` ascending for deterministic output.
export function listAdminMemberPermissionOverridesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    const userId = c.req.param("userId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");
    if (!userId) throw Errors.badRequest("userId is required");

    const { group, member } = await loadAdminMemberContext(prisma, gameId, groupId, userId);

    const overrides = await prisma.memberPermissionOverride.findMany({
      where: { groupMemberId: member.id },
      orderBy: { permissionKey: "asc" },
    });

    return c.json<WireAdminMemberPermissionOverride[]>(
      overrides.map((o) => toWireAdminMemberPermissionOverride(o, group.id, userId)),
    );
  };
}
