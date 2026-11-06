import type {
  CreateRoleInput,
  GroupId,
  Page,
  PermissionContext,
  PermissionEntry,
  PermissionKey,
  PermissionMode,
  Role,
  RoleGraph,
  RoleId,
  RoleMetadata,
  UpdateRoleInput,
} from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import { type HttpClient, type WriteOptions, writeOptions } from "./http.js";
import { contextQuery, hasContext, wireContext } from "./permissionContext.js";
import { type WireContextInheritance, deserializeContextInheritance } from "./permissions.js";
import { parseWireDate } from "./wire.js";

export interface WireRole {
  id: string;
  groupId: string;
  name: string;
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: string[];
  // Optional on the wire: servers that predate deny entries, role
  // inheritance, and role metadata omit them.
  entries?: WirePermissionEntry[];
  parents?: string[];
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface WirePermissionEntry {
  permission: string;
  value: boolean;
  context?: Record<string, string>;
}

export function deserializePermissionEntry(e: WirePermissionEntry): PermissionEntry {
  const entry: PermissionEntry = { permission: e.permission as PermissionKey, value: e.value };
  const context = wireContext(e.context);
  if (context) entry.context = context;
  return entry;
}

// The request shape of an entry: `context` only when non-empty.
function serializePermissionEntry(e: PermissionEntry): WirePermissionEntry {
  const out: WirePermissionEntry = { permission: e.permission, value: e.value };
  if (hasContext(e.context)) out.context = e.context;
  return out;
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
    entries: (w.entries ?? []).map(deserializePermissionEntry),
    parents: (w.parents ?? []).map((r) => r as RoleId),
    metadata: w.metadata ?? {},
    createdAt: parseWireDate(w.createdAt, "createdAt"),
  };
}

export interface WireRoleGraph {
  groupId: string;
  mode: PermissionMode;
  // Optional on the wire: servers that predate it omit it.
  contexts?: WireContextInheritance;
  defaultRoleId: string | null;
  roles: WireRole[];
}

