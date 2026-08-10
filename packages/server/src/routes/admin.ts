// @cloud-only
//
// Cross-tenant admin endpoints, gated by the admin token (separate auth
// scheme from per-game API keys); they live outside the per-game
// `apiKeyMiddleware` chain. No SDK mirror in V1 by design; the dashboard
// calls these endpoints directly via fetch.

import type {
  GameId,
  GroupId,
  GroupRelationshipChangedEvent,
  GroupUpdatedEvent,
  MemberInvitedEvent,
  MemberLeftEvent,
  PermissionGrantedEvent,
  PermissionKey,
  PermissionRevokedEvent,
  RoleCreatedEvent,
  RoleDeletedEvent,
  RoleId,
  UserId,
} from "@junjo.io/shared";
import { Prisma } from "@prisma/client";
import type {
  ApiKey,
  AuditEntry,
  Game,
  Group,
  GroupMember,
  GroupRelationship,
  Invitation,
  MemberPermissionOverride,
  PrismaClient,
  Role,
} from "@prisma/client";
import type { Handler } from "hono";
import { generateApiKey, hashSecret } from "../apiKey.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import {
  publishStagedEvents,
  stageEvent,
  toPublicGroup,
  toPublicGroupRelationship,
  toPublicInvitation,
  toPublicRole,
} from "../events.js";
import { findJunjoUserId } from "../identity.js";
import { type PermissionCache, permissionCache } from "../permissionCache.js";
import { isUniqueViolation } from "../prismaErrors.js";
import {
  ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS,
  ADMIN_GROUP_GROWTH_DEFAULT_WINDOW_MS,
  ADMIN_GROUP_GROWTH_MAX_BUCKETS,
  ADMIN_PERMISSION_KEY_MAX_LENGTH,
  ADMIN_PERMISSION_USAGE_TOP_N,
  ADMIN_ROLE_DISTRIBUTION_TOP_N,
  ANALYTICS_GROUP_CHURN_BINS,
  ANALYTICS_MEMBER_ACTIVITY_DAYS,
  ANALYTICS_MEMBER_ACTIVITY_HOURS,
  adminCheckPermissionQuery,
  adminClearRelationshipQuery,
  adminCreateInvitationBody,
  adminCreateRoleBody,
  adminGrantPermissionBody,
  adminKickMemberBody,
  adminOverridePermissionBody,
  adminSetParentBody,
  adminSetRelationshipBody,
  adminUpdateMemberBody,
  adminUpdateRoleBody,
  createGameBody,
  groupChurnQuery,
  groupGrowthQuery,
  listAdminGameAuditQuery,
  listAdminGamesQuery,
  listAdminGroupMembersQuery,
  listAdminGroupsQuery,
  listRecentAuditQuery,
  memberActivityQuery,
  updateAdminGroupBody,
} from "./admin.schema.js";
import { auditBeforeFilter, serializeAuditEntry } from "./audit.js";
import type { WireAuditEntry } from "./audit.js";
import { listAuditQuery } from "./audit.schema.js";
import { generateInvitationCode, parseDurationMs, serializeInvitation } from "./invitations.js";
import type { WireInvitation } from "./invitations.js";
import { setGroupParentSafely } from "./parentCycle.js";
import { resolvePermission } from "./permissions.js";
import { serializeGroupRelationship } from "./relationships.js";
import type { WireGroupRelationship } from "./relationships.js";

export interface WireUserGameRow {
  gameId: string;
  externalUserId: string;
  joinedGroupCount: number;
}

export interface WireUserGames {
  junjoUserId: string;
  games: WireUserGameRow[];
}

// The `junjoUserId` path parameter is the internal cross-game id (a
// `JunjoUser.id`), not a dev-supplied external user id; the dashboard
// knows it from a direct Postgres query or a webhook payload.
//
// A `junjoUserId` with no `ExternalIdentity` rows returns 200 with empty
// `games`, NOT 404: a newly-created JunjoUser may have no cross-game
// footprint yet, and "no games" is the same answer for the consumer.
export function listUserGamesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const junjoUserId = c.req.param("junjoUserId");
    if (!junjoUserId) throw Errors.badRequest("junjoUserId is required");

    const identities = await prisma.externalIdentity.findMany({
      where: { junjoUserId },
      select: { gameId: true, externalUserId: true },
      orderBy: { gameId: "asc" },
    });

    if (identities.length === 0) {
      return c.json<WireUserGames>({ junjoUserId, games: [] });
    }

    // One batched query + in-memory tally avoids N+1 counts.
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

export interface WireAdminStats {
  totalGames: number;
  totalGroups: number;
  totalActiveMembers: number;
  totalAuditEntriesLast24h: number;
}

const STATS_AUDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// Active-set semantics: `totalGroups` and `totalActiveMembers` exclude
// soft-deleted groups (the dashboard's "active groups" mental model
// wins over including the 7-day pending-deletion window).
// `totalAuditEntriesLast24h` is unfiltered: soft-deleted-group entries
// are still part of audit history, and the card reflects activity
// volume, not surviving-group volume.
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
  // Null for game-scoped events (e.g. game.user.banned). When null,
  // groupName is null and groupSoftDeleted is false.
  groupId: string | null;
  groupName: string | null;
  groupSoftDeleted: boolean;
  actorUserId: string | null;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WireAdminAuditPage {
  items: WireAdminAuditEntry[];
}

// Mirrors the `include` shape so the serializer can take a typed
// parameter and the call site stays honest about requested fields.
// `group` is optional because game-scoped events have a null groupId
// and the relation walk returns null in that case.
type AdminAuditRow = AuditEntry & {
  game: Pick<Game, "name">;
  group: Pick<Group, "name" | "softDeletedAt"> | null;
};

export function serializeAdminAuditEntry(row: AdminAuditRow): WireAdminAuditEntry {
  return {
    id: row.id,
    action: row.action,
    gameId: row.gameId,
    gameName: row.game.name,
    groupId: row.groupId,
    groupName: row.group?.name ?? null,
    groupSoftDeleted: row.group?.softDeletedAt != null,
    actorUserId: row.actorUserId,
    targetId: row.targetId,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    createdAt: row.createdAt.toISOString(),
  };
}

// Pivots `<game> / <group>` names into each row so the activity-feed card
// renders without an N+1 lookup. No pagination by design: the home card
// only renders 20-100 items.
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
        game: { select: { name: true } },
        group: { select: { name: true, softDeletedAt: true } },
      },
    });

    return c.json<WireAdminAuditPage>({
      items: rows.map(serializeAdminAuditEntry),
    });
  };
}

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

// `key` is on the wire only at creation time; the secret is stored only
// as a scrypt hash and cannot be recovered, so subsequent list calls
// return `WireAdminApiKey` (no key). Mirrors the webhook-secret-once-on-
// create convention.
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

// Three batched queries + in-memory tally avoids 3*N round-trips.
// `groupCount` / `activeMemberCount` exclude soft-deleted groups
// (active-set semantics); `apiKeyCount` excludes revoked keys (dashboard
// cares about currently-usable, not lifetime issuance).
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

// Names are not unique (the schema does not enforce it; UX-level guards
// belong in the dashboard).
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

// Counts are computed fresh per request rather than reading the list
// view's 60s `revalidate` cache.
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

