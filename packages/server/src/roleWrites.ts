import type {
  GameId,
  GroupId,
  PartialGameConfig,
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
} from "@junjo.io/shared";
import {
  type MemberPermissionOverride,
  Prisma,
  type PrismaClient,
  type Role,
} from "@prisma/client";
import type { ZodTypeAny, z } from "zod";
import { resolveGameConfig } from "./config/defaults.js";
import { Errors } from "./errors.js";
import type { EventHub } from "./eventHub.js";
import { publishStagedEvents, stageEvent, toPublicRole } from "./events.js";
import { permissionCache } from "./permissionCache.js";
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

// Role and permission-key writes shared by the per-game and admin
// routes. Every write that stores a permission key reads the game's
// mode under a share lock on the Game row, so it cannot interleave with
// a mode switch, which takes the same row for update.

type Tx = Prisma.TransactionClient;

export function parseBody<S extends ZodTypeAny>(schema: S, json: unknown): z.infer<S> {
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw Errors.badRequest(issues || "invalid request body");
  }
  return parsed.data;
}

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

async function respond(prisma: PrismaClient, roleId: string): Promise<WireRole> {
  const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } });
  return serializeRole(role, await loadRoleDetail(prisma, roleId));
}

export interface EntryDiff {
  added: PermissionEntry[];
  removed: PermissionEntry[];
  changed: { permission: string; before: boolean; after: boolean }[];
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

      const next = new Map<string, boolean>();
      for (const entry of entries) {
        const key = keyForWrite(mode, entry.permission);
        if (next.has(key)) {
          throw Errors.badRequest(`duplicate permission ${JSON.stringify(key)} in entries`);
        }
        next.set(key, entry.value);
      }

      const current = await tx.rolePermission.findMany({
        where: { roleId },
        select: { permissionKey: true, value: true },
      });
      const prev = new Map(current.map((r) => [r.permissionKey, r.value]));
      const diff: EntryDiff = { added: [], removed: [], changed: [] };
      for (const [permission, value] of next) {
        const before = prev.get(permission);
        if (before === undefined) diff.added.push({ permission, value });
        else if (before !== value) diff.changed.push({ permission, before, after: value });
      }
      for (const [permission, value] of prev) {
        if (!next.has(permission)) diff.removed.push({ permission, value });
      }
      if (isEmptyDiff(diff)) return { role, event: null };

      if (diff.removed.length > 0) {
        await tx.rolePermission.deleteMany({
          where: { roleId, permissionKey: { in: diff.removed.map((e) => e.permission) } },
        });
      }
      for (const value of [true, false]) {
        const keys = diff.changed.filter((c) => c.after === value).map((c) => c.permission);
        if (keys.length > 0) {
          await tx.rolePermission.updateMany({
            where: { roleId, permissionKey: { in: keys } },
            data: { value },
          });
        }
      }
      if (diff.added.length > 0) {
        await tx.rolePermission.createMany({
          data: diff.added.map((e) => ({ roleId, permissionKey: e.permission, value: e.value })),
        });
        await registerKeys(
          tx,
          gameId,
          diff.added.map((e) => e.permission),
        );
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
  return respond(prisma, roleId);
}

// Adds or updates one entry. Idempotent when the entry already holds
// `value`. A change the legacy events fully describe (a key entering
// the granted set) emits only `permission.granted`; a key leaving the
// granted set emits `permission.revoked`; any change involving a deny
// also emits `role.updated`.
export async function upsertRoleEntry(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; permission: string; value: boolean },
): Promise<WireRole> {
  const { gameId, roleId, value } = args;
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const role = await lockScopedRole(tx, gameId, roleId);
    const permission = keyForWrite(mode, args.permission);

    const existing = await tx.rolePermission.findUnique({
      where: { roleId_permissionKey: { roleId, permissionKey: permission } },
      select: { value: true },
    });
    if (existing?.value === value) return { role, events: [] };
    if (!existing) {
      const count = await tx.rolePermission.count({ where: { roleId } });
      if (count >= MAX_ROLE_ENTRIES) {
        throw Errors.badRequest(`role already has the maximum of ${MAX_ROLE_ENTRIES} entries`);
      }
    }

    await registerKeys(tx, gameId, [permission]);
    await tx.rolePermission.upsert({
      where: { roleId_permissionKey: { roleId, permissionKey: permission } },
      create: { roleId, permissionKey: permission, value },
      update: { value },
    });

    const events: (PermissionGrantedEvent | PermissionRevokedEvent | RoleUpdatedEvent)[] = [];
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
  return respond(prisma, roleId);
}

