import type {
  GameId,
  GroupId,
  MemberUpdatedEvent,
  PartialGameConfig,
  PermissionContext,
  PermissionEntry,
  PermissionGrantedEvent,
  PermissionKey,
  PermissionMode,
  PermissionRevokedEvent,
  RoleChangeField,
  RoleCreatedEvent,
  RoleDeletedEvent,
  RoleId,
  RoleUpdatedEvent,
  UserId,
} from "@junjo.io/shared";
import {
  type MemberPermissionOverride,
  Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
import { resolveGameConfig } from "./config/defaults.js";
import { Errors } from "./errors.js";
import type { EventHub } from "./eventHub.js";
import { publishStagedEvents, stageEvent, toPublicRole } from "./events.js";
import { lockKey } from "./locks.js";
import { permissionCache } from "./permissionCache.js";
import { canonicalContextKey, storedContext } from "./permissionContext.js";
import {
  MAX_ROLE_DEPTH,
  findRoleCycle,
  normalizePermissionKey,
  validatePermissionKey,
} from "./permissionResolve.js";
import { isUniqueViolation, retryOnSerializationFailure } from "./prismaErrors.js";
import { type WireRole, loadRoleDetail, serializeRole } from "./roleDetails.js";
import {
  MAX_ROLE_ENTRIES,
  PERMISSION_KEY_MAX_LENGTH,
  replaceRoleEntriesBody,
  setRoleParentsBody,
} from "./routes/roles.schema.js";
import { parseBody } from "./validation.js";
import { bumpMemberVersion, lockMemberVersion } from "./versions.js";

// Role and permission-key writes shared by the per-game and admin
// routes. Every write that stores a permission key reads the game's
// mode under a share lock on the Game row, so it cannot interleave with
// a mode switch, which takes the same row for update.

type Tx = Prisma.TransactionClient;

export async function lockPermissionMode(tx: Tx, gameId: string): Promise<PermissionMode> {
  const rows = await tx.$queryRaw<{ config: unknown }[]>(
    Prisma.sql`SELECT config FROM "Game" WHERE id = ${gameId} FOR SHARE`,
  );
  return resolveGameConfig((rows[0]?.config ?? null) as PartialGameConfig | null).permissions.mode;
}

// Validates a key for storage in `mode` and returns its stored form.
export function keyForWrite(mode: PermissionMode, key: string): string {
  if (key.length === 0) throw Errors.badRequest("permission must not be empty");
  if (key.length > PERMISSION_KEY_MAX_LENGTH) {
    throw Errors.badRequest(`permission must be at most ${PERMISSION_KEY_MAX_LENGTH} characters`);
  }
  const reason = validatePermissionKey(mode, key);
  if (reason) throw Errors.badRequest(`permission ${JSON.stringify(key)} ${reason}`);
  return normalizePermissionKey(mode, key);
}

// Cross-game, soft-deleted-group and missing roles all collapse to 404
// so existence is not leaked across the game scope. Locks the role row
// so concurrent writes to one role's entries or parents serialize.
async function lockScopedRole(tx: Tx, gameId: string, roleId: string): Promise<Role> {
  const locked = await tx.$queryRaw<{ id: string }[]>(
    Prisma.sql`SELECT r.id FROM "Role" r JOIN "Group" g ON g.id = r."groupId"
      WHERE r.id = ${roleId} AND g."gameId" = ${gameId} AND g."softDeletedAt" IS NULL
      FOR UPDATE OF r`,
  );
  if (locked.length === 0) throw Errors.notFound("role");
  return tx.role.findUniqueOrThrow({ where: { id: roleId } });
}

function stageRoleUpdated(
  tx: Tx,
  gameId: string,
  groupId: string,
  roleId: string,
  changed: RoleChangeField[],
): Promise<RoleUpdatedEvent> {
  return stageEvent<RoleUpdatedEvent>(tx, {
    type: "role.updated",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    roleId: roleId as RoleId,
    changed,
  });
}

async function registerKeys(tx: Tx, gameId: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await tx.permissionDef.createMany({
    data: keys.map((key) => ({ gameId, key })),
    skipDuplicates: true,
  });
}

async function loadWireRole(prisma: PrismaClient, roleId: string): Promise<WireRole> {
  const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } });
  return serializeRole(role, await loadRoleDetail(prisma, roleId));
}