// Includes revoked keys so the dashboard can render "revoked" badges on
// past keys without losing them from the operator's view.
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

// `key` carries the dev-facing `prefix.secret` and is the only time the
// secret appears on the wire (storage is scrypt-only). Mirrors
// `seed.createApiKey` and the webhook secret-once-on-create convention.
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
  hasPasscode: boolean;
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
    // Presence-only; the hash itself never leaves the server.
    hasPasscode: row.passcodeHash !== null,
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

// `sort=memberCount` has no denormalized counter, so the handler fetches
// every matching row, batches counts, sorts in memory, then slices.
// `ADMIN_GROUPS_MEMBER_COUNT_MAX_ROWS` caps that work; over the cap the
// route 400s with a "narrow your filter" hint.
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
        // Tiebreaker so the same offset returns the same row across calls.
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

// Idempotent on already-revoked: keeps the original `revokedAt`
// (operators care about when the revoke happened, not when they retried).
// Rows are never hard-deleted so the historic prefix resolves in audit
// lookups.
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

// Cross-game existence is not leaked through the gameId path scope: a
// group that exists in another game collapses with the missing /
// soft-deleted cases into 404.
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

// `q` searches the dev-facing `ExternalIdentity.externalUserId` (what
// operators recognize), not the internal `junjoUserId`. Roles are
// populated via two batched queries + in-memory fan-out so total fetch
// is bounded regardless of page size.
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

    // `q` traverses `JunjoUser -> ExternalIdentity (gameId, ...)` because
    // the wire's `externalUserId` lives on a related row.
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

// Structural duplicate of the per-game `WireMemberPermissionOverride`;
// admin handlers do not import across the cloud-only boundary.
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

// Collapses every "doesn't exist" cause (cross-game group, soft-delete,
// missing ExternalIdentity, missing GroupMember) into a single 404 to
// avoid existence-leak through the path scope.
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

// Same role-sort as the list endpoint (priority desc, name asc).
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
  // Marks the identity lookup as scoped; the externalUserId is round-
  // tripped from the path so we skip re-querying.
  void gameId;
  return toWireAdminGroupMember(member, externalUserId, roles);
}

// Only transitions an active member to "kicked"; non-active rows return
// their current state with no audit entry. `actorUserId` is null in V1
// (no auth-adapter actor wired); the operator is the dashboard itself
// behind the admin token.
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

    const { row: updated, event } = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "kicked", leftAt: new Date() },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
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
      const staged = await stageEvent<MemberLeftEvent>(tx, {
        type: "member.left",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        userId: userId as UserId,
        reason: "kicked",
      });
      return { row: result, event: staged };
    });

    publishStagedEvents(hub, event);

    const wire = await loadAdminGroupMemberAfterMutation(prisma, gameId, updated.id, userId);
    return c.json<WireAdminGroupMember>(wire);
  };
}

// Metadata replaces wholesale and is treated as a change whenever
// supplied (jsonb may not preserve key order; matches `groups.update`).
// Notes are diffed per-field; a notes-only PATCH that matches stored
// values is a true no-op. No JunjoEvent fires (no metadata/notes event
// in the union). Up to two audit entries per call.
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
            gameId,
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
            gameId,
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

// Idempotent on matching `grant`. First sight of a permission key
// auto-registers `PermissionDef`. Cache is invalidated after commit so
// the next `permissions.check` reflects the new value.
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
          gameId,
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

// Idempotent on missing row. The `PermissionDef` registry row is
// preserved across clears (catalog is monotonic per game).
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
          gameId,
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

// `roleId` is forwarded verbatim, NOT validated against `Role`; an
// invalid roleId surfaces at accept time.
//
// Audit `payload.source: "admin"` lets consumers distinguish admin-
// issued invitations from per-game-key calls (which set `bulk-invite`
// for bulk and omit `source` otherwise).
export function createAdminGroupInvitationHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const parsed = adminCreateInvitationBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    let expiresAt: Date | null = null;
    if (body.expiresIn !== undefined) {
      const ms = parseDurationMs(body.expiresIn);
      if (ms === null) throw Errors.badRequest("expiresIn must be a positive duration");
      expiresAt = new Date(Date.now() + ms);
    }

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw Errors.notFound("group");
    if (group.gameId !== gameId) throw Errors.notFound("group");
    if (group.softDeletedAt !== null) throw Errors.notFound("group");

    const targetUserId = body.targetUserId ?? null;
    const roleId = body.roleId ?? null;

    const { invitation, event } = await prisma.$transaction(
      async (tx): Promise<{ invitation: Invitation; event: MemberInvitedEvent }> => {
        const created = await tx.invitation.create({
          data: {
            groupId: group.id,
            code: generateInvitationCode(),
            roleId,
            targetUserId,
            createdByUserId: null,
            expiresAt,
          },
        });
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: group.id,
            actorUserId: null,
            action: "member.invited",
            targetId: targetUserId,
            payload: {
              invitationId: created.id,
              code: created.code,
              targetUserId,
              roleId,
              expiresAt: expiresAt ? expiresAt.toISOString() : null,
              source: "admin",
            } as Prisma.InputJsonValue,
          },
        });
        const staged = await stageEvent<MemberInvitedEvent>(tx, {
          type: "member.invited",
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          invitation: toPublicInvitation(created),
        });
        return { invitation: created, event: staged };
      },
    );

    publishStagedEvents(hub, event);

    return c.json<WireInvitation>(serializeInvitation(invitation), 201);
  };
}

// Structural duplicate of `WireRole` from `routes/roles.ts`; admin
// handlers do not import across the cloud-only boundary.
export interface WireAdminRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  createdAt: string;
}

export function toWireAdminRole(role: Role, permissions: string[]): WireAdminRole {
  return {
    id: role.id,
    groupId: role.groupId,
    name: role.name,
    priority: role.priority,
    color: role.color,
    isDefault: role.isDefault,
    permissions,
    createdAt: role.createdAt.toISOString(),
  };
}

// Cross-game / soft-deleted-group / missing all collapse to 404 to
// avoid existence enumeration through the path scope.
async function loadAdminScopedRole(
  prisma: PrismaClient,
  gameId: string,
  roleId: string,
): Promise<Role> {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { group: { select: { gameId: true, softDeletedAt: true } } },
  });
  if (!role) throw Errors.notFound("role");
  if (role.group.gameId !== gameId) throw Errors.notFound("role");
  if (role.group.softDeletedAt !== null) throw Errors.notFound("role");
  const { group: _group, ...rest } = role;
  return rest as Role;
}

async function loadAdminRolePermissionKeys(
  prisma: PrismaClient,
  roleId: string,
): Promise<string[]> {
  const rows = await prisma.rolePermission.findMany({
    where: { roleId },
    select: { permissionKey: true },
    orderBy: { permissionKey: "asc" },
  });
  return rows.map((r) => r.permissionKey);
}

async function batchLoadAdminRolePermissionKeys(
  prisma: PrismaClient,
  roleIds: string[],
): Promise<Map<string, string[]>> {
  if (roleIds.length === 0) return new Map();
  const rows = await prisma.rolePermission.findMany({
    where: { roleId: { in: roleIds } },
    select: { roleId: true, permissionKey: true },
    orderBy: { permissionKey: "asc" },
  });
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.roleId);
    if (list) list.push(row.permissionKey);
    else map.set(row.roleId, [row.permissionKey]);
  }
  return map;
}

