import type { PrismaClient, Role } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { loadRoleDetail, serializeRole } from "../roleDetails.js";
import {
  deleteRole,
  parseBody,
  removeRoleEntry,
  replaceRoleEntries,
  setRoleParents,
  updateRole,
  upsertRoleEntry,
} from "../roleWrites.js";
import { grantPermissionBody, updateRoleBody } from "./roles.schema.js";

export { type WireRole, serializeRole } from "../roleDetails.js";

// Cross-game and soft-deleted-group both collapse to 404 so existence
// is not leaked across the gameId scope.
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
    return c.json(serializeRole(role, await loadRoleDetail(prisma, role.id)));
  };
}

export function updateRoleByIdHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const body = parseBody(updateRoleBody, await c.req.json().catch(() => null));
    const role = await updateRole(prisma, hub, {
      gameId: c.var.gameId,
      roleId: c.req.param("id") ?? "",
      body,
    });
    return c.json(role);
  };
}

// Adds or updates one entry; `value` defaults to true (grant).
// Idempotent when the entry already holds that value. The first write
// of a key auto-registers `PermissionDef`; removing an entry does NOT
// unregister it, since the registry is a monotonic "known keys" catalog
// for the dashboard / SDK validators.
export function grantPermissionHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const body = parseBody(grantPermissionBody, await c.req.json().catch(() => null));
    const role = await upsertRoleEntry(prisma, hub, {
      gameId: c.var.gameId,
      roleId: c.req.param("id") ?? "",
      permission: body.permission,
      value: body.value ?? true,
    });
    return c.json(role);
  };
}

// Removes one entry, grant or deny. Idempotent on a missing entry.
// PermissionDef registry is preserved.
export function revokePermissionHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const role = await removeRoleEntry(prisma, hub, {
      gameId: c.var.gameId,
      roleId: c.req.param("id") ?? "",
      permission: c.req.param("permission") ?? "",
    });
    return c.json(role);
  };
}

// Replaces the role's full entry list atomically.
export function replaceRoleEntriesHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const role = await replaceRoleEntries(prisma, hub, {
      gameId: c.var.gameId,
      roleId: c.req.param("id") ?? "",
      body: await c.req.json().catch(() => null),
    });
    return c.json(role);
  };
}

// Replaces the role's full parent list.
export function setRoleParentsHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const role = await setRoleParents(prisma, hub, {
      gameId: c.var.gameId,
      roleId: c.req.param("id") ?? "",
      body: await c.req.json().catch(() => null),
    });
    return c.json(role);
  };
}

export function deleteRoleByIdHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    await deleteRole(prisma, hub, { gameId: c.var.gameId, roleId: c.req.param("id") ?? "" });
    return c.body(null, 204);
  };
}
