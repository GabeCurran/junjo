import type { GroupId, PermissionCheckResult, RoleId } from "@junjo.io/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { type PermissionCache, permissionCache } from "../permissionCache.js";
import { MAX_PARENT_DEPTH } from "./groups.schema.js";
import { checkPermissionBatchBody, checkPermissionQuery } from "./permissions.schema.js";

type PermissionsClient = PrismaClient | Prisma.TransactionClient;

// Memoizes external userId -> JunjoUser id for the span of one request.
// A batch repeats the same userId across most of its entries and an
// inherited walk repeats it at every level; without this each repeat is
// another identity lookup.
export class IdentityMemo {
  private readonly entries = new Map<string, string | null>();

  constructor(
    private readonly prisma: PermissionsClient,
    private readonly gameId: string,
  ) {}

  async resolve(externalUserId: string): Promise<string | null> {
    const hit = this.entries.get(externalUserId);
    if (hit !== undefined) return hit;
    const id = await findJunjoUserId(this.prisma, this.gameId, externalUserId);
    this.entries.set(externalUserId, id);
    return id;
  }
}

// Memoizes one (group, user, permission) resolution for the span of a
// request. A batch of sibling groups shares its ancestors, so without
// this the walk re-resolves the same parent once per entry: 100 shops
// under one instance group resolve that instance 100 times.
//
// Request-scoped, so it cannot serve an answer across a mutation the
// way the cross-request cache can.
export class LevelMemo {
  private readonly entries = new Map<string, PermissionCheckResult>();

  // Length-prefixed for the same reason the caches are: these are
  // caller-supplied strings, and a delimiter-joined key lets one tuple
  // read another tuple's verdict.
  private key(groupId: string, externalUserId: string, permission: string): string {
    let out = "";
    for (const part of [groupId, externalUserId, permission]) out += `|${part.length}:${part}`;
    return out;
  }

  async resolve(
    groupId: string,
    externalUserId: string,
    permission: string,
    compute: () => Promise<PermissionCheckResult>,
  ): Promise<PermissionCheckResult> {
    const k = this.key(groupId, externalUserId, permission);
    const hit = this.entries.get(k);
    if (hit) return hit;
    const result = await compute();
    this.entries.set(k, result);
    return result;
  }
}

// Resolution order for one group: missing membership / non-active status
// returns `none`; an override (in either direction) wins; otherwise any
// role with the permission grants it (highest-priority role wins, ties
// broken by roleId desc for stability); finally `default`.
//
// Non-active members (`left` / `kicked` / `invited`) intentionally do
// NOT exercise permissions, even though their role rows survive the
// transition (rows are kept for audit history; the resolver gates on
// status).
async function resolveForJunjoUser(
  prisma: PermissionsClient,
  groupId: string,
  junjoUserId: string,
  permission: string,
): Promise<PermissionCheckResult> {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_junjoUserId: { groupId, junjoUserId } },
    select: { id: true, status: true },
  });
  if (!member) return { allowed: false, source: "none" };
  if (member.status !== "active") return { allowed: false, source: "none" };

  const override = await prisma.memberPermissionOverride.findUnique({
    where: {
      groupMemberId_permissionKey: { groupMemberId: member.id, permissionKey: permission },
    },
    select: { grant: true },
  });
  if (override) {
    return { allowed: override.grant, source: "override" };
  }

  const grant = await prisma.memberRole.findFirst({
    where: {
      groupMemberId: member.id,
      role: {
        rolePermissions: { some: { permissionKey: permission } },
      },
    },
    select: { roleId: true },
    orderBy: [{ role: { priority: "desc" } }, { roleId: "desc" }],
  });
  if (grant) {
    return { allowed: true, source: "role", viaRoleId: grant.roleId as RoleId };
  }

  return { allowed: false, source: "default" };
}

// Caller must enforce game scope on `groupId`; this function trusts it.
export async function resolvePermission(
  prisma: PermissionsClient,
  gameId: string,
  groupId: string,
  externalUserId: string,
  permission: string,
  identity?: IdentityMemo,
): Promise<PermissionCheckResult> {
  const junjoUserId = identity
    ? await identity.resolve(externalUserId)
    : await findJunjoUserId(prisma, gameId, externalUserId);
  if (!junjoUserId) return { allowed: false, source: "none" };
  return resolveForJunjoUser(prisma, groupId, junjoUserId, permission);
}

interface ChainRow {
  id: string;
}

// The group itself followed by its ancestors, nearest first, as one
// recursive CTE rather than a query per level. A soft-deleted or
// cross-game ancestor terminates the chain: inheritance never crosses a
// game boundary and never reads through a deleted group.
//
// `MAX_PARENT_DEPTH` bounds the recursion. Writes are cycle-checked
// (`setGroupParentSafely`), so the bound only matters against corrupted
// state; the ids are deduped for the same reason.
export async function loadAncestorChain(
  prisma: PermissionsClient,
  gameId: string,
  groupId: string,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<ChainRow[]>(
    Prisma.sql`
      WITH RECURSIVE chain AS (
        SELECT g.id, g."parentGroupId", 0 AS depth
        FROM "Group" g
        WHERE g.id = ${groupId}
          AND g."gameId" = ${gameId}
          AND g."softDeletedAt" IS NULL
        UNION ALL
        SELECT p.id, p."parentGroupId", c.depth + 1
        FROM "Group" p
        JOIN chain c ON p.id = c."parentGroupId"
        WHERE c.depth < ${MAX_PARENT_DEPTH}
          AND p."gameId" = ${gameId}
          AND p."softDeletedAt" IS NULL
      )
      SELECT id, depth FROM chain ORDER BY depth ASC
    `,
  );
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    chain.push(row.id);
  }
  return chain;
}

