// @cloud-only
//
// Cross-tenant admin endpoints (Phase 10.2 + 11.2a). All routes here are gated
// by the admin token (separate auth scheme from per-game API keys), so they
// live outside the per-game `apiKeyMiddleware` chain. Mirror SDK is
// intentionally NOT shipped in V1 per VISION; the dashboard calls these
// endpoints directly via fetch.

import type { ApiKey, AuditEntry, Game, Group, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { generateApiKey } from "../apiKey.js";
import { Errors } from "../errors.js";
import { createGameBody, listAdminGamesQuery, listRecentAuditQuery } from "./admin.schema.js";

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
