import type {
  GameConfigPermissions,
  GroupId,
  PermissionCheckResult,
  PermissionConfig,
  PermissionContext,
  PermissionMode,
} from "@junjo.io/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { loadPermissionConfig } from "../config/loadGameConfig.js";
import type { Db } from "../db.js";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { type PermissionCache, permissionCache } from "../permissionCache.js";
import {
  canonicalContextKey,
  contextFromRequestUrl,
  contextFromStored,
} from "../permissionContext.js";
import {
  MAX_ROLE_DEPTH,
  type ResolverContextEntry,
  type ResolverRole,
  candidateKeys,
  resolveMemberPermission,
} from "../permissionResolve.js";
import { assertUserIdsWellFormed } from "../userIdFormat.js";
import { stampStreamPosition } from "./gameEvents.js";
import { MAX_PARENT_DEPTH } from "./groups.schema.js";
import { checkPermissionBatchBody, checkPermissionQuery } from "./permissions.schema.js";

// Request-scoped lookups shared by every check in one request: the
// game's permission config (mode and context inheritance), read once,
// and external userId -> JunjoUser id. A batch repeats the same userId across most of its entries and an
// inherited walk repeats it at every level; without this each repeat is
// another lookup.
export class CheckContext {
  private readonly identities = new Map<string, string | null>();
  private configPromise: Promise<GameConfigPermissions> | null = null;

  constructor(
    private readonly prisma: Db,
    private readonly gameId: string,
  ) {}

  permissions(): Promise<GameConfigPermissions> {
    this.configPromise ??= loadPermissionConfig(this.prisma, this.gameId);
    return this.configPromise;
  }

  async mode(): Promise<PermissionMode> {
    return (await this.permissions()).mode;
  }

  async resolve(externalUserId: string): Promise<string | null> {
    const hit = this.identities.get(externalUserId);
    if (hit !== undefined) return hit;
    const id = await findJunjoUserId(this.prisma, this.gameId, externalUserId);
    this.identities.set(externalUserId, id);
    return id;
  }
}

// Memoizes one (group, user, permission, context) resolution for the
// span of a request. A batch of sibling groups shares its ancestors, so without
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
  private key(groupId: string, externalUserId: string, permission: string, context: string) {
    let out = "";
    for (const part of [groupId, externalUserId, permission, context]) {
      out += `|${part.length}:${part}`;
    }
    return out;
  }

  // `context` is the check's canonical context key.
  async resolve(
    groupId: string,
    externalUserId: string,
    permission: string,
    context: string,
    compute: () => Promise<PermissionCheckResult>,
  ): Promise<PermissionCheckResult> {
    const k = this.key(groupId, externalUserId, permission, context);
    const hit = this.entries.get(k);
    if (hit) return hit;
    const result = await compute();
    this.entries.set(k, result);
    return result;
  }
}

interface ReachableRoleRow {
  id: string;
  priority: number;
  depth: number;
}

// The roles a member holds directly plus every role reachable from them
// through role parents, restricted to the member's group, as one
// recursive CTE. UNION over (id, depth) keeps the working set bounded by
// roles x depth even when many paths reach the same role. `depth` is
// bounded by `MAX_ROLE_DEPTH`, which only matters against corrupted
// state because parent writes are cycle-checked.
async function loadReachableRoles(
  prisma: Db,
  groupId: string,
  groupMemberId: string,
): Promise<ReachableRoleRow[]> {
  return prisma.$queryRaw<ReachableRoleRow[]>(
    Prisma.sql`
      WITH RECURSIVE reach AS (
        SELECT mr."roleId" AS id, 0 AS depth
        FROM "MemberRole" mr
        JOIN "Role" r ON r.id = mr."roleId"
        WHERE mr."groupMemberId" = ${groupMemberId}
          AND r."groupId" = ${groupId}
        UNION
        SELECT rp."parentRoleId", reach.depth + 1
        FROM reach
        JOIN "RoleParent" rp ON rp."roleId" = reach.id
        JOIN "Role" p ON p.id = rp."parentRoleId"
        WHERE reach.depth < ${MAX_ROLE_DEPTH}
          AND p."groupId" = ${groupId}
      )
      SELECT r.id, r.priority, MIN(reach.depth)::int AS depth
      FROM reach
      JOIN "Role" r ON r.id = reach.id
      GROUP BY r.id, r.priority
    `,
  );
}