export function listAdminGroupRolesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw Errors.notFound("group");
    if (group.gameId !== gameId) throw Errors.notFound("group");
    if (group.softDeletedAt !== null) throw Errors.notFound("group");

    const roles = await prisma.role.findMany({
      where: { groupId: group.id },
      orderBy: [{ priority: "desc" }, { id: "desc" }],
    });
    if (roles.length === 0) return c.json<WireAdminRole[]>([]);

    const permissionMap = await batchLoadAdminRolePermissionKeys(
      prisma,
      roles.map((r) => r.id),
    );
    return c.json<WireAdminRole[]>(
      roles.map((role) => toWireAdminRole(role, permissionMap.get(role.id) ?? [])),
    );
  };
}

// `name` is unique per group; an explicit pre-check returns 409
// `role_name_taken` before the transaction (cleaner than relying on the
// unique-constraint failure surfacing through the error middleware).
export function createAdminGroupRoleHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = adminCreateRoleBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group) throw Errors.notFound("group");
    if (group.gameId !== gameId) throw Errors.notFound("group");
    if (group.softDeletedAt !== null) throw Errors.notFound("group");

    const duplicate = await prisma.role.findUnique({
      where: { groupId_name: { groupId: group.id, name: body.name } },
      select: { id: true },
    });
    if (duplicate) throw Errors.roleNameTaken();

    const { role, event } = await prisma
      .$transaction(async (tx) => {
        const created = await tx.role.create({
          data: {
            groupId: group.id,
            name: body.name,
            priority: body.priority,
            color: body.color ?? null,
            isDefault: body.isDefault ?? false,
          },
        });
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: group.id,
            actorUserId: null,
            action: "role.created",
            targetId: created.id,
            payload: {
              name: created.name,
              priority: created.priority,
              color: created.color,
              isDefault: created.isDefault,
            } as Prisma.InputJsonValue,
          },
        });
        const staged = await stageEvent<RoleCreatedEvent>(tx, {
          type: "role.created",
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          role: toPublicRole(created, []),
        });
        return { role: created, event: staged };
      })
      .catch((err) => {
        // Loser of a concurrent same-name create: the winner's row
        // landed after the duplicate check above. Same answer the
        // sequential second caller gets. The rollback also drops the
        // staged webhook deliveries.
        if (isUniqueViolation(err)) throw Errors.roleNameTaken();
        throw err;
      });

    publishStagedEvents(hub, event);

    return c.json<WireAdminRole>(toWireAdminRole(role, []), 201);
  };
}

// Does NOT dispatch a JunjoEvent: there is no `RoleUpdatedEvent` in the
// union; only role assignment changes fire `role.changed`.
export function updateAdminRoleHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const roleId = c.req.param("roleId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!roleId) throw Errors.badRequest("roleId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = adminUpdateRoleBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const existing = await loadAdminScopedRole(prisma, gameId, roleId);

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const data: Prisma.RoleUpdateInput = {};

    if (body.name !== undefined && body.name !== existing.name) {
      const duplicate = await prisma.role.findUnique({
        where: { groupId_name: { groupId: existing.groupId, name: body.name } },
        select: { id: true },
      });
      if (duplicate) throw Errors.roleNameTaken();
      before.name = existing.name;
      after.name = body.name;
      data.name = body.name;
    }
    if (body.priority !== undefined && body.priority !== existing.priority) {
      before.priority = existing.priority;
      after.priority = body.priority;
      data.priority = body.priority;
    }
    if (body.color !== undefined && body.color !== existing.color) {
      before.color = existing.color;
      after.color = body.color;
      data.color = body.color;
    }
    if (body.isDefault !== undefined && body.isDefault !== existing.isDefault) {
      before.isDefault = existing.isDefault;
      after.isDefault = body.isDefault;
      data.isDefault = body.isDefault;
    }

    if (Object.keys(data).length === 0) {
      const permissions = await loadAdminRolePermissionKeys(prisma, existing.id);
      return c.json<WireAdminRole>(toWireAdminRole(existing, permissions));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.role.update({
        where: { id: existing.id },
        data,
      });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: existing.groupId,
          actorUserId: null,
          action: "role.updated",
          targetId: result.id,
          payload: { before, after } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const permissions = await loadAdminRolePermissionKeys(prisma, updated.id);
    return c.json<WireAdminRole>(toWireAdminRole(updated, permissions));
  };
}

// Blocks on assigned members with 409 `role_has_members`; the operator
// must reassign first.
export function deleteAdminRoleHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const roleId = c.req.param("roleId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!roleId) throw Errors.badRequest("roleId is required");

    const existing = await loadAdminScopedRole(prisma, gameId, roleId);

    const memberCount = await prisma.memberRole.count({
      where: { roleId: existing.id },
    });
    if (memberCount > 0) {
      throw Errors.roleHasMembers();
    }

    const event = await prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: existing.id } });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: existing.groupId,
          actorUserId: null,
          action: "role.deleted",
          targetId: existing.id,
          payload: {
            name: existing.name,
            priority: existing.priority,
            color: existing.color,
            isDefault: existing.isDefault,
          } as Prisma.InputJsonValue,
        },
      });
      return stageEvent<RoleDeletedEvent>(tx, {
        type: "role.deleted",
        gameId: gameId as GameId,
        groupId: existing.groupId as GroupId,
        roleId: existing.id as RoleId,
      });
    });
    permissionCache.invalidateGroup(existing.groupId);

    publishStagedEvents(hub, event);

    return c.body(null, 204);
  };
}

// `description` is on the wire as a nullable field even though no V1
// endpoint populates it, so a future write path can add values without
// breaking consumers.
export interface WireAdminPermissionDef {
  key: string;
  description: string | null;
  createdAt: string;
}

// Idempotent on already-granted. First sight of a key auto-registers
// `PermissionDef`; revoke does NOT unregister (catalog is monotonic).
export function grantAdminRolePermissionHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const roleId = c.req.param("roleId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!roleId) throw Errors.badRequest("roleId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = adminGrantPermissionBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { permission } = parsed.data;

    const role = await loadAdminScopedRole(prisma, gameId, roleId);

    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionKey: { roleId: role.id, permissionKey: permission } },
    });
    if (existing) {
      const permissions = await loadAdminRolePermissionKeys(prisma, role.id);
      return c.json<WireAdminRole>(toWireAdminRole(role, permissions));
    }

    const event = await prisma
      .$transaction(async (tx) => {
        await tx.permissionDef.upsert({
          where: { gameId_key: { gameId, key: permission } },
          create: { gameId, key: permission },
          update: {},
        });
        await tx.rolePermission.create({
          data: { roleId: role.id, permissionKey: permission },
        });
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: role.groupId,
            actorUserId: null,
            action: "permission.granted",
            targetId: role.id,
            payload: {
              roleId: role.id,
              permission,
            } as Prisma.InputJsonValue,
          },
        });
        return stageEvent<PermissionGrantedEvent>(tx, {
          type: "permission.granted",
          gameId: gameId as GameId,
          groupId: role.groupId as GroupId,
          roleId: role.id as RoleId,
          permission: permission as PermissionKey,
        });
      })
      .catch((err) => {
        // Loser of a concurrent duplicate grant: the winner's row
        // landed after the idempotency check above. Same answer the
        // sequential second caller gets (current role snapshot, no
        // event); the rollback drops the staged delivery and audit row.
        if (isUniqueViolation(err)) return null;
        throw err;
      });
    if (event) {
      permissionCache.invalidateGroup(role.groupId);
      publishStagedEvents(hub, event);
    }

    const permissions = await loadAdminRolePermissionKeys(prisma, role.id);
    return c.json<WireAdminRole>(toWireAdminRole(role, permissions));
  };
}

