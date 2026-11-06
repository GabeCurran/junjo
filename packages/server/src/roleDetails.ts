import type { PermissionEntry, PermissionMode } from "@junjo.io/shared";
import type { Group, Role } from "@prisma/client";
import { loadPermissionMode } from "./config/loadGameConfig.js";
import type { Db } from "./db.js";
import { rowContextField } from "./permissionContext.js";

// The parts of a role stored outside the Role row: its entries and its
// parent role ids, both sorted for stable output. Entries sort by key,
// then canonical context, so a key's global entry comes first.
export interface RoleDetail {
  entries: PermissionEntry[];
  parents: string[];
}

export const EMPTY_ROLE_DETAIL: RoleDetail = { entries: [], parents: [] };

// The keys a role grants globally: the wire `permissions` field.
// Contextual grants are listed only in `entries`.
export function grantedKeys(detail: RoleDetail): string[] {
  return detail.entries.filter((e) => e.value && !e.context).map((e) => e.permission);
}

export async function loadRoleDetails(
  client: Db,
  roleIds: readonly string[],
): Promise<Map<string, RoleDetail>> {
  const out = new Map<string, RoleDetail>();
  if (roleIds.length === 0) return out;
  for (const id of roleIds) out.set(id, { entries: [], parents: [] });
  const ids = [...out.keys()];
  const [entryRows, parentRows] = await Promise.all([
    client.rolePermission.findMany({
      where: { roleId: { in: ids } },
      select: { roleId: true, permissionKey: true, value: true, context: true, contextKey: true },
      orderBy: [{ permissionKey: "asc" }, { contextKey: "asc" }],
    }),
    client.roleParent.findMany({
      where: { roleId: { in: ids } },
      select: { roleId: true, parentRoleId: true },
      orderBy: { parentRoleId: "asc" },
    }),
  ]);
  for (const row of entryRows) {
    out.get(row.roleId)?.entries.push({
      permission: row.permissionKey,
      value: row.value,
      ...rowContextField(row),
    });
  }
  for (const row of parentRows) out.get(row.roleId)?.parents.push(row.parentRoleId);
  return out;
}

export async function loadRoleDetail(client: Db, roleId: string): Promise<RoleDetail> {
  return (await loadRoleDetails(client, [roleId])).get(roleId) ?? EMPTY_ROLE_DETAIL;
}

export interface WireRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  // Globally granted keys only. `entries` carries grants and denies,
  // global and contextual.
  permissions: string[];
  entries: PermissionEntry[];
  parents: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function serializeRole(role: Role, detail: RoleDetail = EMPTY_ROLE_DETAIL): WireRole {
  return {
    id: role.id,
    groupId: role.groupId,
    name: role.name,
    priority: role.priority,
    color: role.color,
    isDefault: role.isDefault,
    permissions: grantedKeys(detail),
    entries: detail.entries,
    parents: detail.parents,
    metadata: (role.metadata ?? {}) as Record<string, unknown>,
    createdAt: role.createdAt.toISOString(),
  };
}

export interface WireRoleGraph {
  groupId: string;
  mode: PermissionMode;
  defaultRoleId: string | null;
  roles: WireRole[];
}

// Every role in a group with its entries, parents and metadata, plus
// what a local resolver needs alongside them: the game's permission
// mode and the group's default role. Roles are ordered by priority
// descending, then id descending, like the role list.
export async function loadRoleGraph(
  client: Db,
  gameId: string,
  group: Pick<Group, "id" | "defaultRoleId">,
): Promise<WireRoleGraph> {
  const [mode, roles] = await Promise.all([
    loadPermissionMode(client, gameId),
    client.role.findMany({
      where: { groupId: group.id },
      orderBy: [{ priority: "desc" }, { id: "desc" }],
    }),
  ]);
  const details = await loadRoleDetails(
    client,
    roles.map((r) => r.id),
  );
  return {
    groupId: group.id,
    mode,
    defaultRoleId: group.defaultRoleId,
    roles: roles.map((role) => serializeRole(role, details.get(role.id))),
  };
}
