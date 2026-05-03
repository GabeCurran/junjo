import type { PermissionCheckResult, RoleId } from "@junjo/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { type PermissionCache, permissionCache } from "../permissionCache.js";
import { checkPermissionQuery } from "./permissions.schema.js";

type PermissionsClient = PrismaClient | Prisma.TransactionClient;

// Resolution order: missing identity / membership / non-active status
// returns `none`; an override (in either direction) wins; otherwise any
// role with the permission grants it (highest-priority role wins, ties
// broken by roleId desc for stability); finally `default`.
//
// Non-active members (`left` / `kicked` / `invited`) intentionally do
// NOT exercise permissions, even though their role rows survive the
// transition (rows are kept for audit history; the resolver gates on
// status).
//
// Caller must enforce game scope on `groupId`; this function trusts it.
export async function resolvePermission(
  prisma: PermissionsClient,
  gameId: string,
  groupId: string,
  externalUserId: string,
  permission: string,
): Promise<PermissionCheckResult> {
  const junjoUserId = await findJunjoUserId(prisma, gameId, externalUserId);
  if (!junjoUserId) return { allowed: false, source: "none" };

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
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { userId, groupId, permission } = parsed.data;

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