// Idempotent on already-revoked / never-granted. PermissionDef registry
// is preserved.
export function revokeAdminRolePermissionHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const roleId = c.req.param("roleId");
    const permission = c.req.param("permission");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!roleId) throw Errors.badRequest("roleId is required");
    if (!permission) throw Errors.badRequest("permission must not be empty");

    const role = await loadAdminScopedRole(prisma, gameId, roleId);

    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionKey: { roleId: role.id, permissionKey: permission } },
    });
    if (!existing) {
      const permissions = await loadAdminRolePermissionKeys(prisma, role.id);
      return c.json<WireAdminRole>(toWireAdminRole(role, permissions));
    }

    const event = await prisma.$transaction(async (tx) => {
      await tx.rolePermission.delete({
        where: { roleId_permissionKey: { roleId: role.id, permissionKey: permission } },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "permission.revoked",
          targetId: role.id,
          payload: {
            roleId: role.id,
            permission,
          } as Prisma.InputJsonValue,
        },
      });
      return stageEvent<PermissionRevokedEvent>(tx, {
        type: "permission.revoked",
        gameId: gameId as GameId,
        groupId: role.groupId as GroupId,
        roleId: role.id as RoleId,
        permission: permission as PermissionKey,
      });
    });
    permissionCache.invalidateGroup(role.groupId);

    publishStagedEvents(hub, event);

    const permissions = await loadAdminRolePermissionKeys(prisma, role.id);
    return c.json<WireAdminRole>(toWireAdminRole(role, permissions));
  };
}

// PermissionDef rows are auto-registered by every grant + override
// route. Revoke does NOT remove the row; the catalog is monotonic per
// game so the matrix-tab column list never shrinks across a game's
// lifetime. A future cleanup endpoint could prune unused defs.
export function listAdminGamePermissionsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const game = await prisma.game.findUnique({ where: { id: gameId } });
    if (!game) throw Errors.notFound("game");

    const defs = await prisma.permissionDef.findMany({
      where: { gameId },
      orderBy: { key: "asc" },
    });
    return c.json<WireAdminPermissionDef[]>(
      defs.map((d) => ({
        key: d.key,
        description: d.description,
        createdAt: d.createdAt.toISOString(),
      })),
    );
  };
}

// Reuses `WireAuditEntry` (not `WireAdminAuditEntry`) because the
// dashboard's group detail page already knows gameId / groupId from URL
// context, so the cross-game-name fields would be dead weight here.
//
// 404 on soft-deleted groups: cross-game recent-audit at `/v1/admin/audit`
// is the surface for soft-deleted-group activity.
export function listAdminGroupAuditHandler(prisma: PrismaClient): Handler {
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

    const parsed = listAuditQuery.safeParse({
      limit: c.req.query("limit"),
      before: c.req.query("before"),
      actions: c.req.queries("actions"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, before, actions } = parsed.data;

    const where: Prisma.AuditEntryWhereInput = {
      groupId: group.id,
      AND: [await auditBeforeFilter(prisma, before, { groupId: group.id })],
      ...(actions && actions.length > 0 ? { action: { in: actions } } : {}),
    };

    const entries = await prisma.auditEntry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = entries.length > limit;
    const sliced = hasMore ? entries.slice(0, limit) : entries;
    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return c.json<{ items: WireAuditEntry[]; nextCursor: string | null }>({
      items: sliced.map(serializeAuditEntry),
      nextCursor,
    });
  };
}

// Reuses `WireAdminAuditEntry`: the per-game audit page spans multiple
// groups, so it needs the `groupName` + `groupSoftDeleted` columns the
// home feed already carries.
export interface WireAdminGameAuditPage {
  items: WireAdminAuditEntry[];
  nextCursor: string | null;
}

// Soft-deleted-group entries ARE included (the audit log preserves
// history regardless of lifecycle); each row carries `groupSoftDeleted`
// so the dashboard can mark them. This is the key behavior difference
// from the per-group audit route, which 404s on soft-deleted groups.
//
// `actorUserId` filter is exact-match against the internal `JunjoUser.id`;
// `targetId` is exact against whatever the writing route stored
// (external user id / member id / role id depending on the route).
export function listAdminGameAuditHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const parsed = listAdminGameAuditQuery.safeParse({
      limit: c.req.query("limit"),
      before: c.req.query("before"),
      since: c.req.query("since"),
      actions: c.req.queries("actions"),
      actorUserId: c.req.query("actorUserId"),
      targetId: c.req.query("targetId"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, before, since, actions, actorUserId, targetId } = parsed.data;

    // Filter on the denormalized AuditEntry.gameId so game-scoped rows
    // (groupId=null) appear in the per-game admin feed alongside per-
    // group rows. The prior `group: { gameId }` join would have hidden
    // the null-groupId rows.
    const where: Prisma.AuditEntryWhereInput = {
      gameId,
      AND: [await auditBeforeFilter(prisma, before, { gameId })],
      ...(since ? { createdAt: { gte: new Date(since) } } : {}),
      ...(actions && actions.length > 0 ? { action: { in: actions } } : {}),
      ...(actorUserId ? { actorUserId } : {}),
      ...(targetId ? { targetId } : {}),
    };

    const rows = await prisma.auditEntry.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      include: {
        game: { select: { name: true } },
        group: { select: { name: true, softDeletedAt: true } },
      },
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return c.json<WireAdminGameAuditPage>({
      items: sliced.map(serializeAdminAuditEntry),
      nextCursor,
    });
  };
}

// Throws `Errors.notFound("group")` if either side is missing, in
// another game, or soft-deleted.
async function loadAdminScopedGroupPair(
  prisma: PrismaClient,
  gameId: string,
  ids: [string, string],
): Promise<void> {
  const groups = await prisma.group.findMany({
    where: { id: { in: ids }, gameId, softDeletedAt: null },
    select: { id: true },
  });
  if (groups.length !== 2) throw Errors.notFound("group");
}

// Idempotent per direction (matching `type` is a no-op: no DB write, no
// audit, no `since` bump). The audit entry lives on the *origin* group's
// log; mutual writes can produce up to two audit entries.
export function setAdminGroupRelationshipHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const a = c.req.param("a");
    const b = c.req.param("b");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!a) throw Errors.badRequest("groupA id is required");
    if (!b) throw Errors.badRequest("groupB id is required");

    if (a === b) throw Errors.badRequest("groupAId and groupBId must differ");

    const json = await c.req.json().catch(() => null);
    const parsed = adminSetRelationshipBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { type, mutual } = parsed.data;

    await loadAdminScopedGroupPair(prisma, gameId, [a, b]);

    const directions: Array<{ aId: string; bId: string }> = [{ aId: a, bId: b }];
    if (mutual) directions.push({ aId: b, bId: a });

    const result = await prisma.$transaction(async (tx) => {
      let primary: GroupRelationship | null = null;
      const events: GroupRelationshipChangedEvent[] = [];
      for (const dir of directions) {
        const existing = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
        });
        if (existing && existing.type === type) {
          if (dir.aId === a) primary = existing;
          continue;
        }

        const upserted = await tx.groupRelationship.upsert({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
          create: { groupAId: dir.aId, groupBId: dir.bId, type, setByUserId: null },
          update: { type, since: new Date() },
        });
        if (dir.aId === a) primary = upserted;

        const auditPayload: Record<string, unknown> = {
          groupAId: dir.aId,
          groupBId: dir.bId,
          type,
          mutual: mutual === true,
        };
        if (existing) auditPayload.before = { type: existing.type };
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: dir.aId,
            actorUserId: null,
            action: "group.relationship.set",
            targetId: dir.bId,
            payload: auditPayload as Prisma.InputJsonValue,
          },
        });
        events.push(
          await stageEvent<GroupRelationshipChangedEvent>(tx, {
            type: "group.relationship.changed",
            gameId: gameId as GameId,
            groupId: upserted.groupAId as GroupId,
            otherGroupId: upserted.groupBId as GroupId,
            relationship: toPublicGroupRelationship(upserted),
          }),
        );
      }
      if (!primary) {
        const reloaded = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: a, groupBId: b } },
        });
        if (!reloaded) throw new Error("relationship row missing after no-op upsert");
        primary = reloaded;
      }
      return { primary, events };
    });

    publishStagedEvents(hub, ...result.events);

    return c.json<WireGroupRelationship>(serializeGroupRelationship(result.primary));
  };
}