export function deserializeRoleGraph(w: WireRoleGraph): RoleGraph {
  return {
    groupId: w.groupId as GroupId,
    mode: w.mode,
    contexts: deserializeContextInheritance(w.contexts),
    defaultRoleId: w.defaultRoleId === null ? null : (w.defaultRoleId as RoleId),
    roles: w.roles.map(deserializeRole),
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
  metadata?: RoleMetadata;
} {
  const body: {
    name: string;
    priority: number;
    color?: string;
    isDefault?: boolean;
    metadata?: RoleMetadata;
  } = {
    name: input.name,
    priority: input.priority,
  };
  if (input.color !== undefined) body.color = input.color;
  if (input.isDefault !== undefined) body.isDefault = input.isDefault;
  if (input.metadata !== undefined) body.metadata = input.metadata;
  return body;
}

/**
 * What {@link RolesApi.list} returns: an array of roles that also
 * carries the `items` / `nextCursor` shape the other list calls use.
 */
export type RoleList = Role[] & Page<Role>;

// `items` points back at the array itself rather than a copy, so the
// two views cannot drift. Both properties are non-enumerable so the
// value still spreads, serializes, and compares as a plain array.
function asRoleList(roles: Role[]): RoleList {
  return Object.defineProperties(roles, {
    items: { value: roles, enumerable: false },
    nextCursor: { value: null, enumerable: false },
  }) as RoleList;
}

/**
 * Roles: CRUD within a group, permission grant / deny / revoke, bulk
 * entry replacement, parent roles, and the group's role graph. Roles
 * get permissions via the dedicated permission routes, never at
 * creation time.
 */
export class RolesApi {
  constructor(private readonly http: HttpClient) {}

  async create(groupId: GroupId, input: CreateRoleInput, opts?: WriteOptions): Promise<Role> {
    const wire = await this.http.post<WireRole>(
      `/v1/groups/${encodeURIComponent(groupId)}/roles`,
      buildCreateBody(input),
      writeOptions(opts),
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

  async update(id: RoleId, input: UpdateRoleInput, opts?: WriteOptions): Promise<Role> {
    const wire = await this.http.patch<WireRole>(
      `/v1/roles/${encodeURIComponent(id)}`,
      input,
      writeOptions(opts),
    );
    return deserializeRole(wire);
  }

  async delete(id: RoleId, opts?: WriteOptions): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/roles/${encodeURIComponent(id)}`,
      undefined,
      writeOptions(opts),
    );
  }

  /**
   * Lists every role in a group, highest priority first.
   *
   * The result is both an array and a {@link Page}: it indexes,
   * iterates, and carries `filter` / `map` like the array this returned
   * before, and it also exposes `items` and `nextCursor` so the same
   * page-shaped helper works across `groups.list`, `members.list`, and
   * this call. `nextCursor` is always null; a group's roles come back
   * in one response.
   */
  async list(
    groupId: GroupId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<RoleList> {
    const wire = await this.http.get<WireRole[] | { items: WireRole[] }>(
      `/v1/groups/${encodeURIComponent(groupId)}/roles`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    // Tolerates both wire shapes: the bare array this route has always
    // returned, and the page envelope it returns under `?paged=true`.
    const rows = Array.isArray(wire) ? wire : wire.items;
    return asRoleList(rows.map(deserializeRole));
  }

  /**
   * Reads every role in a group together with the game's permission
   * mode and context inheritance and the group's default role, in one
   * call. Holds everything a local
   * resolver needs to evaluate the group's permissions.
   */
  async getGraph(
    groupId: GroupId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<RoleGraph> {
    const wire = await this.http.get<WireRoleGraph>(
      `/v1/groups/${encodeURIComponent(groupId)}/role-graph`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeRoleGraph(wire);
  }

  /**
   * Adds or updates one entry on the role. `value` defaults to true (a
   * grant); false stores a deny entry for the key. The body omits
   * `value` when it is not given, so the server applies its default.
   * `context` limits the entry to checks in that context; an entry is
   * identified by its key and context together, so a contextual write
   * leaves the key's global entry alone. Absent or empty writes the
   * global entry.
   */
  async grantPermission(
    roleId: RoleId,
    permission: PermissionKey,
    opts?: WriteOptions & { value?: boolean; context?: PermissionContext },
  ): Promise<Role> {
    const body: { permission: PermissionKey; value?: boolean; context?: PermissionContext } = {
      permission,
    };
    if (opts?.value !== undefined) body.value = opts.value;
    if (hasContext(opts?.context)) body.context = opts.context;
    const wire = await this.http.post<WireRole>(
      `/v1/roles/${encodeURIComponent(roleId)}/permissions`,
      body,
      writeOptions(opts),
    );
    return deserializeRole(wire);
  }

  /**
   * Replaces the role's whole entry list, grants and denies, in one
   * atomic write. Entries are matched by key and context: an entry
   * absent from `entries` is removed from the role. Each
   * `(permission, context)` pair may appear once.
   */
  async setEntries(roleId: RoleId, entries: PermissionEntry[], opts?: WriteOptions): Promise<Role> {
    const wire = await this.http.put<WireRole>(
      `/v1/roles/${encodeURIComponent(roleId)}/entries`,
      { entries: entries.map(serializePermissionEntry) },
      writeOptions(opts),
    );
    return deserializeRole(wire);
  }

  /**
   * Replaces the role's parent list. Parents must belong to the same
   * group; a list that would form an inheritance cycle is rejected
   * with JunjoError code "parent_cycle".
   */
  async setParents(roleId: RoleId, parents: RoleId[], opts?: WriteOptions): Promise<Role> {
    const wire = await this.http.put<WireRole>(
      `/v1/roles/${encodeURIComponent(roleId)}/parents`,
      { parents },
      writeOptions(opts),
    );
    return deserializeRole(wire);
  }

  /**
   * Removes the role's entry for a key, grant or deny. Without
   * `context` it removes the global entry; with one it removes the
   * entry for that context and leaves the global entry alone.
   */
  async revokePermission(
    roleId: RoleId,
    permission: PermissionKey,
    opts?: WriteOptions & { context?: PermissionContext },
  ): Promise<Role> {
    const wire = await this.http.delete<WireRole>(
      `/v1/roles/${encodeURIComponent(roleId)}/permissions/${encodeURIComponent(permission)}${contextQuery(opts?.context)}`,
      undefined,
      writeOptions(opts),
    );
    return deserializeRole(wire);
  }
}