export interface EntryDiff {
  added: PermissionEntry[];
  removed: PermissionEntry[];
  changed: { permission: string; before: boolean; after: boolean; context?: PermissionContext }[];
}

// The entry's context when it is contextual, for wire and audit shapes
// that omit the field on global entries.
function contextField(context: PermissionContext): { context?: PermissionContext } {
  return Object.keys(context).length === 0 ? {} : { context: { ...context } };
}

// Identity of an entry inside one role or member: key and canonical
// context. Length-prefixed so no key can encode another pair.
function slotOf(permission: string, contextKey: string): string {
  return `${permission.length}:${permission}|${contextKey}`;
}

interface SlotEntry {
  permission: string;
  contextKey: string;
  context: PermissionContext;
  value: boolean;
}

// A row filter matching exactly `entries` on one role: one `IN` list per
// distinct context, so a large replace stays a handful of predicates.
function slotsWhere(
  roleId: string,
  entries: readonly SlotEntry[],
): Prisma.RolePermissionWhereInput {
  const byContext = new Map<string, string[]>();
  for (const e of entries) {
    const keys = byContext.get(e.contextKey);
    if (keys) keys.push(e.permission);
    else byContext.set(e.contextKey, [e.permission]);
  }
  return {
    OR: [...byContext].map(([contextKey, keys]) => ({
      roleId,
      contextKey,
      permissionKey: { in: keys },
    })),
  };
}

function isEmptyDiff(d: EntryDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}