// Idempotent on missing rows (no audit, no event, 204). Each direction
// is independent under `?mutual=true`.
export function clearAdminGroupRelationshipHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const a = c.req.param("a");
    const b = c.req.param("b");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!a) throw Errors.badRequest("groupA id is required");
    if (!b) throw Errors.badRequest("groupB id is required");

    const parsedQuery = adminClearRelationshipQuery.safeParse({
      mutual: c.req.query("mutual"),
    });
    if (!parsedQuery.success) {
      const issues = parsedQuery.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const mutual = parsedQuery.data.mutual === "true";

    if (a === b) throw Errors.badRequest("groupAId and groupBId must differ");

    await loadAdminScopedGroupPair(prisma, gameId, [a, b]);

    const directions: Array<{ aId: string; bId: string }> = [{ aId: a, bId: b }];
    if (mutual) directions.push({ aId: b, bId: a });

    const stagedEvents = await prisma.$transaction(async (tx) => {
      const events: GroupRelationshipChangedEvent[] = [];
      for (const dir of directions) {
        const existing = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
        });
        if (!existing) continue;

        // Guarded delete: a racing clear removes the row between the
        // findUnique and the delete; the loser matches zero rows and
        // skips the audit/event for this direction, same as a
        // sequential second caller (idempotent 204).
        const deleted = await tx.groupRelationship.deleteMany({
          where: { groupAId: dir.aId, groupBId: dir.bId },
        });
        if (deleted.count === 0) continue;
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: dir.aId,
            actorUserId: null,
            action: "group.relationship.cleared",
            targetId: dir.bId,
            payload: {
              groupAId: dir.aId,
              groupBId: dir.bId,
              type: existing.type,
              mutual,
            } as Prisma.InputJsonValue,
          },
        });
        events.push(
          await stageEvent<GroupRelationshipChangedEvent>(tx, {
            type: "group.relationship.changed",
            gameId: gameId as GameId,
            groupId: dir.aId as GroupId,
            otherGroupId: dir.bId as GroupId,
            relationship: null,
          }),
        );
      }
      return events;
    });

    publishStagedEvents(hub, ...stagedEvents);

    return c.body(null, 204);
  };
}

// Cross-game lookups collapse to 404; self-relationship lookups also
// 404 (the row cannot exist).
export function getAdminGroupRelationshipHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const a = c.req.param("a");
    const b = c.req.param("b");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!a) throw Errors.badRequest("groupA id is required");
    if (!b) throw Errors.badRequest("groupB id is required");

    if (a === b) throw Errors.notFound("relationship");

    const groups = await prisma.group.findMany({
      where: { id: { in: [a, b] }, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (groups.length !== 2) throw Errors.notFound("relationship");

    const rel = await prisma.groupRelationship.findUnique({
      where: { groupAId_groupBId: { groupAId: a, groupBId: b } },
    });
    if (!rel) throw Errors.notFound("relationship");

    return c.json<WireGroupRelationship>(serializeGroupRelationship(rel));
  };
}

// Returns the A-side ("outgoing stance") only; the B-side ("incoming")
// would be a future `?direction=incoming` additive filter.
export function listAdminGroupRelationshipsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const a = c.req.param("a");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!a) throw Errors.badRequest("groupA id is required");

    const group = await prisma.group.findFirst({
      where: { id: a, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");

    const rels = await prisma.groupRelationship.findMany({
      where: { groupAId: group.id },
      orderBy: { groupBId: "asc" },
    });

    return c.json<WireGroupRelationship[]>(rels.map(serializeGroupRelationship));
  };
}

// Cycle detection walks the candidate parent's ancestor chain bounded
// at `MAX_PARENT_DEPTH = 100` (see parentCycle.ts); self-parent and any cycle 400
// `parent_cycle`. Dispatches `group.updated` (there is no dedicated
// `GroupParentChangedEvent` in the union).
export function setAdminGroupParentHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = adminSetParentBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { parentGroupId } = parsed.data;

    const { row, memberCount } = await setGroupParentSafely(prisma, hub, {
      gameId,
      groupId,
      parentGroupId,
    });
    return c.json<WireAdminGroup>(toWireAdminGroup(row, memberCount));
  };
}

