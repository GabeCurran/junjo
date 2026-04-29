// @cloud-only
//
// Cross-tenant admin endpoints (Phase 10.2 + 11.2a). All routes here are gated
// by the admin token (separate auth scheme from per-game API keys), so they
// live outside the per-game `apiKeyMiddleware` chain. Mirror SDK is
// intentionally NOT shipped in V1 per VISION; the dashboard calls these
// endpoints directly via fetch.

import type { AuditEntry, Game, Group, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { listRecentAuditQuery } from "./admin.schema.js";

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