export interface InheritedResolution {
  result: PermissionCheckResult;
  // Every group consulted, nearest first. The cache files the answer
  // under all of them so a grant change anywhere on the chain drops it.
  consulted: string[];
}

// Walks the queried group and then its ancestors, nearest first, and
// stops at the first group that decides: an override in either
// direction, or a role that grants the key. Nearest therefore wins, so
// a child's explicit deny is not undone by a grant further up.
//
// Levels where the user is not an active member (`none`) or holds no
// grant (`default`) are inconclusive and the walk continues past them.
// If nothing on the chain decides, the queried group's own result is
// returned unchanged, which preserves the `none` / `default` distinction
// callers use to tell "not a member" from "member without the grant".
export async function resolvePermissionInherited(
  prisma: PermissionsClient,
  gameId: string,
  groupId: string,
  externalUserId: string,
  permission: string,
  identity?: IdentityMemo,
  levels?: LevelMemo,
): Promise<InheritedResolution> {
  const memo = identity ?? new IdentityMemo(prisma, gameId);
  const levelMemo = levels ?? new LevelMemo();
  const chain = await loadAncestorChain(prisma, gameId, groupId);
  const consulted: string[] = [];
  let direct: PermissionCheckResult | null = null;

  for (const levelGroupId of chain) {
    consulted.push(levelGroupId);
    const result = await levelMemo.resolve(levelGroupId, externalUserId, permission, () =>
      resolvePermission(prisma, gameId, levelGroupId, externalUserId, permission, memo),
    );
    if (direct === null) direct = result;
    if (result.source === "override" || result.source === "role") {
      return {
        result: { ...result, viaGroupId: levelGroupId as GroupId },
        consulted,
      };
    }
  }

  // An empty chain means the group vanished between the handler's
  // existence check and this walk.
  return { result: direct ?? { allowed: false, source: "none" }, consulted };
}

export interface CheckPermissionHandlerOptions {
  cache?: PermissionCache;
}

// Mutations elsewhere call `cache.invalidateGroup(groupId)` after
// committing so a stale cache flip waits at most one round-trip.
export function checkPermissionHandler(
  prisma: PrismaClient,
  opts: CheckPermissionHandlerOptions = {},
): Handler {
  const cache = opts.cache ?? permissionCache;
  return async (c) => {
    const gameId = c.var.gameId;
    const parsed = checkPermissionQuery.safeParse({
      userId: c.req.query("userId"),
      groupId: c.req.query("groupId"),
      permission: c.req.query("permission"),
      inherit: c.req.query("inherit"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { userId, groupId, permission, inherit } = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");

    const cached = cache.get(gameId, group.id, userId, permission, { inherit });
    if (cached) return c.json(cached);

    if (!inherit) {
      const result = await resolvePermission(prisma, gameId, group.id, userId, permission);
      cache.set(gameId, group.id, userId, permission, result);
      return c.json(result);
    }

    const { result, consulted } = await resolvePermissionInherited(
      prisma,
      gameId,
      group.id,
      userId,
      permission,
    );
    cache.set(gameId, group.id, userId, permission, result, {
      inherit: true,
      dependsOn: consulted.length > 0 ? consulted : [group.id],
    });
    return c.json(result);
  };
}

// Answers are positional: `results[i]` corresponds to `checks[i]`.
// Entries are resolved sequentially, sharing one identity memo and the
// same cache the single-check route uses, so a repeated triple costs a
// map lookup rather than another resolution.
//
// An unknown, soft-deleted, or out-of-game `groupId` fails the whole
// request with `404 not_found` naming the offending entry's index,
// matching the single-check route rather than burying a typo as a
// denial.
export function checkPermissionBatchHandler(
  prisma: PrismaClient,
  opts: CheckPermissionHandlerOptions = {},
): Handler {
  const cache = opts.cache ?? permissionCache;
  return async (c) => {
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = checkPermissionBatchBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { checks, inherit = false } = parsed.data;

    const requestedGroupIds = [...new Set(checks.map((check) => check.groupId))];
    const found = await prisma.group.findMany({
      where: { id: { in: requestedGroupIds }, gameId, softDeletedAt: null },
      select: { id: true },
    });
    const known = new Set(found.map((g) => g.id));
    const missingIndex = checks.findIndex((check) => !known.has(check.groupId));
    if (missingIndex !== -1) throw Errors.notFound(`group for checks[${missingIndex}]`);

    const identity = new IdentityMemo(prisma, gameId);
    const levels = new LevelMemo();
    const results: PermissionCheckResult[] = [];
    for (const check of checks) {
      const cached = cache.get(gameId, check.groupId, check.userId, check.permission, { inherit });
      if (cached) {
        results.push(cached);
        continue;
      }
      if (!inherit) {
        const result = await resolvePermission(
          prisma,
          gameId,
          check.groupId,
          check.userId,
          check.permission,
          identity,
        );
        cache.set(gameId, check.groupId, check.userId, check.permission, result);
        results.push(result);
        continue;
      }
      const { result, consulted } = await resolvePermissionInherited(
        prisma,
        gameId,
        check.groupId,
        check.userId,
        check.permission,
        identity,
        levels,
      );
      cache.set(gameId, check.groupId, check.userId, check.permission, result, {
        inherit: true,
        dependsOn: consulted.length > 0 ? consulted : [check.groupId],
      });
      results.push(result);
    }

    return c.json({ results });
  };
}