// Admin counterpart to the per-game `PATCH /v1/groups/:id`. Same field
// set (name, visibility, metadata, defaultRoleId, passcode), same audit
// shape (group.updated row + a dedicated group.passcode.set/cleared row
// when the passcode transitions), and the same group.updated webhook
// fires so SSE subscribers see the change regardless of whether the
// edit came from a per-game key or the admin dashboard.
export function updateAdminGroupHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const json = await c.req.json().catch(() => null);
    const parsed = updateAdminGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    // Hash outside the transaction (scrypt is intentionally slow).
    const newPasscodeHash =
      body.passcode === undefined
        ? undefined
        : body.passcode === null
          ? null
          : await hashSecret(body.passcode);

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.group.findFirst({
        where: { id: groupId, gameId, softDeletedAt: null },
      });
      if (!existing) throw Errors.notFound("group");

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.GroupUpdateInput = {};
      let passcodeTransition: "set" | "cleared" | "rotated" | null = null;

      if (body.name !== undefined && body.name !== existing.name) {
        before.name = existing.name;
        after.name = body.name;
        data.name = body.name;
      }
      if (body.visibility !== undefined && body.visibility !== existing.visibility) {
        before.visibility = existing.visibility;
        after.visibility = body.visibility;
        data.visibility = body.visibility;
      }
      if (body.metadata !== undefined) {
        before.metadata = (existing.metadata ?? {}) as Prisma.InputJsonValue;
        after.metadata = body.metadata;
        data.metadata = body.metadata as Prisma.InputJsonValue;
      }
      if (body.defaultRoleId !== undefined && body.defaultRoleId !== existing.defaultRoleId) {
        before.defaultRoleId = existing.defaultRoleId;
        after.defaultRoleId = body.defaultRoleId;
        data.defaultRoleId = body.defaultRoleId;
      }
      if (newPasscodeHash !== undefined) {
        const hadPasscode = existing.passcodeHash !== null;
        const willHavePasscode = newPasscodeHash !== null;
        if (hadPasscode || willHavePasscode) {
          before.hasPasscode = hadPasscode;
          after.hasPasscode = willHavePasscode;
          data.passcodeHash = newPasscodeHash;
          data.passcodeSetAt = willHavePasscode ? new Date() : null;
          passcodeTransition = willHavePasscode ? (hadPasscode ? "rotated" : "set") : "cleared";
        }
      }

      if (Object.keys(data).length === 0) {
        return { row: existing, event: null, memberCount: null };
      }

      const result = await tx.group.update({
        where: { id: existing.id },
        data,
      });

      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: result.id,
          actorUserId: null,
          action: "group.updated",
          targetId: result.id,
          payload: { before, after } as Prisma.InputJsonValue,
        },
      });

      if (passcodeTransition) {
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: result.id,
            actorUserId: null,
            action:
              passcodeTransition === "cleared" ? "group.passcode.cleared" : "group.passcode.set",
            targetId: result.id,
            payload: { transition: passcodeTransition } as Prisma.InputJsonValue,
          },
        });
      }

      // Counted inside the transaction so the staged group.updated
      // payload reflects the committed row.
      const memberCount = await tx.groupMember.count({
        where: { groupId: result.id, status: "active" },
      });
      const event = await stageEvent<GroupUpdatedEvent>(tx, {
        type: "group.updated",
        gameId: gameId as GameId,
        groupId: result.id as GroupId,
        group: toPublicGroup(result, memberCount),
      });

      return { row: result, event, memberCount };
    });

    const memberCount =
      updated.memberCount ??
      (await prisma.groupMember.count({
        where: { groupId: updated.row.id, status: "active" },
      }));
    if (updated.event) {
      publishStagedEvents(hub, updated.event);
    }
    return c.json<WireAdminGroup>(toWireAdminGroup(updated.row, memberCount));
  };
}