// Replaces a role's full entry list in one transaction, recording one
// audit entry with the diff. A no-op replace writes nothing.
export async function replaceRoleEntries(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; body: unknown },
): Promise<WireRole> {
  const { entries } = parseBody(replaceRoleEntriesBody, args.body);
  const { gameId, roleId } = args;

  const outcome = await prisma.$transaction(
    async (tx) => {
      const mode = await lockPermissionMode(tx, gameId);
      const role = await lockScopedRole(tx, gameId, roleId);

      // An entry's identity is its key and context, so the same key may
      // appear once globally and once per context.
      const next = new Map<string, SlotEntry>();
      for (const entry of entries) {
        const permission = keyForWrite(mode, entry.permission);
        const context = entry.context ?? {};
        const contextKey = canonicalContextKey(context);
        const slot = slotOf(permission, contextKey);
        if (next.has(slot)) {
          const where = contextKey === "" ? "" : ` with context ${contextKey}`;
          throw Errors.badRequest(
            `duplicate permission ${JSON.stringify(permission)}${where} in entries`,
          );
        }
        next.set(slot, { permission, contextKey, context, value: entry.value });
      }

      const current = await tx.rolePermission.findMany({
        where: { roleId },
        select: { permissionKey: true, value: true, context: true, contextKey: true },
      });
      const prev = new Map<string, SlotEntry>(
        current.map((r) => [
          slotOf(r.permissionKey, r.contextKey),
          {
            permission: r.permissionKey,
            contextKey: r.contextKey,
            context: (r.contextKey === "" ? {} : (r.context ?? {})) as PermissionContext,
            value: r.value,
          },
        ]),
      );
      const diff: EntryDiff = { added: [], removed: [], changed: [] };
      const added: SlotEntry[] = [];
      const removed: SlotEntry[] = [];
      const changed: SlotEntry[] = [];
      for (const [slot, entry] of next) {
        const before = prev.get(slot);
        const shown = { permission: entry.permission, ...contextField(entry.context) };
        if (before === undefined) {
          added.push(entry);
          diff.added.push({ ...shown, value: entry.value });
        } else if (before.value !== entry.value) {
          changed.push(entry);
          diff.changed.push({ ...shown, before: before.value, after: entry.value });
        }
      }
      for (const [slot, entry] of prev) {
        if (next.has(slot)) continue;
        removed.push(entry);
        diff.removed.push({
          permission: entry.permission,
          value: entry.value,
          ...contextField(entry.context),
        });
      }
      if (isEmptyDiff(diff)) return { role, event: null };

      if (removed.length > 0) {
        await tx.rolePermission.deleteMany({
          where: slotsWhere(roleId, removed),
        });
      }
      for (const value of [true, false]) {
        const flips = changed.filter((e) => e.value === value);
        if (flips.length > 0) {
          await tx.rolePermission.updateMany({
            where: slotsWhere(roleId, flips),
            data: { value },
          });
        }
      }
      if (added.length > 0) {
        await tx.rolePermission.createMany({
          data: added.map((e) => ({
            roleId,
            permissionKey: e.permission,
            value: e.value,
            context: storedContext(e.context) ?? Prisma.DbNull,
            contextKey: e.contextKey,
          })),
        });
        await registerKeys(tx, gameId, [...new Set(added.map((e) => e.permission))]);
      }
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "role.entries.changed",
          targetId: role.id,
          payload: { roleId: role.id, ...diff } as unknown as Prisma.InputJsonValue,
        },
      });
      const event = await stageRoleUpdated(tx, gameId, role.groupId, role.id, ["entries"]);
      return { role, event };
    },
    { timeout: 30_000 },
  );

  if (outcome.event) {
    permissionCache.invalidateGroup(outcome.role.groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return loadWireRole(prisma, roleId);
}

// Adds or updates one entry, identified by key and context. Idempotent
// when the entry already holds `value`. For a global entry, a key
// entering the granted set emits `permission.granted`, a key leaving it
// emits `permission.revoked`, and any change involving a deny also
// emits `role.updated`. Any change to a contextual entry emits only
// `role.updated`: the legacy events describe the global granted set.
// `context` must already be validated and folded; empty is global.
export async function upsertRoleEntry(
  prisma: PrismaClient,
  hub: EventHub,
  args: {
    gameId: string;
    roleId: string;
    permission: string;
    value: boolean;
    context?: PermissionContext;
  },
): Promise<WireRole> {
  const { gameId, roleId, value } = args;
  const context = args.context ?? {};
  const contextKey = canonicalContextKey(context);
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const role = await lockScopedRole(tx, gameId, roleId);
    const permission = keyForWrite(mode, args.permission);
    const where = {
      roleId_permissionKey_contextKey: { roleId, permissionKey: permission, contextKey },
    };

    const existing = await tx.rolePermission.findUnique({ where, select: { value: true } });
    if (existing?.value === value) return { role, events: [] };
    if (!existing) {
      const count = await tx.rolePermission.count({ where: { roleId } });
      if (count >= MAX_ROLE_ENTRIES) {
        throw Errors.badRequest(`role already has the maximum of ${MAX_ROLE_ENTRIES} entries`);
      }
    }

    await registerKeys(tx, gameId, [permission]);
    await tx.rolePermission.upsert({
      where,
      create: {
        roleId,
        permissionKey: permission,
        value,
        context: storedContext(context) ?? Prisma.DbNull,
        contextKey,
      },
      update: { value },
    });

    const events: (PermissionGrantedEvent | PermissionRevokedEvent | RoleUpdatedEvent)[] = [];
    if (contextKey !== "") {
      const shown = { permission, ...contextField(context) };
      const diff: EntryDiff = existing
        ? { added: [], removed: [], changed: [{ ...shown, before: existing.value, after: value }] }
        : { added: [{ ...shown, value }], removed: [], changed: [] };
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "role.entries.changed",
          targetId: role.id,
          payload: { roleId: role.id, ...diff } as unknown as Prisma.InputJsonValue,
        },
      });
      events.push(await stageRoleUpdated(tx, gameId, role.groupId, role.id, ["entries"]));
      return { role, events };
    }
    const base = {
      gameId: gameId as GameId,
      groupId: role.groupId as GroupId,
      roleId: role.id as RoleId,
      permission: permission as PermissionKey,
    };
    if (value) {
      const payload: Record<string, unknown> = { roleId: role.id, permission };
      if (existing) payload.before = { value: existing.value };
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "permission.granted",
          targetId: role.id,
          payload: payload as Prisma.InputJsonValue,
        },
      });
      events.push(
        await stageEvent<PermissionGrantedEvent>(tx, { type: "permission.granted", ...base }),
      );
    } else {
      const diff: EntryDiff = existing
        ? {
            added: [],
            removed: [],
            changed: [{ permission, before: existing.value, after: value }],
          }
        : { added: [{ permission, value }], removed: [], changed: [] };
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "role.entries.changed",
          targetId: role.id,
          payload: { roleId: role.id, ...diff } as unknown as Prisma.InputJsonValue,
        },
      });
      if (existing?.value === true) {
        events.push(
          await stageEvent<PermissionRevokedEvent>(tx, { type: "permission.revoked", ...base }),
        );
      }
      events.push(await stageRoleUpdated(tx, gameId, role.groupId, role.id, ["entries"]));
    }
    return { role, events };
  });

  if (outcome.events.length > 0) {
    permissionCache.invalidateGroup(outcome.role.groupId);
    publishStagedEvents(hub, ...outcome.events);
  }
  return loadWireRole(prisma, roleId);
}

