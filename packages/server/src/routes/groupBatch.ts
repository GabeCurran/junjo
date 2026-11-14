import type { JunjoEvent } from "@junjo.io/shared";
import {
  type Group,
  type GroupMember,
  type GroupRelationship,
  Prisma,
  type PrismaClient,
} from "@prisma/client";
import type { Handler } from "hono";
import { banErrorMessage, checkBanState } from "../bans.js";
import { Errors, JunjoError } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { type GroupVersionHandle, readGroupVersion, trackGroupVersion } from "../eventLog.js";
import { publishStagedEvents } from "../events.js";
import { loadKindLimits, lockGroupMembership, lockPerUserCounts } from "../groupKinds.js";
import {
  type GroupOpContext,
  addMemberInTx,
  assignRoleInTx,
  banMemberInTx,
  clearRelationshipInTx,
  kickMemberInTx,
  leaveGroupInTx,
  loadGroupRole,
  planMemberUpdate,
  setRelationshipInTx,
  unassignRoleInTx,
  unbanMemberInTx,
  updateGroupInTx,
  updateMemberInTx,
} from "../groupOps.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";
import { lockKey } from "../locks.js";
import { permissionCache } from "../permissionCache.js";
import { isNulCharacterError, retryOnUniqueViolation } from "../prismaErrors.js";
import { type WireRole, loadRoleDetail, serializeRole } from "../roleDetails.js";
import { lockPermissionMode, removeRoleEntryInTx, upsertRoleEntryInTx } from "../roleWrites.js";
import { assertGroupVersion, readGroupIfMatch, setGroupEtag } from "../versions.js";
import { type BatchOp, parseGroupBatchBody } from "./groupBatch.schema.js";
import { serializeGroup } from "./groupWire.js";
import { loadMemberRoleIds, serializeMemberFor } from "./members.js";
import { serializeGroupRelationship } from "./relationships.js";

// POST /v1/groups/:id/batch: an ordered list of writes to one group,
// applied in one transaction, all or none. Each op runs the same
// transaction body as its single route (groupOps.ts, roleWrites.ts) and
// sees the effects of the ops before it. The first op that fails rolls
// the whole batch back (rows, audit, event log, webhook deliveries,
// version) and its error is the answer, with `details.opIndex` added.
// Staged events are published, in op order, only after commit.

type Tx = Prisma.TransactionClient;

// Ops are few and short, but a full batch can run several hundred
// statements; the default interactive transaction timeout is too tight.
const BATCH_TIMEOUT_MS = 30_000;

// What an op answers, captured inside the transaction right after the
// op so it describes the state the op left; serialized after commit.
type OpResult =
  | { kind: "member"; row: GroupMember; userId: string; roleIds: string[] }
  | { kind: "group"; row: Group; memberCount: number }
  | { kind: "role"; wire: WireRole }
  | { kind: "relationship"; row: GroupRelationship }
  | { kind: "none" };

interface BatchRun {
  results: OpResult[];
  events: JunjoEvent[];
  permissionsChanged: boolean;
  // Set once an op soft-deleted the group (a departure that emptied a
  // kind that deletes empty groups); every later op then answers 404 as
  // its single route would.
  groupDeleted: boolean;
}

// External id to person, for every id the ops name; null for an id no
// person has. Resolved before the transaction because creating a person
// needs a transaction of its own (see `findOrCreateJunjoUser`): people
// an op would create on its single route (an added or banned user, any
// actor) are created here and stay when the batch rolls back, as they
// do when a single route fails after resolving them.
interface ResolvedPeople {
  ids: Map<string, string | null>;
  // The first op whose ids could not be resolved (a malformed id). Its
  // error is raised when the batch reaches that op, so an earlier op's
  // failure still wins.
  failure: { index: number; error: unknown } | null;
}

function namedPeople(op: BatchOp): { id: string; create: boolean }[] {
  const actor = "actorUserId" in op && op.actorUserId ? [{ id: op.actorUserId, create: true }] : [];
  switch (op.op) {
    case "member.add":
    case "member.ban":
      return [{ id: op.userId, create: true }, ...actor];
    case "member.kick":
    case "member.unban":
    case "member.role.add":
    case "member.role.remove":
      return [{ id: op.userId, create: false }, ...actor];
    case "member.leave":
    case "member.update":
      return [{ id: op.userId, create: false }];
    default:
      return actor;
  }
}

