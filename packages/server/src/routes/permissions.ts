import type { PermissionCheckResult, RoleId } from "@junjo/shared";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { type PermissionCache, permissionCache } from "../permissionCache.js";
import { checkPermissionQuery } from "./permissions.schema.js";

type PermissionsClient = PrismaClient | Prisma.TransactionClient;

// Resolves the canonical answer to "is this user allowed to do this thing
// in this group?" The order of resolution is:
//
//   1. If the user has no `ExternalIdentity` for this game, or no
//      `GroupMember` row in this group, the answer is `none` (not
//      applicable; the user is not in the group).
//   2. If the member is not `active` (i.e. `left`, `kicked`, or `invited`),
//      the answer is `none`. A non-active member cannot exercise
//      permissions even if their role assignments and overrides survive
//      the transition. (Role rows are preserved on leave/kick to keep
//      audit history; the permission resolver gates on status.)
//   3. If a `MemberPermissionOverride` exists, it wins regardless of
//      direction. Allowed = override.grant, source = "override".
//   4. If any of the member's roles has the permission via
//      `RolePermission`, allowed = true with source = "role" and
//      `viaRoleId` set to the highest-priority granting role (priority
//      desc, then roleId desc as a tiebreaker so the answer is stable).
//   5. Otherwise the member is in-group with no override and no granting
//      role: the answer is `default` (not allowed; this is the default
//      state for any permission the dev has not explicitly configured).
//
// The caller is responsible for checking that the group exists and is in
// the calling game; this function trusts the supplied `groupId`.
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

// `GET /v1/permissions/check?userId=&groupId=&permission=`. Reads through
// the in-memory cache first; on miss runs `resolvePermission` and caches
// the result. Mutations elsewhere call `cache.invalidateGroup(groupId)`
// after committing so a stale cache flip waits at most one round-trip.
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