// Resolution for one group. Membership and status gate first: a missing
// membership or a non-active status returns `none`. Otherwise the
// layered resolver in `permissionResolve.ts` decides from the member's
// overrides and the roles reachable from their direct roles, reading
// only the entries whose keys could match the queried permission, and
// only global entries when the check has no context.
//
// Non-active members (`left` / `kicked` / `invited`) intentionally do
// NOT exercise permissions, even though their role rows survive the
// transition (rows are kept for audit history; the resolver gates on
// status).
async function resolveForJunjoUser(
  prisma: Db,
  config: GameConfigPermissions,
  groupId: string,
  junjoUserId: string,
  permission: string,
  context: PermissionContext,
): Promise<PermissionCheckResult> {
  const { mode, contexts } = config;
  const member = await prisma.groupMember.findUnique({
    where: { groupId_junjoUserId: { groupId, junjoUserId } },
    select: { id: true, status: true },
  });
  if (!member) return { allowed: false, source: "none" };
  if (member.status !== "active") return { allowed: false, source: "none" };

  const candidates = candidateKeys(mode, permission);
  const globalOnly = Object.keys(context).length === 0;
  const contextFilter = globalOnly ? { contextKey: "" } : {};
  const overrideRows = await prisma.memberPermissionOverride.findMany({
    where: { groupMemberId: member.id, permissionKey: { in: candidates }, ...contextFilter },
    select: { permissionKey: true, grant: true, context: true, contextKey: true },
  });
  const overrides = new Map<string, boolean>();
  const contextOverrides: ResolverContextEntry[] = [];
  for (const o of overrideRows) {
    const entryContext = o.contextKey === "" ? undefined : contextFromStored(o.context);
    if (entryContext) {
      contextOverrides.push({ permission: o.permissionKey, value: o.grant, context: entryContext });
    } else {
      overrides.set(o.permissionKey, o.grant);
    }
  }
  // The member layer decides before any role, so an applicable override
  // makes the role reads unnecessary. A contextual override that does
  // not apply to this check leaves the member layer undecided.
  if (overrideRows.length > 0) {
    const own = resolveMemberPermission(
      { mode, overrides, contextOverrides, directRoleIds: [], roles: new Map(), context, contexts },
      permission,
    );
    if (own.source === "override") return own;
  }

  const reachable = await loadReachableRoles(prisma, groupId, member.id);
  if (reachable.length === 0) return { allowed: false, source: "default" };
  const roleIds = reachable.map((r) => r.id);
  const inherits = reachable.some((r) => r.depth > 0);

  const [entryRows, parentRows] = await Promise.all([
    prisma.rolePermission.findMany({
      where: { roleId: { in: roleIds }, permissionKey: { in: candidates }, ...contextFilter },
      select: { roleId: true, permissionKey: true, value: true, context: true, contextKey: true },
    }),
    inherits
      ? prisma.roleParent.findMany({
          where: { roleId: { in: roleIds }, parentRoleId: { in: roleIds } },
          select: { roleId: true, parentRoleId: true },
        })
      : Promise.resolve([]),
  ]);

  const entries = new Map<string, Map<string, boolean>>();
  const contextEntries = new Map<string, ResolverContextEntry[]>();
  const parents = new Map<string, string[]>();
  for (const e of entryRows) {
    const entryContext = e.contextKey === "" ? undefined : contextFromStored(e.context);
    if (entryContext) {
      const list = contextEntries.get(e.roleId);
      const entry = { permission: e.permissionKey, value: e.value, context: entryContext };
      if (list) list.push(entry);
      else contextEntries.set(e.roleId, [entry]);
      continue;
    }
    let m = entries.get(e.roleId);
    if (!m) {
      m = new Map();
      entries.set(e.roleId, m);
    }
    m.set(e.permissionKey, e.value);
  }
  for (const p of parentRows) {
    const list = parents.get(p.roleId);
    if (list) list.push(p.parentRoleId);
    else parents.set(p.roleId, [p.parentRoleId]);
  }
  const roles = new Map<string, ResolverRole>();
  for (const row of reachable) {
    roles.set(row.id, {
      priority: row.priority,
      entries: entries.get(row.id) ?? new Map(),
      contextEntries: contextEntries.get(row.id) ?? [],
      parents: parents.get(row.id) ?? [],
    });
  }

  return resolveMemberPermission(
    {
      mode,
      overrides: new Map(),
      directRoleIds: reachable.filter((r) => r.depth === 0).map((r) => r.id),
      roles,
      context,
      contexts,
    },
    permission,
  );
}

