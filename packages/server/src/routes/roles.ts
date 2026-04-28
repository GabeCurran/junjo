import type { Prisma, PrismaClient, Role } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { grantPermissionBody, updateRoleBody } from "./roles.schema.js";

export interface WireRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  createdAt: string;
}

// Phase 3.1 ships role CRUD; Phase 3.3 will populate `permissions` via the
// grant / revoke routes. The list is included in the wire format now (as an
// empty array until 3.3) so the SDK type stays stable across phases.
export function serializeRole(role: Role, permissions: string[] = []): WireRole {
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

// Loads the permission keys for a single role. Centralized so the create /
// get / update paths emit the same wire shape; Phase 3.3 (grant / revoke)
// will add the writers that populate `RolePermission`. Until then this
// query returns an empty array.
export async function loadRolePermissionKeys(
  client: PrismaClient | Prisma.TransactionClient,
  roleId: string,
): Promise<string[]> {
  const rows = await client.rolePermission.findMany({
    where: { roleId },
    select: { permissionKey: true },
    orderBy: { permissionKey: "asc" },
  });
  return rows.map((r) => r.permissionKey);
}

// Batched counterpart used by the list-roles route to avoid an N+1 query.
export async function batchLoadRolePermissionKeys(
  client: PrismaClient | Prisma.TransactionClient,
  roleIds: string[],
): Promise<Map<string, string[]>> {
  if (roleIds.length === 0) return new Map();
  const rows = await client.rolePermission.findMany({
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

// Loads a role by id and enforces calling-game scope. Soft-deleted groups
// also collapse to 404 so a soft-deleted group does not leak its role list.
async function loadScopedRole(
  prisma: PrismaClient,
  id: string | undefined,
  gameId: string,
): Promise<Role> {
  if (!id) throw Errors.notFound("role");
  const role = await prisma.role.findUnique({
    where: { id },
    include: { group: { select: { gameId: true, softDeletedAt: true } } },
  });
  if (!role) throw Errors.notFound("role");
  if (role.group.gameId !== gameId) throw Errors.notFound("role");
  if (role.group.softDeletedAt) throw Errors.notFound("role");
  const { group: _group, ...rest } = role;
  return rest as Role;
}

export function getRoleByIdHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const role = await loadScopedRole(prisma, id, gameId);
    const permissions = await loadRolePermissionKeys(prisma, role.id);
    return c.json(serializeRole(role, permissions));
  };
}

export function updateRoleByIdHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = updateRoleBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const existing = await loadScopedRole(prisma, id, gameId);

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
      const permissions = await loadRolePermissionKeys(prisma, existing.id);
      return c.json(serializeRole(existing, permissions));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.role.update({
        where: { id: existing.id },
        data,
      });
      await tx.auditEntry.create({
        data: {
          groupId: existing.groupId,
          actorUserId: null,
          action: "role.updated",
          targetId: result.id,
          payload: { before, after } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const permissions = await loadRolePermissionKeys(prisma, updated.id);
    return c.json(serializeRole(updated, permissions));
  };
}

// Grant a permission key to a role. Idempotent: granting a permission the
// role already has returns the unchanged role with no audit entry and no
// DB write. The permission key is auto-registered into `PermissionDef` on
// first sight per game (one upsert inside the same transaction); revoking
// the permission later does not unregister the def, since the registry is
// a "known keys" catalog for the dashboard / SDK validators.
export function grantPermissionHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const json = await c.req.json().catch(() => null);
    const parsed = grantPermissionBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { permission } = parsed.data;

    const role = await loadScopedRole(prisma, id, gameId);

    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionKey: { roleId: role.id, permissionKey: permission } },
    });
    if (existing) {
      const permissions = await loadRolePermissionKeys(prisma, role.id);
      return c.json(serializeRole(role, permissions));
    }

    await prisma.$transaction(async (tx) => {
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
    });

    const permissions = await loadRolePermissionKeys(prisma, role.id);
    return c.json(serializeRole(role, permissions));
  };
}

// Revoke a permission key from a role. Idempotent: revoking a permission
// the role does not have returns the unchanged role with no audit entry.
// The `PermissionDef` registry is preserved (revoke does not "forget" the
// key for the game).
export function revokePermissionHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    const permission = c.req.param("permission");
    const gameId = c.var.gameId;

    if (!permission) throw Errors.badRequest("permission must not be empty");

    const role = await loadScopedRole(prisma, id, gameId);

    const existing = await prisma.rolePermission.findUnique({
      where: { roleId_permissionKey: { roleId: role.id, permissionKey: permission } },
    });
    if (!existing) {
      const permissions = await loadRolePermissionKeys(prisma, role.id);
      return c.json(serializeRole(role, permissions));
    }

    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.delete({
        where: { roleId_permissionKey: { roleId: role.id, permissionKey: permission } },
      });
      await tx.auditEntry.create({
        data: {
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
    });

    const permissions = await loadRolePermissionKeys(prisma, role.id);
    return c.json(serializeRole(role, permissions));
  };
}

export function deleteRoleByIdHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const existing = await loadScopedRole(prisma, id, gameId);

    const memberCount = await prisma.memberRole.count({
      where: { roleId: existing.id },
    });
    if (memberCount > 0) {
      throw Errors.roleHasMembers();
    }

    await prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id: existing.id } });
      await tx.auditEntry.create({
        data: {
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
    });

    return c.body(null, 204);
  };
}