// Direct children only; grandchildren are NOT recursed. `memberCount`
// per child comes from a single batched `groupBy` to avoid N round-trips.
export function listAdminGroupChildrenHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    const groupId = c.req.param("groupId");
    if (!gameId) throw Errors.badRequest("gameId is required");
    if (!groupId) throw Errors.badRequest("groupId is required");

    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");

    const children = await prisma.group.findMany({
      where: { parentGroupId: group.id, gameId, softDeletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (children.length === 0) return c.json<WireAdminGroup[]>([]);

    const counts = await batchActiveMemberCounts(
      prisma,
      children.map((g) => g.id),
    );

    return c.json<WireAdminGroup[]>(
      children.map((g) => toWireAdminGroup(g, counts.get(g.id) ?? 0)),
    );
  };
}

export interface CheckAdminPermissionHandlerOptions {
  cache?: PermissionCache;
}

// Shares the singleton `permissionCache` with the per-game route so a
// dashboard poke-around hydrates the same cache the dev's runtime
// queries hit; behavior parity is essential.
//
// `gameId` scopes the cache key, so a userId from another game resolves
// to `source: "none"` rather than leaking through.
export function checkAdminPermissionHandler(
  prisma: PrismaClient,
  opts: CheckAdminPermissionHandlerOptions = {},
): Handler {
  const cache = opts.cache ?? permissionCache;
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const parsed = adminCheckPermissionQuery.safeParse({
      userId: c.req.query("userId"),
      groupId: c.req.query("groupId"),
      permission: c.req.query("permission"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { userId, groupId, permission } = parsed.data;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");

    const cached = cache.get(gameId, group.id, userId, permission);
    if (cached) return c.json(cached);

    const result = await resolvePermission(prisma, gameId, group.id, userId, permission);
    cache.set(gameId, group.id, userId, permission, result);
    return c.json(result);
  };
}

// Cohort-shaped: the date window applies to `Group.createdAt`, NOT to
// the departures' timestamps. A group created today with a year-old
// departure counts; a year-old group with a today departure does not.
// This answers "how does churn look for the cohort of groups born in
// this window?".
//
// Tenure (`leftAt - joinedAt`) is computed in JS rather than SQL so bin
// boundaries stay readable.
export interface WireAdminGroupChurnBin {
  label: string;
  minMs: number | null;
  maxMs: number | null;
  count: number;
}

export interface WireAdminGroupChurn {
  from: string | null;
  to: string | null;
  totalGroupsInWindow: number;
  totalDeparturesInWindow: number;
  bins: WireAdminGroupChurnBin[];
}

function pickChurnBin(tenureMs: number): number {
  // Negative tenures (clock skew between joinedAt and leftAt) clamp to
  // bin 0 so the histogram never silently drops a row.
  if (!Number.isFinite(tenureMs) || tenureMs < 0) return 0;
  for (let i = 0; i < ANALYTICS_GROUP_CHURN_BINS.length; i += 1) {
    const bin = ANALYTICS_GROUP_CHURN_BINS[i];
    if (!bin) continue;
    const { minMs, maxMs } = bin;
    if (minMs !== null && tenureMs < minMs) continue;
    if (maxMs !== null && tenureMs >= maxMs) continue;
    return i;
  }
  // Unreachable: the last bin's `maxMs: null` always matches.
  return ANALYTICS_GROUP_CHURN_BINS.length - 1;
}

export function getGroupChurnHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const parsed = groupChurnQuery.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { from, to } = parsed.data;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const createdAtFilter: Prisma.DateTimeFilter = {};
    if (from) createdAtFilter.gte = new Date(from);
    if (to) createdAtFilter.lt = new Date(to);

    const groups = await prisma.group.findMany({
      where: {
        gameId,
        softDeletedAt: null,
        ...(from || to ? { createdAt: createdAtFilter } : {}),
      },
      select: { id: true },
    });

    const counts = ANALYTICS_GROUP_CHURN_BINS.map(() => 0);
    let totalDepartures = 0;

    if (groups.length > 0) {
      const departures = await prisma.groupMember.findMany({
        where: {
          groupId: { in: groups.map((g) => g.id) },
          status: { in: ["left", "kicked"] },
          leftAt: { not: null },
        },
        select: { joinedAt: true, leftAt: true },
      });

      for (const d of departures) {
        if (d.leftAt === null) continue;
        const tenureMs = d.leftAt.getTime() - d.joinedAt.getTime();
        const idx = pickChurnBin(tenureMs);
        const cur = counts[idx];
        if (cur === undefined) continue;
        counts[idx] = cur + 1;
        totalDepartures += 1;
      }
    }

    return c.json<WireAdminGroupChurn>({
      from: from ?? null,
      to: to ?? null,
      totalGroupsInWindow: groups.length,
      totalDeparturesInWindow: totalDepartures,
      bins: ANALYTICS_GROUP_CHURN_BINS.map((bin, i) => ({
        label: bin.label,
        minMs: bin.minMs,
        maxMs: bin.maxMs,
        count: counts[i] ?? 0,
      })),
    });
  };
}

// "Active at T" = `joinedAt <= T` AND (`leftAt IS NULL` OR `leftAt > T`).
// Status is intentionally NOT consulted: a member who was active at T
// and kicked at T+1 still counts at T. Reading status would double-
// filter and produce wrong historical counts.
//
// Groups rank by active count at the window's `to` boundary; the
// `ADMIN_GROUP_GROWTH_MAX_BUCKETS` cap bounds work for pathological
// custom windows.
export interface WireAdminGroupGrowthSeries {
  key: string;
  name: string;
  groupId: string | null;
  data: number[];
}

export interface WireAdminGroupGrowth {
  from: string;
  to: string;
  bucketSizeMs: number;
  buckets: string[];
  series: WireAdminGroupGrowthSeries[];
}

const GROWTH_ONE_HOUR_MS = 60 * 60 * 1000;
const GROWTH_ONE_DAY_MS = 24 * GROWTH_ONE_HOUR_MS;
const GROWTH_ONE_WEEK_MS = 7 * GROWTH_ONE_DAY_MS;
const GROWTH_ONE_MONTH_MS = 30 * GROWTH_ONE_DAY_MS;

// Targets ~25 boundaries for the dashboard's preset windows. The caller
// still enforces `ADMIN_GROUP_GROWTH_MAX_BUCKETS` because a custom window
// can pick a small bucket size and blow past the cap.
function pickGrowthBucketSizeMs(windowMs: number): number {
  if (windowMs <= GROWTH_ONE_DAY_MS) return GROWTH_ONE_HOUR_MS;
  if (windowMs <= GROWTH_ONE_WEEK_MS) return 6 * GROWTH_ONE_HOUR_MS;
  if (windowMs <= GROWTH_ONE_MONTH_MS) return GROWTH_ONE_DAY_MS;
  if (windowMs <= 90 * GROWTH_ONE_DAY_MS) return 3 * GROWTH_ONE_DAY_MS;
  return GROWTH_ONE_WEEK_MS;
}

interface GrowthMemberRow {
  groupId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

function countActiveAtForGroup(rows: GrowthMemberRow[], tMs: number): number {
  let count = 0;
  for (const row of rows) {
    if (row.joinedAt.getTime() > tMs) continue;
    if (row.leftAt !== null && row.leftAt.getTime() <= tMs) continue;
    count += 1;
  }
  return count;
}

export function getGroupGrowthHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const parsed = groupGrowthQuery.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
      topN: c.req.query("topN"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { from, to, topN } = parsed.data;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const now = Date.now();
    const toMs = to ? Date.parse(to) : now;
    const fromMs = from ? Date.parse(from) : toMs - ADMIN_GROUP_GROWTH_DEFAULT_WINDOW_MS;
    if (fromMs >= toMs) {
      throw Errors.badRequest("from must be earlier than to");
    }
    const windowMs = toMs - fromMs;
    const bucketSizeMs = pickGrowthBucketSizeMs(windowMs);
    const bucketCount = Math.floor(windowMs / bucketSizeMs) + 1;
    if (bucketCount > ADMIN_GROUP_GROWTH_MAX_BUCKETS) {
      throw Errors.badRequest(
        `window is too wide for the chosen bucket size; would emit ${bucketCount} buckets (max ${ADMIN_GROUP_GROWTH_MAX_BUCKETS}). Narrow the window or wait for finer-grained controls.`,
      );
    }

    const bucketTimestamps: number[] = [];
    for (let i = 0; i < bucketCount; i += 1) {
      bucketTimestamps.push(fromMs + i * bucketSizeMs);
    }

    const groups = await prisma.group.findMany({
      where: { gameId, softDeletedAt: null },
      select: { id: true, name: true },
      orderBy: { id: "asc" },
    });

    if (groups.length === 0) {
      return c.json<WireAdminGroupGrowth>({
        from: new Date(fromMs).toISOString(),
        to: new Date(toMs).toISOString(),
        bucketSizeMs,
        buckets: bucketTimestamps.map((t) => new Date(t).toISOString()),
        series: [],
      });
    }

    // Every member whose active interval overlaps the window. Status is
    // NOT filtered (see the resolver-vs-historical note above the type).
    const members = await prisma.groupMember.findMany({
      where: {
        groupId: { in: groups.map((g) => g.id) },
        joinedAt: { lte: new Date(toMs) },
        OR: [{ leftAt: null }, { leftAt: { gt: new Date(fromMs) } }],
      },
      select: { groupId: true, joinedAt: true, leftAt: true },
    });

    const rowsByGroup = new Map<string, GrowthMemberRow[]>();
    for (const g of groups) {
      rowsByGroup.set(g.id, []);
    }
    for (const m of members) {
      const bucket = rowsByGroup.get(m.groupId);
      if (!bucket) continue;
      bucket.push({ groupId: m.groupId, joinedAt: m.joinedAt, leftAt: m.leftAt });
    }

    const perGroupCounts = new Map<string, number[]>();
    const endCounts = new Map<string, number>();
    for (const g of groups) {
      const rows = rowsByGroup.get(g.id) ?? [];
      const counts: number[] = [];
      for (const t of bucketTimestamps) {
        counts.push(countActiveAtForGroup(rows, t));
      }
      perGroupCounts.set(g.id, counts);
      endCounts.set(g.id, countActiveAtForGroup(rows, toMs));
    }

    const ranked = [...groups].sort((a, b) => {
      const ca = endCounts.get(a.id) ?? 0;
      const cb = endCounts.get(b.id) ?? 0;
      if (ca !== cb) return cb - ca;
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });

    const top = ranked.slice(0, topN);
    const rest = ranked.slice(topN);

    const series: WireAdminGroupGrowthSeries[] = top.map((g) => ({
      key: `group:${g.id}`,
      name: g.name,
      groupId: g.id,
      data: perGroupCounts.get(g.id) ?? bucketTimestamps.map(() => 0),
    }));

    if (rest.length > 0) {
      const aggregate = bucketTimestamps.map(() => 0);
      for (const g of rest) {
        const counts = perGroupCounts.get(g.id) ?? [];
        for (let i = 0; i < aggregate.length; i += 1) {
          const cur = aggregate[i] ?? 0;
          const add = counts[i] ?? 0;
          aggregate[i] = cur + add;
        }
      }
      series.push({
        key: "all-others",
        name: "All others",
        groupId: null,
        data: aggregate,
      });
    }

    return c.json<WireAdminGroupGrowth>({
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      bucketSizeMs,
      buckets: bucketTimestamps.map((t) => new Date(t).toISOString()),
      series,
    });
  };
}

// Soft-deleted-group entries are INCLUDED (this answers an activity-
// volume question, not a cohort question; the audit log preserves
// history regardless of group lifecycle).
//
// Aggregation runs in Postgres via `$queryRaw` so the response is bounded
// at 168 rows regardless of source-data size. Pulling every audit row
// over the wire would scale poorly with audit volume.
export interface WireAdminMemberActivity {
  from: string | null;
  to: string | null;
  totalEvents: number;
  cells: number[][];
}

export function getMemberActivityHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const parsed = memberActivityQuery.safeParse({
      from: c.req.query("from"),
      to: c.req.query("to"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { from, to } = parsed.data;

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    // The dashboard renders even all-zero grids (gated on
    // `totalEvents === 0` for the empty-state callout), so cell count
    // must always be deterministic.
    const cells: number[][] = [];
    for (let d = 0; d < ANALYTICS_MEMBER_ACTIVITY_DAYS; d += 1) {
      cells.push(new Array<number>(ANALYTICS_MEMBER_ACTIVITY_HOURS).fill(0));
    }

    const fromCondition = from ? Prisma.sql`AND ae."createdAt" >= ${new Date(from)}` : Prisma.empty;
    const toCondition = to ? Prisma.sql`AND ae."createdAt" < ${new Date(to)}` : Prisma.empty;

    // `::int4` casts on EXTRACT and COUNT(*) so the pg driver maps them
    // to JS numbers; without the cast, COUNT(*) returns bigint and JS
    // arithmetic downstream gets clumsy.
    const rows = await prisma.$queryRaw<Array<{ dow: number; hour: number; count: number }>>`
      SELECT
        EXTRACT(DOW FROM ae."createdAt")::int AS dow,
        EXTRACT(HOUR FROM ae."createdAt")::int AS hour,
        COUNT(*)::int AS count
      FROM "AuditEntry" ae
      INNER JOIN "Group" g ON g."id" = ae."groupId"
      WHERE g."gameId" = ${gameId}
      ${fromCondition}
      ${toCondition}
      GROUP BY 1, 2
    `;

    let totalEvents = 0;
    for (const row of rows) {
      // Defensive bounds checks; a malformed EXTRACT row would silently
      // corrupt the grid otherwise.
      const dow = Number(row.dow);
      const hour = Number(row.hour);
      const count = Number(row.count);
      if (!Number.isInteger(dow) || dow < 0 || dow >= ANALYTICS_MEMBER_ACTIVITY_DAYS) continue;
      if (!Number.isInteger(hour) || hour < 0 || hour >= ANALYTICS_MEMBER_ACTIVITY_HOURS) continue;
      if (!Number.isFinite(count) || count < 0) continue;
      const dayRow = cells[dow];
      if (!dayRow) continue;
      dayRow[hour] = count;
      totalEvents += count;
    }

    return c.json<WireAdminMemberActivity>({
      from: from ?? null,
      to: to ?? null,
      totalEvents,
      cells,
    });
  };
}

// Aggregates by role name (two groups with an "Officer" role contribute
// to the same slice). Only `active` assignments contribute (active-set
// semantics, matching `Group.memberCount`). No date window: this answers
// "what is deployed right now?", not "what was assigned in this window?".
export interface WireAdminRoleSlice {
  name: string;
  count: number;
}

export interface WireAdminRoleDistribution {
  totalAssignments: number;
  uniqueRoleNames: number;
  topRoles: WireAdminRoleSlice[];
  otherCount: number;
}

export function getRoleDistributionHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const roles = await prisma.role.findMany({
      where: { group: { gameId, softDeletedAt: null } },
      select: { id: true, name: true },
    });

    if (roles.length === 0) {
      return c.json<WireAdminRoleDistribution>({
        totalAssignments: 0,
        uniqueRoleNames: 0,
        topRoles: [],
        otherCount: 0,
      });
    }

    const counts = await prisma.memberRole.groupBy({
      by: ["roleId"],
      where: {
        roleId: { in: roles.map((r) => r.id) },
        groupMember: { status: "active" },
      },
      _count: { _all: true },
    });

    const countByRoleId = new Map<string, number>();
    for (const row of counts) {
      countByRoleId.set(row.roleId, row._count._all);
    }

    const countByName = new Map<string, number>();
    for (const role of roles) {
      const c = countByRoleId.get(role.id) ?? 0;
      if (c === 0) continue;
      countByName.set(role.name, (countByName.get(role.name) ?? 0) + c);
    }

    const sorted = Array.from(countByName.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const top = sorted.slice(0, ADMIN_ROLE_DISTRIBUTION_TOP_N);
    const rest = sorted.slice(ADMIN_ROLE_DISTRIBUTION_TOP_N);

    const totalAssignments = sorted.reduce((acc, s) => acc + s.count, 0);
    const otherCount = rest.reduce((acc, s) => acc + s.count, 0);

    return c.json<WireAdminRoleDistribution>({
      totalAssignments,
      uniqueRoleNames: sorted.length,
      topRoles: top,
      otherCount,
    });
  };
}

// Counts ALL `MemberPermissionOverride` rows regardless of member
// status: operator-authored config exists independently of member
// lifecycle, and an override on a kicked member is still a
// deployment-state fact about the game.
export interface WireAdminPermissionUsageItem {
  permission: string;
  roleGrants: number;
  memberOverrides: number;
  total: number;
}

export interface WireAdminPermissionUsage {
  totalCount: number;
  uniqueKeys: number;
  items: WireAdminPermissionUsageItem[];
  otherCount: number;
}

export function getPermissionUsageHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.req.param("gameId");
    if (!gameId) throw Errors.badRequest("gameId is required");

    const game = await prisma.game.findUnique({
      where: { id: gameId },
      select: { id: true },
    });
    if (!game) throw Errors.notFound("game");

    const [roleGrants, overrides] = await Promise.all([
      prisma.rolePermission.groupBy({
        by: ["permissionKey"],
        where: { role: { group: { gameId, softDeletedAt: null } } },
        _count: { _all: true },
      }),
      prisma.memberPermissionOverride.groupBy({
        by: ["permissionKey"],
        where: { groupMember: { group: { gameId, softDeletedAt: null } } },
        _count: { _all: true },
      }),
    ]);

    const byKey = new Map<string, { roleGrants: number; memberOverrides: number }>();
    for (const row of roleGrants) {
      const cur = byKey.get(row.permissionKey) ?? { roleGrants: 0, memberOverrides: 0 };
      cur.roleGrants += row._count._all;
      byKey.set(row.permissionKey, cur);
    }
    for (const row of overrides) {
      const cur = byKey.get(row.permissionKey) ?? { roleGrants: 0, memberOverrides: 0 };
      cur.memberOverrides += row._count._all;
      byKey.set(row.permissionKey, cur);
    }

    const sorted = Array.from(byKey.entries())
      .map(([permission, c]) => ({
        permission,
        roleGrants: c.roleGrants,
        memberOverrides: c.memberOverrides,
        total: c.roleGrants + c.memberOverrides,
      }))
      .filter((row) => row.total > 0)
      .sort((a, b) => b.total - a.total || a.permission.localeCompare(b.permission));

    const top = sorted.slice(0, ADMIN_PERMISSION_USAGE_TOP_N);
    const rest = sorted.slice(ADMIN_PERMISSION_USAGE_TOP_N);

    const totalCount = sorted.reduce((acc, r) => acc + r.total, 0);
    const otherCount = rest.reduce((acc, r) => acc + r.total, 0);

    return c.json<WireAdminPermissionUsage>({
      totalCount,
      uniqueKeys: sorted.length,
      items: top,
      otherCount,
    });
  };
}
