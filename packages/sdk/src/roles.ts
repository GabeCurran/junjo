import type {
  CreateRoleInput,
  GroupId,
  PermissionKey,
  Role,
  RoleId,
  UpdateRoleInput,
} from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { parseWireDate } from "./wire.js";

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

export function deserializeRole(w: WireRole): Role {
  return {
    id: w.id as RoleId,
    groupId: w.groupId as GroupId,
    name: w.name,
    priority: w.priority,
    color: w.color,
    isDefault: w.isDefault,
    permissions: w.permissions,
    createdAt: parseWireDate(w.createdAt, "createdAt"),
  };
}

// Drops `permissions`: roles get permissions via the dedicated grant /
// revoke routes, never at creation time. The shared `CreateRoleInput`
// still carries the field for forward-compatibility, so silently
// stripping is preferable to failing at the type layer.
function buildCreateBody(input: CreateRoleInput): {
  name: string;
  priority: number;
  color?: string;
  isDefault?: boolean;
} {
  const body: { name: string; priority: number; color?: string; isDefault?: boolean } = {
    name: input.name,
    priority: input.priority,
  };
  if (input.color !== undefined) body.color = input.color;
  if (input.isDefault !== undefined) body.isDefault = input.isDefault;
  return body;
}

/**
 * Roles: CRUD within a group plus permission grant / revoke. Roles get
 * permissions via the dedicated grant / revoke routes, never at
 * creation time.
 */
export class RolesApi {
  constructor(private readonly http: HttpClient) {}

  async create(
    groupId: GroupId,
    input: CreateRoleInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Role> {
    const wire = await this.http.post<WireRole>(
      `/v1/groups/${encodeURIComponent(groupId)}/roles`,
      buildCreateBody(input),
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeRole(wire);
  }

  async get(id: RoleId, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Role | null> {
    try {
      const wire = await this.http.get<WireRole>(`/v1/roles/${encodeURIComponent(id)}`, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
      });
      return deserializeRole(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async update(
    id: RoleId,
    input: UpdateRoleInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Role> {
    const wire = await this.http.patch<WireRole>(`/v1/roles/${encodeURIComponent(id)}`, input, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return deserializeRole(wire);
  }

  async delete(id: RoleId, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    await this.http.delete<unknown>(`/v1/roles/${encodeURIComponent(id)}`, undefined, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }

  async list(
    groupId: GroupId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Role[]> {
    const wire = await this.http.get<WireRole[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/roles`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.map(deserializeRole);
  }

  async grantPermission(
    roleId: RoleId,
    permission: PermissionKey,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Role> {
    const wire = await this.http.post<WireRole>(
      `/v1/roles/${encodeURIComponent(roleId)}/permissions`,
      { permission },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeRole(wire);
  }

  async revokePermission(
    roleId: RoleId,
    permission: PermissionKey,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Role> {
    const wire = await this.http.delete<WireRole>(
      `/v1/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permission)}`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeRole(wire);
  }
}