async function resolvePeople(
  prisma: PrismaClient,
  gameId: string,
  ops: readonly BatchOp[],
): Promise<ResolvedPeople> {
  const ids = new Map<string, string | null>();
  for (const [index, op] of ops.entries()) {
    try {
      for (const { id, create } of namedPeople(op)) {
        if (create) {
          if (!ids.get(id)) ids.set(id, await findOrCreateJunjoUser(prisma, gameId, id));
        } else if (!ids.has(id)) {
          ids.set(id, await findJunjoUserId(prisma, gameId, id));
        }
      }
    } catch (error) {
      return { ids, failure: { index, error } };
    }
  }
  return { ids, failure: null };
}

// Takes every lock the ops will need, in one fixed order, before the
// first op runs. The caller holds the group row lock already. Order:
//
// 1. Group row (`lockGroupMembership`): batches on one group serialize,
//    and every membership writer takes it before any member row.
// 2. Kind-limit advisory locks for every person a `member.add` may
//    activate, in one sorted pass, so two batches on different groups
//    of one kind cannot take them in opposite orders. Single adds take
//    them in the same position (after the group lock), and identity
//    merges take them before person rows, as step 3 does.
// 3. Person rows FOR KEY SHARE, sorted: the rows the member, ban history
//    and other inserts reference. A merge or person delete locks the
//    person and then that person's member rows; holding these first
//    means it cannot wait on a member row the batch holds while the
//    batch waits on its person row.
// 4. The group's member rows of those people FOR UPDATE, sorted. Rows
//    the batch creates are invisible to others until commit.
// 5. Only when a role-entry op is present: the Game row FOR SHARE (the
//    permission mode), the group's role-graph advisory lock, then the
//    roles the ops name FOR UPDATE, sorted. Roles come after members,
//    as on a single role assignment (member row, then the insert's key
//    share on the role). The graph lock comes first so a parent write,
//    which holds it and one role and then key-shares the parents,
//    cannot hold a role the batch needs while waiting on one it holds.
//    Every role lock is held before the first permission key is
//    registered, so a single entry write that waits on the batch's
//    catalog insert never holds a role the batch still needs.
//
// The Game row is only ever share-locked by key writers and by the
// member import (which takes it before the group row); share locks do
// not wait on each other, and its one exclusive taker, the config
// write, while holding it waits only on permission entry, override and
// catalog rows, which a batch writes only after it holds the share
// lock. No write path takes the Game share lock or a role row lock and
// then waits on a group row lock held FOR NO KEY UPDATE: role inserts
// key-share the group row, which does not conflict. Without a
// role-entry op a batch locks no role row; the key share its role
// assignments take waits only on single role writes, none of which
// waits on a lock the batch holds.
async function lockBatchRows(
  tx: Tx,
  ctx: GroupOpContext,
  ops: readonly BatchOp[],
  people: ReadonlyMap<string, string | null>,
): Promise<void> {
  const { gameId, group, limits } = ctx;
  const known = (ids: (string | null | undefined)[]) =>
    [...new Set(ids.filter((id): id is string => typeof id === "string"))].sort();

  if (limits?.maxPerUser !== undefined) {
    const activated = known(
      ops.map((op) => (op.op === "member.add" ? people.get(op.userId) : null)),
    );
    if (activated.length > 0) await lockPerUserCounts(tx, gameId, [group.kind], activated);
  }

  const persons = known([...people.values()]);
  if (persons.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "JunjoUser" WHERE id = ANY(${persons}::text[])
      ORDER BY id FOR KEY SHARE
    `);
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "GroupMember"
      WHERE "groupId" = ${group.id} AND "junjoUserId" = ANY(${persons}::text[])
      ORDER BY id FOR UPDATE
    `);
  }

  if (!ops.some((op) => op.op === "role.entry.set" || op.op === "role.entry.remove")) return;
  await lockPermissionMode(tx, gameId);
  await lockKey(tx, ["role-graph", group.id]);
  const roles = known(
    ops.map((op) =>
      op.op === "role.entry.set" ||
      op.op === "role.entry.remove" ||
      op.op === "member.role.add" ||
      op.op === "member.add"
        ? op.roleId
        : null,
    ),
  );
  if (roles.length > 0) {
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM "Role" WHERE id = ANY(${roles}::text[]) AND "groupId" = ${group.id}
      ORDER BY id FOR UPDATE
    `);
  }
}

// An op's error with `details.opIndex` added to its own details. A NUL
// character rejected by the database becomes the 400 the error handler
// would give, with the index. Any other error passes through unchanged.
function withOpIndex(err: unknown, index: number): unknown {
  if (err instanceof JunjoError) {
    return new JunjoError(err.code, err.status, err.message, {
      ...(err.details ?? {}),
      opIndex: index,
    });
  }
  if (isNulCharacterError(err)) {
    return new JunjoError(
      "bad_request",
      400,
      "strings must not contain the NUL character (U+0000)",
      { opIndex: index },
    );
  }
  return err;
}

// A role a role-entry op names: 404 when it is missing, in another game
// or in a deleted group, `role_group_mismatch` when it belongs to
// another group of the game. A plain read, so a foreign role is refused
// without taking its row lock.
async function assertBatchRole(tx: Tx, ctx: GroupOpContext, roleId: string): Promise<void> {
  const role = await tx.role.findFirst({
    where: { id: roleId, group: { gameId: ctx.gameId, softDeletedAt: null } },
    select: { groupId: true },
  });
  if (!role) throw Errors.notFound("role");
  if (role.groupId !== ctx.group.id) throw Errors.roleGroupMismatch();
}

async function assertOtherGroup(tx: Tx, ctx: GroupOpContext, otherGroupId: string): Promise<void> {
  if (otherGroupId === ctx.group.id) throw Errors.badRequest("groupAId and groupBId must differ");
  const other = await tx.group.findFirst({
    where: { id: otherGroupId, gameId: ctx.gameId, softDeletedAt: null },
    select: { id: true },
  });
  if (!other) throw Errors.notFound("group");
}

async function memberResult(tx: Tx, row: GroupMember, userId: string): Promise<OpResult> {
  return { kind: "member", row, userId, roleIds: await loadMemberRoleIds(tx, row.id) };
}

async function runOp(
  tx: Tx,
  ctx: GroupOpContext,
  people: ReadonlyMap<string, string | null>,
  run: BatchRun,
  op: BatchOp,
): Promise<OpResult> {
  const { gameId } = ctx;
  const groupId = ctx.group.id;
  // People an op creates were resolved before the transaction.
  const created = (id: string): string => {
    const person = people.get(id);
    if (!person) throw new Error("batch person was not resolved");
    return person;
  };
  const actorOf = (o: { actorUserId?: string }) => (o.actorUserId ? created(o.actorUserId) : null);
  const memberOf = async (userId: string): Promise<GroupMember | null> => {
    const junjoUserId = people.get(userId);
    if (!junjoUserId) return null;
    return tx.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId, junjoUserId } },
    });
  };
  // The op's own event, then the group's deletion when it emptied it.
  const departed = (event: JunjoEvent | null, groupDeleted: JunjoEvent | null) => {
    if (event) run.events.push(event);
    if (groupDeleted) {
      run.events.push(groupDeleted);
      run.groupDeleted = true;
    }
  };

  switch (op.op) {
    case "member.add": {
      const role = op.roleId ? await loadGroupRole(tx, groupId, op.roleId) : null;
      const junjoUserId = created(op.userId);
      const ban = await checkBanState(tx, gameId, junjoUserId, groupId);
      if (ban.banned) throw Errors.banned(banErrorMessage(ban));
      const out = await addMemberInTx(tx, ctx, {
        userId: op.userId,
        junjoUserId,
        role,
        actorUserId: op.actorUserId ?? null,
        actorJunjoUserId: actorOf(op),
        createOnly: op.createOnly === true,
      });
      run.events.push(...out.staged);
      if (out.roleAdded) run.permissionsChanged = true;
      return { kind: "member", row: out.member, userId: op.userId, roleIds: out.roleIds };
    }
    case "member.kick": {
      const member = await memberOf(op.userId);
      if (!member) throw Errors.notFound("member");
      const out = await kickMemberInTx(tx, ctx, {
        memberId: member.id,
        userId: op.userId,
        ifMatch: null,
        reason: op.reason ?? null,
        actorUserId: op.actorUserId ?? null,
        actorJunjoUserId: actorOf(op),
      });
      departed(out.event, out.groupDeleted);
      return memberResult(tx, out.row, op.userId);
    }
    case "member.leave": {
      const member = await memberOf(op.userId);
      if (!member) throw Errors.notFound("member");
      const out = await leaveGroupInTx(tx, ctx, {
        memberId: member.id,
        userId: op.userId,
        junjoUserId: member.junjoUserId,
      });
      departed(out.event, out.groupDeleted);
      return memberResult(tx, out.row, op.userId);
    }
    case "member.ban": {
      const out = await banMemberInTx(tx, ctx, {
        userId: op.userId,
        junjoUserId: created(op.userId),
        ifMatch: null,
        reason: op.reason ?? null,
        expiresAt: op.expiresAt ? new Date(op.expiresAt) : null,
        actorJunjoUserId: actorOf(op),
      });
      departed(out.event, out.groupDeleted);
      return memberResult(tx, out.member, op.userId);
    }
    case "member.unban": {
      const member = await memberOf(op.userId);
      if (!member || member.status !== "banned") throw Errors.banNotActive();
      const out = await unbanMemberInTx(tx, ctx, {
        memberId: member.id,
        userId: op.userId,
        junjoUserId: member.junjoUserId,
        ifMatch: null,
        actorJunjoUserId: actorOf(op),
      });
      run.events.push(out.event);
      return memberResult(tx, out.row, op.userId);
    }
    case "member.update": {
      const member = await memberOf(op.userId);
      if (!member) throw Errors.notFound("member");
      const plan = planMemberUpdate(member, op);
      if (Object.keys(plan.data).length === 0) return memberResult(tx, member, op.userId);
      const out = await updateMemberInTx(tx, ctx, {
        member,
        userId: op.userId,
        ifMatch: null,
        plan,
      });
      run.events.push(out.event);
      return memberResult(tx, out.result, op.userId);
    }
    case "member.role.add":
    case "member.role.remove": {
      const member = await memberOf(op.userId);
      if (!member) throw Errors.notFound("member");
      const adding = op.op === "member.role.add";
      if (adding) await loadGroupRole(tx, groupId, op.roleId);
      const held = await tx.memberRole.findUnique({
        where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: op.roleId } },
      });
      if (adding === (held !== null)) return memberResult(tx, member, op.userId);
      const input = {
        memberId: member.id,
        userId: op.userId,
        roleId: op.roleId,
        ifMatch: null,
        actorUserId: op.actorUserId ?? null,
        actorJunjoUserId: actorOf(op),
      };
      const event = adding
        ? await assignRoleInTx(tx, ctx, input)
        : await unassignRoleInTx(tx, ctx, input);
      if (event) {
        run.events.push(event);
        run.permissionsChanged = true;
      }
      const row = await tx.groupMember.findUniqueOrThrow({ where: { id: member.id } });
      return memberResult(tx, row, op.userId);
    }
    case "group.update": {
      const existing = await tx.group.findFirst({
        where: { id: groupId, gameId, softDeletedAt: null },
      });
      if (!existing) throw Errors.notFound("group");
      const out = await updateGroupInTx(
        tx,
        { gameId },
        {
          existing,
          body: {
            name: op.name,
            visibility: op.visibility,
            metadata: op.metadata,
            defaultRoleId: op.defaultRoleId,
          },
          newPasscodeHash: undefined,
          actorUserId: op.actorUserId ?? null,
          actorJunjoUserId: actorOf(op),
        },
      );
      if (out.event) run.events.push(out.event);
      const memberCount =
        out.memberCount ?? (await tx.groupMember.count({ where: { groupId, status: "active" } }));
      return { kind: "group", row: out.row, memberCount };
    }
    case "role.entry.set": {
      await assertBatchRole(tx, ctx, op.roleId);
      const out = await upsertRoleEntryInTx(tx, {
        gameId,
        roleId: op.roleId,
        permission: op.permission,
        value: op.value ?? true,
        context: op.context,
      });
      run.events.push(...out.events);
      if (out.events.length > 0) run.permissionsChanged = true;
      return { kind: "role", wire: serializeRole(out.role, await loadRoleDetail(tx, out.role.id)) };
    }
    case "role.entry.remove": {
      await assertBatchRole(tx, ctx, op.roleId);
      const out = await removeRoleEntryInTx(tx, {
        gameId,
        roleId: op.roleId,
        permission: op.permission,
        context: op.context,
      });
      if (out.event) {
        run.events.push(out.event);
        run.permissionsChanged = true;
      }
      return { kind: "role", wire: serializeRole(out.role, await loadRoleDetail(tx, out.role.id)) };
    }
    case "relationship.set": {
      await assertOtherGroup(tx, ctx, op.otherGroupId);
      const out = await setRelationshipInTx(tx, gameId, {
        a: groupId,
        b: op.otherGroupId,
        type: op.type,
        mutual: op.mutual,
        actorUserId: op.actorUserId ?? null,
        actorJunjoUserId: actorOf(op),
      });
      run.events.push(...out.events);
      return { kind: "relationship", row: out.primary };
    }
    case "relationship.clear": {
      await assertOtherGroup(tx, ctx, op.otherGroupId);
      const events = await clearRelationshipInTx(tx, gameId, {
        a: groupId,
        b: op.otherGroupId,
        mutual: op.mutual === true,
        actorUserId: op.actorUserId ?? null,
        actorJunjoUserId: actorOf(op),
      });
      run.events.push(...events);
      return { kind: "none" };
    }
  }
}

async function serializeResult(
  prisma: PrismaClient,
  gameId: string,
  result: OpResult,
): Promise<unknown> {
  switch (result.kind) {
    case "member":
      return serializeMemberFor(prisma, gameId, result.row, result.userId, result.roleIds);
    case "group":
      return serializeGroup(result.row, result.memberCount);
    case "role":
      return result.wire;
    case "relationship":
      return serializeGroupRelationship(prisma, gameId, result.row);
    case "none":
      return null;
  }
}

export function groupBatchHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const groupId = c.req.param("id") ?? "";
    const gameId = c.var.gameId;
    const ops = parseGroupBatchBody(await c.req.json().catch(() => null));
    const ifMatch = readGroupIfMatch(c);

    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");
    const people = await resolvePeople(prisma, gameId, ops);

    // Rerun once on a unique-key race with a writer outside the group
    // lock; the rerun sees the winner's row, as a sequential second
    // request would. The rollback drops everything the first run staged.
    let version: GroupVersionHandle | null = null;
    const run = await retryOnUniqueViolation(() =>
      prisma.$transaction(
        async (tx) => {
          const locked = await lockGroupMembership(tx, group.id);
          // Checked again when the batch's events are logged, under the
          // game's counter lock; this early read only fails a stale
          // batch before it does any work. Versions only increase.
          version = trackGroupVersion(tx, gameId, group.id, ifMatch);
          if (ifMatch !== null) assertGroupVersion(ifMatch, await readGroupVersion(tx, group.id));
          const ctx: GroupOpContext = {
            gameId,
            group: locked,
            limits: await loadKindLimits(tx, gameId, locked.kind),
          };
          await lockBatchRows(tx, ctx, ops, people.ids);

          const state: BatchRun = {
            results: [],
            events: [],
            permissionsChanged: false,
            groupDeleted: false,
          };
          for (const [index, op] of ops.entries()) {
            try {
              if (people.failure?.index === index) throw people.failure.error;
              if (state.groupDeleted) throw Errors.notFound("group");
              state.results.push(await runOp(tx, ctx, people.ids, state, op));
            } catch (err) {
              throw withOpIndex(err, index);
            }
          }
          return state;
        },
        { timeout: BATCH_TIMEOUT_MS },
      ),
    );

    if (run.permissionsChanged) permissionCache.invalidateGroup(group.id);
    publishStagedEvents(hub, ...run.events);
    const results: unknown[] = [];
    for (const result of run.results) results.push(await serializeResult(prisma, gameId, result));
    const value = (version as GroupVersionHandle | null)?.value ?? null;
    setGroupEtag(c, value);
    return c.json({ version: (value ?? 0n).toString(), results });
  };
}