// Removes one entry, identified by key and context, whatever its value.
// Idempotent on a missing entry. Removing a global grant emits
// `permission.revoked`; removing a global deny or any contextual entry
// emits `role.updated`. `context` as for `upsertRoleEntry`.
export async function removeRoleEntry(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; permission: string; context?: PermissionContext },
): Promise<WireRole> {
  const { gameId, roleId } = args;
  if (!args.permission) throw Errors.badRequest("permission must not be empty");
  const context = args.context ?? {};
  const contextKey = canonicalContextKey(context);
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const role = await lockScopedRole(tx, gameId, roleId);
    const permission = normalizePermissionKey(mode, args.permission);
    const where = {
      roleId_permissionKey_contextKey: { roleId, permissionKey: permission, contextKey },
    };

    const existing = await tx.rolePermission.findUnique({ where, select: { value: true } });
    if (!existing) return { role, event: null };

    await tx.rolePermission.delete({ where });
    if (existing.value && contextKey === "") {
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "permission.revoked",
          targetId: role.id,
          payload: { roleId: role.id, permission } as Prisma.InputJsonValue,
        },
      });
      const event = await stageEvent<PermissionRevokedEvent>(tx, {
        type: "permission.revoked",
        gameId: gameId as GameId,
        groupId: role.groupId as GroupId,
        roleId: role.id as RoleId,
        permission: permission as PermissionKey,
      });
      return { role, event };
    }
    const diff: EntryDiff = {
      added: [],
      removed: [{ permission, value: existing.value, ...contextField(context) }],
      changed: [],
    };
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId: role.groupId,
        actorUserId: null,
        action: "role.entries.changed",
        targetId: role.id,
        payload: { roleId: role.id, ...diff } as unknown as Prisma.InputJsonValue,
      },
    });
    const event = await stageRoleUpdated(tx, gameId, role.groupId, role.id, ["entries"]);
    return { role, event };
  });

  if (outcome.event) {
    permissionCache.invalidateGroup(outcome.role.groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return loadWireRole(prisma, roleId);
}

// Length of the longest parent chain in an acyclic graph, in edges.
function longestChain(parentsById: ReadonlyMap<string, readonly string[]>): number {
  const memo = new Map<string, number>();
  const visit = (id: string): number => {
    const hit = memo.get(id);
    if (hit !== undefined) return hit;
    let best = 0;
    for (const parent of parentsById.get(id) ?? []) {
      if (parentsById.has(parent)) best = Math.max(best, visit(parent) + 1);
    }
    memo.set(id, best);
    return best;
  };
  let max = 0;
  for (const id of parentsById.keys()) max = Math.max(max, visit(id));
  return max;
}

// Sets a role's full parent list. Parents must be other roles in the
// same group. Every parent write in a group holds that group's graph
// lock while it reads the graph and writes, so two concurrent writes
// cannot each see an acyclic graph and together close a cycle. A lock
// rather than SERIALIZABLE isolation: every write that emits an event
// also bumps the game's event counter, which a serializable transaction
// would fail on whenever any other event in the game commits first.
export async function setRoleParents(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; body: unknown },
): Promise<WireRole> {
  const { parents } = parseBody(setRoleParentsBody, args.body);
  const { gameId, roleId } = args;
  const requested = [...new Set(parents)].sort();

  const outcome = await retryOnSerializationFailure(() =>
    prisma.$transaction(async (tx) => {
      // The graph lock comes before any role row lock. Writing a parent
      // link takes a key-share lock on the parent's row; if a racing
      // write held that row while waiting for the graph lock, the two
      // would deadlock. A role's group never changes, so it can be read
      // before locking.
      const scope = await tx.role.findFirst({
        where: { id: roleId, group: { gameId, softDeletedAt: null } },
        select: { groupId: true },
      });
      if (!scope) throw Errors.notFound("role");
      await lockKey(tx, ["role-graph", scope.groupId]);
      const role = await lockScopedRole(tx, gameId, roleId);
      if (requested.includes(role.id)) throw Errors.parentCycle("a role cannot be its own parent");

      const found = await tx.role.findMany({
        where: { id: { in: requested }, group: { gameId, softDeletedAt: null } },
        select: { id: true, groupId: true },
      });
      if (found.length !== requested.length) throw Errors.notFound("parent role");
      if (found.some((r) => r.groupId !== role.groupId)) {
        throw Errors.roleGroupMismatch("parent roles must belong to the same group");
      }

      const edges = await tx.roleParent.findMany({
        where: { role: { groupId: role.groupId } },
        select: { roleId: true, parentRoleId: true },
      });
      const before = edges
        .filter((e) => e.roleId === role.id)
        .map((e) => e.parentRoleId)
        .sort();
      if (before.length === requested.length && before.every((p, i) => p === requested[i])) {
        return { role, event: null };
      }

      const graph = new Map<string, string[]>();
      const groupRoles = await tx.role.findMany({
        where: { groupId: role.groupId },
        select: { id: true },
      });
      for (const r of groupRoles) graph.set(r.id, []);
      for (const e of edges) if (e.roleId !== role.id) graph.get(e.roleId)?.push(e.parentRoleId);
      graph.set(role.id, requested);
      if (findRoleCycle(graph))
        throw Errors.parentCycle("setting these parents would create a cycle");
      if (longestChain(graph) > MAX_ROLE_DEPTH) {
        throw Errors.badRequest(
          `role inheritance would exceed the depth limit of ${MAX_ROLE_DEPTH}`,
        );
      }

      await tx.roleParent.deleteMany({ where: { roleId: role.id } });
      if (requested.length > 0) {
        await tx.roleParent.createMany({
          data: requested.map((parentRoleId) => ({ roleId: role.id, parentRoleId })),
        });
      }
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: role.groupId,
          actorUserId: null,
          action: "role.parents.set",
          targetId: role.id,
          payload: { roleId: role.id, before, after: requested } as Prisma.InputJsonValue,
        },
      });
      const event = await stageRoleUpdated(tx, gameId, role.groupId, role.id, ["parents"]);
      return { role, event };
    }),
  );

  if (outcome.event) {
    permissionCache.invalidateGroup(outcome.role.groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return loadWireRole(prisma, roleId);
}

// Role names are unique per group exactly as stored; in "nodes" mode
// they are also unique ignoring case. The advisory lock serializes name
// writes in one group so two case variants cannot both pass the check.
export async function assertRoleNameAvailable(
  tx: Tx,
  mode: PermissionMode,
  groupId: string,
  name: string,
  exceptRoleId?: string,
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`role-name:${groupId}`}, 0))`,
  );
  const clash = await tx.role.findFirst({
    where: {
      groupId,
      name: mode === "nodes" ? { equals: name, mode: "insensitive" } : name,
      ...(exceptRoleId ? { id: { not: exceptRoleId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw Errors.roleNameTaken();
}

// Stages `role.updated` for every role that inherits from `roleId`,
// whose parent lists shrink when it is deleted. Call inside the delete
// transaction, before the delete.
export async function stageChildrenOfDeletedRole(
  tx: Tx,
  gameId: string,
  groupId: string,
  roleId: string,
): Promise<RoleUpdatedEvent[]> {
  const children = await tx.roleParent.findMany({
    where: { parentRoleId: roleId },
    select: { roleId: true },
    orderBy: { roleId: "asc" },
  });
  const events: RoleUpdatedEvent[] = [];
  for (const child of children) {
    events.push(await stageRoleUpdated(tx, gameId, groupId, child.roleId, ["parents"]));
  }
  return events;
}

export interface RoleFieldsInput {
  name?: string;
  priority?: number;
  color?: string | null;
  isDefault?: boolean;
  metadata?: Record<string, unknown>;
}

// Creates a role in a group the caller has already scoped to the game.
export async function createRole(
  prisma: PrismaClient,
  hub: EventHub,
  args: {
    gameId: string;
    groupId: string;
    body: RoleFieldsInput & { name: string; priority: number };
  },
): Promise<WireRole> {
  const { gameId, groupId, body } = args;
  const { role, event } = await prisma
    .$transaction(async (tx) => {
      const mode = await lockPermissionMode(tx, gameId);
      await assertRoleNameAvailable(tx, mode, groupId, body.name);
      const created = await tx.role.create({
        data: {
          groupId,
          name: body.name,
          priority: body.priority,
          color: body.color ?? null,
          isDefault: body.isDefault ?? false,
          metadata: (body.metadata ?? {}) as Prisma.InputJsonValue,
        },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId,
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
        groupId: groupId as GroupId,
        role: toPublicRole(created),
      });
      return { role: created, event: staged };
    })
    .catch((err) => {
      // Loser of a concurrent same-name create. Same answer the
      // sequential second caller gets; the rollback drops the staged
      // webhook deliveries.
      if (isUniqueViolation(err)) throw Errors.roleNameTaken();
      throw err;
    });

  publishStagedEvents(hub, event);
  return serializeRole(role);
}

// Updates a role's own fields. Unchanged fields are ignored; a request
// that changes nothing writes nothing. Emits `role.updated` naming the
// changed fields.
export async function updateRole(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; body: RoleFieldsInput },
): Promise<WireRole> {
  const { gameId, roleId, body } = args;
  const outcome = await prisma
    .$transaction(async (tx) => {
      const mode = await lockPermissionMode(tx, gameId);
      const existing = await lockScopedRole(tx, gameId, roleId);

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.RoleUpdateInput = {};
      const changed: RoleChangeField[] = [];

      if (body.name !== undefined && body.name !== existing.name) {
        await assertRoleNameAvailable(tx, mode, existing.groupId, body.name, existing.id);
        before.name = existing.name;
        after.name = body.name;
        data.name = body.name;
        changed.push("name");
      }
      if (body.priority !== undefined && body.priority !== existing.priority) {
        before.priority = existing.priority;
        after.priority = body.priority;
        data.priority = body.priority;
        changed.push("priority");
      }
      if (body.color !== undefined && body.color !== existing.color) {
        before.color = existing.color;
        after.color = body.color;
        data.color = body.color;
        changed.push("color");
      }
      if (body.isDefault !== undefined && body.isDefault !== existing.isDefault) {
        before.isDefault = existing.isDefault;
        after.isDefault = body.isDefault;
        data.isDefault = body.isDefault;
        changed.push("isDefault");
      }
      if (
        body.metadata !== undefined &&
        JSON.stringify(body.metadata) !== JSON.stringify(existing.metadata ?? {})
      ) {
        before.metadata = existing.metadata;
        after.metadata = body.metadata;
        data.metadata = body.metadata as Prisma.InputJsonValue;
        changed.push("metadata");
      }
      if (changed.length === 0) return { role: existing, event: null };

      const result = await tx.role.update({ where: { id: existing.id }, data });
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
      const event = await stageRoleUpdated(tx, gameId, existing.groupId, existing.id, changed);
      return { role: result, event };
    })
    .catch((err) => {
      if (isUniqueViolation(err)) throw Errors.roleNameTaken();
      throw err;
    });

  if (outcome.event) {
    // Priority decides which role a result reports.
    permissionCache.invalidateGroup(outcome.role.groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return loadWireRole(prisma, roleId);
}

// Sets a member override, identified by key and context, storing the
// key in the game's mode. Idempotent on a matching `grant`, which
// leaves the member version alone. The first sight of a key
// auto-registers `PermissionDef`. `ifMatch`, when set, is checked
// against the member version under the member row lock. `context` as
// for `upsertRoleEntry`. Returns the stored row and the member version
// after the call.
export async function setMemberOverride(
  prisma: PrismaClient,
  hub: EventHub,
  args: {
    gameId: string;
    groupId: string;
    groupMemberId: string;
    externalUserId: string;
    permission: string;
    grant: boolean;
    context?: PermissionContext;
    ifMatch?: number | null;
  },
): Promise<{ row: MemberPermissionOverride; memberVersion: number }> {
  const { gameId, groupId, groupMemberId, grant } = args;
  const context = args.context ?? {};
  const contextKey = canonicalContextKey(context);
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const permission = keyForWrite(mode, args.permission);
    const current = await lockMemberVersion(tx, groupMemberId, args.ifMatch ?? null);
    const where = {
      groupMemberId_permissionKey_contextKey: {
        groupMemberId,
        permissionKey: permission,
        contextKey,
      },
    };
    const existing = await tx.memberPermissionOverride.findUnique({ where });
    if (existing && existing.grant === grant) {
      return { row: existing, memberVersion: current, changed: false as const };
    }

    await registerKeys(tx, gameId, [permission]);
    const row = await tx.memberPermissionOverride.upsert({
      where,
      create: {
        groupMemberId,
        permissionKey: permission,
        grant,
        setByUserId: null,
        context: storedContext(context) ?? Prisma.DbNull,
        contextKey,
      },
      update: { grant, setAt: new Date() },
    });
    const auditPayload: Record<string, unknown> = {
      memberId: groupMemberId,
      permission,
      grant,
      ...contextField(context),
    };
    if (existing) auditPayload.before = { grant: existing.grant };
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId,
        actorUserId: null,
        action: "permission.override.set",
        targetId: args.externalUserId,
        payload: auditPayload as Prisma.InputJsonValue,
      },
    });
    const memberVersion = await bumpMemberVersion(tx, groupMemberId);
    const event = await stageMemberOverridesChanged(
      tx,
      gameId,
      groupId,
      args.externalUserId,
      memberVersion,
    );
    return { row, memberVersion, changed: true as const, event };
  });
  if (outcome.changed) {
    permissionCache.invalidateGroup(groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return { row: outcome.row, memberVersion: outcome.memberVersion };
}

// Clears a member override, identified by key and context. Idempotent
// on a missing override, which leaves the member version alone; the
// PermissionDef catalog is preserved. `ifMatch` and `context` as for
// `setMemberOverride`. Returns the member version after the call.
export async function clearMemberOverride(
  prisma: PrismaClient,
  hub: EventHub,
  args: {
    gameId: string;
    groupId: string;
    groupMemberId: string;
    externalUserId: string;
    permission: string;
    context?: PermissionContext;
    ifMatch?: number | null;
  },
): Promise<number> {
  const { gameId, groupId, groupMemberId } = args;
  if (!args.permission) throw Errors.badRequest("permission must not be empty");
  const context = args.context ?? {};
  const contextKey = canonicalContextKey(context);
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const permission = normalizePermissionKey(mode, args.permission);
    const current = await lockMemberVersion(tx, groupMemberId, args.ifMatch ?? null);
    const where = {
      groupMemberId_permissionKey_contextKey: {
        groupMemberId,
        permissionKey: permission,
        contextKey,
      },
    };
    const existing = await tx.memberPermissionOverride.findUnique({ where });
    if (!existing) return { memberVersion: current, event: null };
    await tx.memberPermissionOverride.delete({ where });
    const memberVersion = await bumpMemberVersion(tx, groupMemberId);
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId,
        actorUserId: null,
        action: "permission.override.cleared",
        targetId: args.externalUserId,
        payload: {
          memberId: groupMemberId,
          permission,
          grant: existing.grant,
          ...contextField(context),
        } as Prisma.InputJsonValue,
      },
    });
    const event = await stageMemberOverridesChanged(
      tx,
      gameId,
      groupId,
      args.externalUserId,
      memberVersion,
    );
    return { memberVersion, event };
  });
  if (outcome.event) {
    permissionCache.invalidateGroup(groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return outcome.memberVersion;
}

function stageMemberOverridesChanged(
  tx: Tx,
  gameId: string,
  groupId: string,
  externalUserId: string,
  memberVersion: number,
): Promise<MemberUpdatedEvent> {
  return stageEvent<MemberUpdatedEvent>(tx, {
    type: "member.updated",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    userId: externalUserId as UserId,
    changed: ["overrides"],
    memberVersion,
  });
}

// Deletes a role that no member holds. Roles that inherited from it
// lose it as a parent, and each gets a `role.updated` event.
export async function deleteRole(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string },
): Promise<void> {
  const { gameId, roleId } = args;
  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await lockScopedRole(tx, gameId, roleId);
    const memberCount = await tx.memberRole.count({ where: { roleId: existing.id } });
    if (memberCount > 0) throw Errors.roleHasMembers();

    const childEvents = await stageChildrenOfDeletedRole(tx, gameId, existing.groupId, existing.id);
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
    const deleted = await stageEvent<RoleDeletedEvent>(tx, {
      type: "role.deleted",
      gameId: gameId as GameId,
      groupId: existing.groupId as GroupId,
      roleId: existing.id as RoleId,
    });
    return { groupId: existing.groupId, events: [deleted, ...childEvents] };
  });
  permissionCache.invalidateGroup(outcome.groupId);
  publishStagedEvents(hub, ...outcome.events);
}

export { stageRoleUpdated };