// Caller must enforce game scope on `groupId`; this function trusts it.
// `permissionContext` is the check's context, already validated and
// folded; empty means only global entries apply.
export async function resolvePermission(
  prisma: Db,
  gameId: string,
  groupId: string,
  externalUserId: string,
  permission: string,
  context?: CheckContext,
  permissionContext: PermissionContext = {},
): Promise<PermissionCheckResult> {
  const ctx = context ?? new CheckContext(prisma, gameId);
  const junjoUserId = await ctx.resolve(externalUserId);
  if (!junjoUserId) return { allowed: false, source: "none" };
  return resolveForJunjoUser(
    prisma,
    await ctx.permissions(),
    groupId,
    junjoUserId,
    permission,
    permissionContext,
  );
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
  prisma: Db,
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
// stops at the first group that decides: an override or a role entry,
// in either direction. Nearest therefore wins, so a child's explicit
// deny is not undone by a grant further up.
//
// Levels where the user is not an active member (`none`) or nothing
// matches (`default`) are inconclusive and the walk continues past them.
// If nothing on the chain decides, the queried group's own result is
// returned unchanged, which preserves the `none` / `default` distinction
// callers use to tell "not a member" from "member without the grant".
export async function resolvePermissionInherited(
  prisma: Db,
  gameId: string,
  groupId: string,
  externalUserId: string,
  permission: string,
  context?: CheckContext,
  levels?: LevelMemo,
  permissionContext: PermissionContext = {},
): Promise<InheritedResolution> {
  const memo = context ?? new CheckContext(prisma, gameId);
  const levelMemo = levels ?? new LevelMemo();
  const contextKey = canonicalContextKey(permissionContext);
  const chain = await loadAncestorChain(prisma, gameId, groupId);
  const consulted: string[] = [];
  let direct: PermissionCheckResult | null = null;

  for (const levelGroupId of chain) {
    consulted.push(levelGroupId);
    const result = await levelMemo.resolve(
      levelGroupId,
      externalUserId,
      permission,
      contextKey,
      () =>
        resolvePermission(
          prisma,
          gameId,
          levelGroupId,
          externalUserId,
          permission,
          memo,
          permissionContext,
        ),
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
    const permissionContext = contextFromRequestUrl(c.req.url);
    const contextKey = canonicalContextKey(permissionContext);

    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");

    // Checked before the cache so a malformed id rejects even when an
    // answer for that spelling was cached before its format was declared.
    await assertUserIdsWellFormed(prisma, gameId, [userId]);
    const cached = cache.get(gameId, group.id, userId, permission, {
      inherit,
      context: contextKey,
    });
    if (cached) return c.json(cached);

    if (!inherit) {
      const result = await resolvePermission(
        prisma,
        gameId,
        group.id,
        userId,
        permission,
        undefined,
        permissionContext,
      );
      cache.set(gameId, group.id, userId, permission, result, { context: contextKey });
      return c.json(result);
    }

    const { result, consulted } = await resolvePermissionInherited(
      prisma,
      gameId,
      group.id,
      userId,
      permission,
      undefined,
      undefined,
      permissionContext,
    );
    cache.set(gameId, group.id, userId, permission, result, {
      inherit: true,
      context: contextKey,
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

    await assertUserIdsWellFormed(
      prisma,
      gameId,
      checks.map((check) => check.userId),
    );
    const context = new CheckContext(prisma, gameId);
    const levels = new LevelMemo();
    const results: PermissionCheckResult[] = [];
    for (const check of checks) {
      const permissionContext = check.context ?? {};
      const contextKey = canonicalContextKey(permissionContext);
      const cached = cache.get(gameId, check.groupId, check.userId, check.permission, {
        inherit,
        context: contextKey,
      });
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
          context,
          permissionContext,
        );
        cache.set(gameId, check.groupId, check.userId, check.permission, result, {
          context: contextKey,
        });
        results.push(result);
        continue;
      }
      const { result, consulted } = await resolvePermissionInherited(
        prisma,
        gameId,
        check.groupId,
        check.userId,
        check.permission,
        context,
        levels,
        permissionContext,
      );
      cache.set(gameId, check.groupId, check.userId, check.permission, result, {
        inherit: true,
        context: contextKey,
        dependsOn: consulted.length > 0 ? consulted : [check.groupId],
      });
      results.push(result);
    }

    return c.json({ results });
  };
}

// GET /v1/permissions/config. The game's permission mode and context
// inheritance, resolved against the defaults. The stream position
// header is read before the config, so a follower that resumes the
// game stream from it sees every later change.
export function getPermissionConfigHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.var.gameId;
    await stampStreamPosition(c, prisma, gameId);
    const { mode, contexts } = await loadPermissionConfig(prisma, gameId);
    return c.json<PermissionConfig>({ mode, contexts });
  };
}