// Removes one entry whatever its value. Idempotent on a missing entry.
// Removing a grant emits `permission.revoked` as it always has;
// removing a deny emits `role.updated`.
export async function removeRoleEntry(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; permission: string },
): Promise<WireRole> {
  const { gameId, roleId } = args;
  if (!args.permission) throw Errors.badRequest("permission must not be empty");
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const role = await lockScopedRole(tx, gameId, roleId);
    const permission = normalizePermissionKey(mode, args.permission);

    const existing = await tx.rolePermission.findUnique({
      where: { roleId_permissionKey: { roleId, permissionKey: permission } },
      select: { value: true },
    });
    if (!existing) return { role, event: null };

    await tx.rolePermission.delete({
      where: { roleId_permissionKey: { roleId, permissionKey: permission } },
    });
    if (existing.value) {
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
    const diff: EntryDiff = { added: [], removed: [{ permission, value: false }], changed: [] };
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
  return respond(prisma, roleId);
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
// same group. The cycle and depth checks read the whole group's parent
// graph inside a SERIALIZABLE transaction together with the write, so
// two concurrent writes cannot each see an acyclic graph and together
// close a cycle; the loser aborts, is retried, and is rejected.
export async function setRoleParents(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; roleId: string; body: unknown },
): Promise<WireRole> {
  const { parents } = parseBody(setRoleParentsBody, args.body);
  const { gameId, roleId } = args;
  const requested = [...new Set(parents)].sort();

  const outcome = await retryOnSerializationFailure(() =>
    prisma.$transaction(
      async (tx) => {
        const role = await lockScopedRole(tx, gameId, roleId);
        if (requested.includes(role.id))
          throw Errors.parentCycle("a role cannot be its own parent");

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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  if (outcome.event) {
    permissionCache.invalidateGroup(outcome.role.groupId);
    publishStagedEvents(hub, outcome.event);
  }
  return respond(prisma, roleId);
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
  return respond(prisma, roleId);
}

// Sets a member override, storing the key in the game's mode.
// Idempotent on a matching `grant`. The first sight of a key
// auto-registers `PermissionDef`.
export async function setMemberOverride(
  prisma: PrismaClient,
  args: {
    gameId: string;
    groupId: string;
    groupMemberId: string;
    externalUserId: string;
    permission: string;
    grant: boolean;
  },
): Promise<MemberPermissionOverride> {
  const { gameId, groupId, groupMemberId, grant } = args;
  const outcome = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const permission = keyForWrite(mode, args.permission);
    const where = { groupMemberId_permissionKey: { groupMemberId, permissionKey: permission } };
    const existing = await tx.memberPermissionOverride.findUnique({ where });
    if (existing && existing.grant === grant) return { row: existing, changed: false };

    await registerKeys(tx, gameId, [permission]);
    const row = await tx.memberPermissionOverride.upsert({
      where,
      create: { groupMemberId, permissionKey: permission, grant, setByUserId: null },
      update: { grant, setAt: new Date() },
    });
    const auditPayload: Record<string, unknown> = { memberId: groupMemberId, permission, grant };
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
    return { row, changed: true };
  });
  if (outcome.changed) permissionCache.invalidateGroup(groupId);
  return outcome.row;
}

// Clears a member override. Idempotent on a missing override; the
// PermissionDef catalog is preserved.
export async function clearMemberOverride(
  prisma: PrismaClient,
  args: {
    gameId: string;
    groupId: string;
    groupMemberId: string;
    externalUserId: string;
    permission: string;
  },
): Promise<void> {
  const { gameId, groupId, groupMemberId } = args;
  if (!args.permission) throw Errors.badRequest("permission must not be empty");
  const cleared = await prisma.$transaction(async (tx) => {
    const mode = await lockPermissionMode(tx, gameId);
    const permission = normalizePermissionKey(mode, args.permission);
    const where = { groupMemberId_permissionKey: { groupMemberId, permissionKey: permission } };
    const existing = await tx.memberPermissionOverride.findUnique({ where });
    if (!existing) return false;
    await tx.memberPermissionOverride.delete({ where });
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
        } as Prisma.InputJsonValue,
      },
    });
    return true;
  });
  if (cleared) permissionCache.invalidateGroup(groupId);
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
