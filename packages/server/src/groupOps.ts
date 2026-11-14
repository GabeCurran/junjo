import type {
  GameId,
  GroupDeletedEvent,
  GroupId,
  GroupKindLimits,
  GroupRelationshipChangedEvent,
  GroupUpdatedEvent,
  JunjoEvent,
  MemberBannedEvent,
  MemberChangeField,
  MemberJoinedEvent,
  MemberLeftEvent,
  MemberUnbannedEvent,
  MemberUpdatedEvent,
  RoleChangedEvent,
  RoleId,
  UserId,
} from "@junjo.io/shared";
import type { Group, GroupMember, GroupRelationship, Prisma } from "@prisma/client";
import type { Db } from "./db.js";
import { Errors } from "./errors.js";
import { stageEvent, toPublicGroup, toPublicGroupRelationship, toPublicMember } from "./events.js";
import { type MembershipGroup, afterMembershipChange, assertCanActivate } from "./groupKinds.js";
import { loadMemberRoleIds } from "./routes/members.js";
import { assertVersion, bumpMemberVersion, lockMember, lockMemberVersion } from "./versions.js";

// Transaction-level bodies of the single-group writes, shared by their
// routes and by the group batch. Each one runs inside the caller's
// transaction, stages its events there and returns them; the caller
// publishes them after commit and answers from the returned rows.
//
// Every function that changes who is an active member requires the
// caller to hold `lockGroupMembership` on `ctx.group`, taken before any
// member row lock, so the lock order stays group before member.

type Tx = Prisma.TransactionClient;

export interface GroupOpContext {
  gameId: string;
  group: MembershipGroup;
  // The kind limits of `ctx.group`; null when the kind is not listed or
  // the op does not consult them.
  limits: GroupKindLimits | null;
}

// The role `roleId` when it belongs to `groupId`: 404 when there is no
// such role, `role_group_mismatch` when it belongs to another group.
export async function loadGroupRole(
  db: Db,
  groupId: string,
  roleId: string,
): Promise<{ id: string; groupId: string }> {
  const role = await db.role.findUnique({
    where: { id: roleId },
    select: { id: true, groupId: true },
  });
  if (!role) throw Errors.notFound("role");
  if (role.groupId !== groupId) throw Errors.roleGroupMismatch();
  return role;
}

// =====================================================================
// Membership
// =====================================================================

export interface AddMemberInput {
  userId: string;
  junjoUserId: string;
  // Already checked to belong to the group.
  role: { id: string } | null;
  actorUserId: string | null;
  actorJunjoUserId: string | null;
  createOnly: boolean;
  // Runs with the existing row just before the create-only refusal.
  onCreateOnlyConflict?: (existing: GroupMember) => void;
}

export interface AddMemberOutcome {
  member: GroupMember;
  roleIds: string[];
  wasActive: boolean;
  roleAdded: boolean;
  staged: JunjoEvent[];
}

// Makes the person an active member (creating or reactivating the row)
// and assigns `role` when given and not yet held. Idempotent on an
// active member that already holds the role. Requires the group lock.
export async function addMemberInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: AddMemberInput,
): Promise<AddMemberOutcome> {
  const { gameId, group: locked, limits } = ctx;
  const { userId, junjoUserId, role, actorUserId, actorJunjoUserId } = input;
  const groupId = locked.id;
  const existing = await tx.groupMember.findUnique({
    where: { groupId_junjoUserId: { groupId, junjoUserId } },
  });
  // Decided under the membership lock, after the row read. A writer
  // that created the row concurrently is seen here once it commits;
  // one that did not take the lock makes the create below fail on
  // the unique key, and the retry reaches this check and sees it.
  if (input.createOnly && existing) {
    input.onCreateOnlyConflict?.(existing);
    throw Errors.preconditionFailed(
      `If-None-Match * failed: the user already has a membership row in this group with status ${existing.status}`,
      { memberStatus: existing.status },
    );
  }
  const wasActive = existing?.status === "active";
  if (!wasActive) {
    await assertCanActivate(tx, locked, limits, junjoUserId);
    await afterMembershipChange(tx, locked, limits, false);
  }

  let member = existing;
  if (!existing) {
    member = await tx.groupMember.create({
      data: { groupId, junjoUserId, status: "active" },
    });
  } else if (!wasActive) {
    // Reactivate from left / kicked, keeping the original
    // joinedAt. Matches the public join path.
    member = await tx.groupMember.update({
      where: { id: existing.id },
      data: { status: "active", leftAt: null, bannedUntil: null, version: { increment: 1 } },
    });
  }
  if (!member) throw new Error("member row missing after upsert");

  // A role added below also emits role.changed at the same
  // memberVersion as the member.joined snapshot, which includes it.
  const priorRoleIds = existing ? await loadMemberRoleIds(tx, member.id) : [];
  const roleAdded = role !== null && !priorRoleIds.includes(role.id);
  // One write, one version step: a create or reactivation already
  // moved it, so only a role added to an already-active member
  // bumps here.
  if (wasActive && roleAdded) {
    member = { ...member, version: await bumpMemberVersion(tx, member.id) };
  }

  const staged: JunjoEvent[] = [];
  if (!wasActive) {
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId,
        actorUserId: actorJunjoUserId,
        action: "member.joined",
        targetId: userId,
        payload: {
          memberId: member.id,
          via: "admin-add",
        } as Prisma.InputJsonValue,
      },
    });
    staged.push(
      await stageEvent<MemberJoinedEvent>(tx, {
        type: "member.joined",
        gameId: gameId as GameId,
        groupId: groupId as GroupId,
        userId: userId as UserId,
        member: toPublicMember(
          member,
          userId,
          roleAdded && role ? [...priorRoleIds, role.id] : priorRoleIds,
        ),
        memberVersion: member.version,
      }),
    );
  }

  if (role && roleAdded) {
    await tx.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId,
        actorUserId: actorJunjoUserId,
        action: "role.assigned",
        targetId: userId,
        payload: {
          memberId: member.id,
          roleId: role.id,
        } as Prisma.InputJsonValue,
      },
    });
    staged.push(
      await stageEvent<RoleChangedEvent>(tx, {
        type: "role.changed",
        gameId: gameId as GameId,
        groupId: groupId as GroupId,
        userId: userId as UserId,
        added: [role.id as RoleId],
        removed: [],
        actorUserId: actorUserId as UserId | null,
        memberVersion: member.version,
      }),
    );
  }

  const roleIds = roleAdded && role ? [...priorRoleIds, role.id] : priorRoleIds;
  return { member, roleIds, wasActive, roleAdded, staged };
}

export interface DepartureOutcome {
  row: GroupMember;
  event: MemberLeftEvent | null;
  groupDeleted: GroupDeletedEvent | null;
}

// The member leaves on their own. A no-op on a row that is no longer
// active when locked (a kick or ban may have landed first). Requires
// the group lock.
export async function leaveGroupInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: { memberId: string; userId: string; junjoUserId: string },
): Promise<DepartureOutcome> {
  const { gameId, group: locked, limits } = ctx;
  const { memberId, userId, junjoUserId } = input;
  if ((await lockMember(tx, memberId)).status !== "active") {
    const current = await tx.groupMember.findUniqueOrThrow({ where: { id: memberId } });
    return { row: current, event: null, groupDeleted: null };
  }
  const result = await tx.groupMember.update({
    where: { id: memberId },
    data: { status: "left", leftAt: new Date(), version: { increment: 1 } },
  });
  await tx.auditEntry.create({
    data: {
      gameId,
      groupId: locked.id,
      actorUserId: junjoUserId,
      action: "member.left",
      targetId: userId,
      payload: {
        memberId: result.id,
        reason: "left",
      } as Prisma.InputJsonValue,
    },
  });
  const staged = await stageEvent<MemberLeftEvent>(tx, {
    type: "member.left",
    gameId: gameId as GameId,
    groupId: locked.id as GroupId,
    userId: userId as UserId,
    reason: "left",
    memberVersion: result.version,
  });
  const deleted = await afterMembershipChange(tx, locked, limits, true);
  return { row: result, event: staged, groupDeleted: deleted };
}

// Kicks an active member. `ifMatch` is checked against the locked
// member version. A no-op on a row that is no longer active when
// locked: a kick must not overwrite a ban or leave that landed first.
// Requires the group lock.
export async function kickMemberInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: {
    memberId: string;
    userId: string;
    ifMatch: number | null;
    reason: string | null;
    actorUserId: string | null;
    actorJunjoUserId: string | null;
  },
): Promise<DepartureOutcome> {
  const { gameId, group: locked, limits } = ctx;
  const { memberId, userId, actorUserId } = input;
  const current = await lockMember(tx, memberId);
  assertVersion(input.ifMatch, current.version);
  if (current.status !== "active") {
    const row = await tx.groupMember.findUniqueOrThrow({ where: { id: memberId } });
    return { row, event: null, groupDeleted: null };
  }
  const result = await tx.groupMember.update({
    where: { id: memberId },
    data: { status: "kicked", leftAt: new Date(), version: { increment: 1 } },
  });
  await tx.auditEntry.create({
    data: {
      gameId,
      groupId: locked.id,
      actorUserId: input.actorJunjoUserId,
      action: "member.kicked",
      targetId: userId,
      payload: {
        memberId: result.id,
        reason: input.reason,
      } as Prisma.InputJsonValue,
    },
  });
  const staged = await stageEvent<MemberLeftEvent>(tx, {
    type: "member.left",
    gameId: gameId as GameId,
    groupId: locked.id as GroupId,
    userId: userId as UserId,
    reason: "kicked",
    ...(actorUserId ? { kickedBy: actorUserId as UserId } : {}),
    memberVersion: result.version,
  });
  const deleted = await afterMembershipChange(tx, locked, limits, true);
  return { row: result, event: staged, groupDeleted: deleted };
}

// Bans the person from the group, creating their row when they have
// none. `ifMatch` applies to an existing row only. A row inserted
// concurrently by a writer outside the group lock fails the create on
// the unique key; callers rerun the transaction, which then takes the
// update branch. Requires the group lock.
export async function banMemberInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: {
    userId: string;
    junjoUserId: string;
    ifMatch: number | null;
    reason: string | null;
    expiresAt: Date | null;
    actorJunjoUserId: string | null;
  },
): Promise<{
  member: GroupMember;
  event: MemberBannedEvent;
  groupDeleted: GroupDeletedEvent | null;
}> {
  const { gameId, group: locked, limits } = ctx;
  const { userId, junjoUserId, reason: reasonValue, expiresAt: expiresAtValue } = input;
  const { actorJunjoUserId } = input;
  const groupId = locked.id;
  const existing = await tx.groupMember.findUnique({
    where: { groupId_junjoUserId: { groupId, junjoUserId } },
  });
  // A precondition applies to an existing member only; banning a
  // person with no membership row creates one, as without If-Match.
  if (existing) await lockMemberVersion(tx, existing.id, input.ifMatch);
  const member = existing
    ? await tx.groupMember.update({
        where: { id: existing.id },
        data: {
          status: "banned",
          bannedUntil: expiresAtValue,
          leftAt: existing.leftAt ?? new Date(),
          version: { increment: 1 },
        },
      })
    : await tx.groupMember.create({
        data: {
          groupId,
          junjoUserId,
          status: "banned",
          bannedUntil: expiresAtValue,
          leftAt: new Date(),
        },
      });
  await tx.auditEntry.create({
    data: {
      gameId,
      groupId,
      actorUserId: actorJunjoUserId,
      action: "member.banned",
      targetId: userId,
      payload: {
        memberId: member.id,
        reason: reasonValue,
        bannedUntil: expiresAtValue ? expiresAtValue.toISOString() : null,
      } as Prisma.InputJsonValue,
    },
  });
  // BanHistory append: structured ban-only timeline, distinct
  // from the audit row above and from GroupMember (current state).
  await tx.banHistory.create({
    data: {
      gameId,
      junjoUserId,
      scope: "group",
      groupId,
      kind: "set",
      reason: reasonValue,
      expiresAt: expiresAtValue,
      actorJunjoUserId,
    },
  });
  const event = await stageEvent<MemberBannedEvent>(tx, {
    type: "member.banned",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    userId: userId as UserId,
    reason: reasonValue,
    bannedUntil: expiresAtValue,
    memberVersion: member.version,
  });
  const groupDeleted = await afterMembershipChange(
    tx,
    locked,
    limits,
    existing?.status === "active",
  );
  return { member, event, groupDeleted };
}

// Lifts a group ban, leaving the row at `left`. 404 `not_active` when
// the locked row is no longer banned, checked before `ifMatch` so a
// replayed lift reads as done. Requires the group lock.
export async function unbanMemberInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: {
    memberId: string;
    userId: string;
    junjoUserId: string;
    ifMatch: number | null;
    actorJunjoUserId: string | null;
  },
): Promise<{ row: GroupMember; event: MemberUnbannedEvent }> {
  const { gameId, group: locked } = ctx;
  const { memberId, userId, junjoUserId, actorJunjoUserId } = input;
  const current = await lockMember(tx, memberId);
  if (current.status !== "banned") throw Errors.banNotActive();
  assertVersion(input.ifMatch, current.version);
  const result = await tx.groupMember.update({
    where: { id: memberId },
    data: { status: "left", bannedUntil: null, version: { increment: 1 } },
  });
  await afterMembershipChange(tx, locked, null, false);
  await tx.auditEntry.create({
    data: {
      gameId,
      groupId: locked.id,
      actorUserId: actorJunjoUserId,
      action: "member.unbanned",
      targetId: userId,
      payload: { memberId: result.id } as Prisma.InputJsonValue,
    },
  });
  await tx.banHistory.create({
    data: {
      gameId,
      junjoUserId,
      scope: "group",
      groupId: locked.id,
      kind: "lifted",
      reason: null,
      expiresAt: null,
      actorJunjoUserId,
    },
  });
  const staged = await stageEvent<MemberUnbannedEvent>(tx, {
    type: "member.unbanned",
    gameId: gameId as GameId,
    groupId: locked.id as GroupId,
    userId: userId as UserId,
    memberVersion: result.version,
  });
  return { row: result, event: staged };
}

// =====================================================================
// Member fields
// =====================================================================

export interface MemberFieldsInput {
  metadata?: Record<string, unknown>;
  notesPublic?: string | null;
  notesPrivate?: string | null;
}

export interface MemberUpdatePlan {
  data: Prisma.GroupMemberUpdateInput;
  metadata: Record<string, unknown> | undefined;
  metadataChanged: boolean;
  notesBefore: Record<string, string | null>;
  notesAfter: Record<string, string | null>;
  notesChanged: boolean;
}

// The changes `body` makes to `member`. Metadata replaces wholesale and
// counts as a change whenever supplied (jsonb need not keep key order,
// so a deep-equal check would be unreliable); notes are diffed per
// field. An empty `data` means the update changes nothing.
export function planMemberUpdate(member: GroupMember, body: MemberFieldsInput): MemberUpdatePlan {
  const data: Prisma.GroupMemberUpdateInput = {};
  const metadataChanged = body.metadata !== undefined;
  if (metadataChanged) {
    data.metadata = body.metadata as Prisma.InputJsonValue;
  }
  const notesBefore: Record<string, string | null> = {};
  const notesAfter: Record<string, string | null> = {};
  if (body.notesPublic !== undefined && body.notesPublic !== member.notesPublic) {
    notesBefore.notesPublic = member.notesPublic;
    notesAfter.notesPublic = body.notesPublic;
    data.notesPublic = body.notesPublic;
  }
  if (body.notesPrivate !== undefined && body.notesPrivate !== member.notesPrivate) {
    notesBefore.notesPrivate = member.notesPrivate;
    notesAfter.notesPrivate = body.notesPrivate;
    data.notesPrivate = body.notesPrivate;
  }
  const notesChanged = Object.keys(notesAfter).length > 0;
  return { data, metadata: body.metadata, metadataChanged, notesBefore, notesAfter, notesChanged };
}

// Writes a non-empty plan from `planMemberUpdate`. `member` is the row
// the plan was made from; its metadata is the audit's before value.
export async function updateMemberInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: { member: GroupMember; userId: string; ifMatch: number | null; plan: MemberUpdatePlan },
): Promise<{ result: GroupMember; event: MemberUpdatedEvent }> {
  const { gameId } = ctx;
  const groupId = ctx.group.id;
  const { member, userId, plan } = input;
  await lockMemberVersion(tx, member.id, input.ifMatch);
  const result = await tx.groupMember.update({
    where: { id: member.id },
    data: { ...plan.data, version: { increment: 1 } },
  });
  if (plan.metadataChanged) {
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId,
        actorUserId: null,
        action: "member.metadata.updated",
        targetId: userId,
        payload: {
          before: { metadata: (member.metadata ?? {}) as Prisma.InputJsonValue },
          after: { metadata: plan.metadata as Prisma.InputJsonValue },
        } as Prisma.InputJsonValue,
      },
    });
  }
  if (plan.notesChanged) {
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId,
        actorUserId: null,
        action: "member.notes.updated",
        targetId: userId,
        payload: {
          before: plan.notesBefore,
          after: plan.notesAfter,
        } as Prisma.InputJsonValue,
      },
    });
  }
  const changed: MemberChangeField[] = [];
  if (plan.metadataChanged) changed.push("metadata");
  if (plan.notesChanged) changed.push("notes");
  const event = await stageEvent<MemberUpdatedEvent>(tx, {
    type: "member.updated",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    userId: userId as UserId,
    changed,
    memberVersion: result.version,
  });
  return { result, event };
}

// =====================================================================
// Member roles
// =====================================================================

export interface MemberRoleInput {
  memberId: string;
  userId: string;
  roleId: string;
  ifMatch: number | null;
  actorUserId: string | null;
  actorJunjoUserId: string | null;
}

// Assigns a role the member does not hold yet (checked by the caller).
// A duplicate assignment racing this one fails the insert on the
// unique key, which the caller turns into the idempotent answer.
export async function assignRoleInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: MemberRoleInput,
): Promise<RoleChangedEvent> {
  const { gameId } = ctx;
  const groupId = ctx.group.id;
  const { memberId, userId, roleId } = input;
  await lockMemberVersion(tx, memberId, input.ifMatch);
  await tx.memberRole.create({
    data: { groupMemberId: memberId, roleId },
  });
  const memberVersion = await bumpMemberVersion(tx, memberId);
  await tx.auditEntry.create({
    data: {
      gameId,
      groupId,
      actorUserId: input.actorJunjoUserId,
      action: "role.assigned",
      targetId: userId,
      payload: {
        memberId,
        roleId,
      } as Prisma.InputJsonValue,
    },
  });
  return stageEvent<RoleChangedEvent>(tx, {
    type: "role.changed",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    userId: userId as UserId,
    added: [roleId as RoleId],
    removed: [],
    actorUserId: input.actorUserId as UserId | null,
    memberVersion,
  });
}

// Removes a role from the member. A guarded delete: when a racing
// unassign removed the row first, nothing is written and null returned.
export async function unassignRoleInTx(
  tx: Tx,
  ctx: GroupOpContext,
  input: MemberRoleInput,
): Promise<RoleChangedEvent | null> {
  const { gameId } = ctx;
  const groupId = ctx.group.id;
  const { memberId, userId, roleId } = input;
  await lockMemberVersion(tx, memberId, input.ifMatch);
  const deleted = await tx.memberRole.deleteMany({
    where: { groupMemberId: memberId, roleId },
  });
  if (deleted.count === 0) return null;
  const memberVersion = await bumpMemberVersion(tx, memberId);
  await tx.auditEntry.create({
    data: {
      gameId,
      groupId,
      actorUserId: input.actorJunjoUserId,
      action: "role.unassigned",
      targetId: userId,
      payload: {
        memberId,
        roleId,
      } as Prisma.InputJsonValue,
    },
  });
  return stageEvent<RoleChangedEvent>(tx, {
    type: "role.changed",
    gameId: gameId as GameId,
    groupId: groupId as GroupId,
    userId: userId as UserId,
    added: [],
    removed: [roleId as RoleId],
    actorUserId: input.actorUserId as UserId | null,
    memberVersion,
  });
}

// =====================================================================
// Group fields
// =====================================================================

export interface GroupFieldsInput {
  name?: string;
  visibility?: string;
  metadata?: Record<string, unknown>;
  defaultRoleId?: string | null;
}

// Applies the changed fields of `body` to `existing`. `newPasscodeHash`
// is the already hashed new passcode, null to clear it, undefined to
// leave it. Unchanged fields are ignored (metadata always counts as
// changed when supplied); a call that changes nothing writes nothing
// and returns `memberCount` null.
export async function updateGroupInTx(
  tx: Tx,
  ctx: { gameId: string },
  input: {
    existing: Group;
    body: GroupFieldsInput;
    newPasscodeHash: string | null | undefined;
    actorUserId: string | null;
    actorJunjoUserId: string | null;
  },
): Promise<{ row: Group; event: GroupUpdatedEvent | null; memberCount: number | null }> {
  const { gameId } = ctx;
  const { existing, body, newPasscodeHash, actorUserId, actorJunjoUserId } = input;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const data: Prisma.GroupUpdateInput = {};
  // Track passcode transitions separately so we can write a
  // dedicated audit row (the standard group.updated row only logs
  // presence as a boolean, never the value).
  let passcodeTransition: "set" | "cleared" | "rotated" | null = null;

  if (body.name !== undefined && body.name !== existing.name) {
    before.name = existing.name;
    after.name = body.name;
    data.name = body.name;
  }
  if (body.visibility !== undefined && body.visibility !== existing.visibility) {
    before.visibility = existing.visibility;
    after.visibility = body.visibility;
    data.visibility = body.visibility;
  }
  if (body.metadata !== undefined) {
    before.metadata = (existing.metadata ?? {}) as Prisma.InputJsonValue;
    after.metadata = body.metadata;
    data.metadata = body.metadata as Prisma.InputJsonValue;
  }
  if (body.defaultRoleId !== undefined && body.defaultRoleId !== existing.defaultRoleId) {
    before.defaultRoleId = existing.defaultRoleId;
    after.defaultRoleId = body.defaultRoleId;
    data.defaultRoleId = body.defaultRoleId;
  }
  if (newPasscodeHash !== undefined) {
    const hadPasscode = existing.passcodeHash !== null;
    const willHavePasscode = newPasscodeHash !== null;
    if (hadPasscode || willHavePasscode) {
      before.hasPasscode = hadPasscode;
      after.hasPasscode = willHavePasscode;
      data.passcodeHash = newPasscodeHash;
      data.passcodeSetAt = willHavePasscode ? new Date() : null;
      passcodeTransition = willHavePasscode ? (hadPasscode ? "rotated" : "set") : "cleared";
    }
  }

  if (Object.keys(data).length === 0) {
    return { row: existing, event: null, memberCount: null };
  }

  const result = await tx.group.update({
    where: { id: existing.id },
    data,
  });

  await tx.auditEntry.create({
    data: {
      gameId,
      groupId: result.id,
      actorUserId: actorJunjoUserId,
      action: "group.updated",
      targetId: result.id,
      payload: { before, after } as Prisma.InputJsonValue,
    },
  });

  // Dedicated passcode audit row: keeps "show me every passcode
  // change" filterable via `?actions=group.passcode.set` without
  // scanning every group.updated payload.
  if (passcodeTransition) {
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId: result.id,
        actorUserId: actorJunjoUserId,
        action: passcodeTransition === "cleared" ? "group.passcode.cleared" : "group.passcode.set",
        targetId: result.id,
        payload: {
          transition: passcodeTransition,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // Counted inside the transaction so the staged group.updated
  // payload reflects the committed row.
  const memberCount = await tx.groupMember.count({
    where: { groupId: result.id, status: "active" },
  });
  const event = await stageEvent<GroupUpdatedEvent>(tx, {
    type: "group.updated",
    gameId: gameId as GameId,
    groupId: result.id as GroupId,
    group: toPublicGroup(result, memberCount),
    actorUserId: actorUserId as UserId | null,
  });

  return { row: result, event, memberCount };
}

// =====================================================================
// Relationships
// =====================================================================

// Sets A's stance toward B, and B's toward A when `mutual`, one
// direction at a time. Idempotent per direction: re-setting the same
// type keeps the row, its `since` and its `setBy`. Audit entries land
// on each direction's origin group. Returns the A->B row and the
// staged events. Both groups must already be checked live in the game.
export async function setRelationshipInTx(
  tx: Tx,
  gameId: string,
  input: {
    a: string;
    b: string;
    type: string;
    mutual: boolean | undefined;
    actorUserId: string | null;
    actorJunjoUserId: string | null;
  },
): Promise<{ primary: GroupRelationship; events: GroupRelationshipChangedEvent[] }> {
  const { a, b, type, mutual, actorUserId, actorJunjoUserId } = input;
  const directions: Array<{ aId: string; bId: string }> = [{ aId: a, bId: b }];
  if (mutual) directions.push({ aId: b, bId: a });

  let primary: GroupRelationship | null = null;
  const events: GroupRelationshipChangedEvent[] = [];
  for (const dir of directions) {
    const existing = await tx.groupRelationship.findUnique({
      where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
    });
    if (existing && existing.type === type) {
      if (dir.aId === a) primary = existing;
      continue;
    }

    const upserted = await tx.groupRelationship.upsert({
      where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
      create: { groupAId: dir.aId, groupBId: dir.bId, type, setByUserId: actorJunjoUserId },
      update: { type, since: new Date(), setByUserId: actorJunjoUserId },
    });
    if (dir.aId === a) primary = upserted;

    const auditPayload: Record<string, unknown> = {
      groupAId: dir.aId,
      groupBId: dir.bId,
      type,
      mutual: mutual === true,
    };
    if (existing) auditPayload.before = { type: existing.type };
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId: dir.aId,
        actorUserId: actorJunjoUserId,
        action: "group.relationship.set",
        targetId: dir.bId,
        payload: auditPayload as Prisma.InputJsonValue,
      },
    });
    events.push(
      await stageEvent<GroupRelationshipChangedEvent>(tx, {
        type: "group.relationship.changed",
        gameId: gameId as GameId,
        groupId: upserted.groupAId as GroupId,
        otherGroupId: upserted.groupBId as GroupId,
        relationship: toPublicGroupRelationship(upserted, actorUserId as UserId | null),
        actorUserId: actorUserId as UserId | null,
      }),
    );
  }
  if (!primary) {
    // Both directions no-op'd; reload the existing A->B row.
    const reloaded = await tx.groupRelationship.findUnique({
      where: { groupAId_groupBId: { groupAId: a, groupBId: b } },
    });
    if (!reloaded) throw new Error("relationship row missing after no-op upsert");
    primary = reloaded;
  }
  return { primary, events };
}

// Clears A's stance toward B, and B's toward A when `mutual`.
// Idempotent on a missing row. A guarded delete per direction: a racing
// clear that removed the row first leaves this direction unrecorded.
export async function clearRelationshipInTx(
  tx: Tx,
  gameId: string,
  input: {
    a: string;
    b: string;
    mutual: boolean;
    actorUserId: string | null;
    actorJunjoUserId: string | null;
  },
): Promise<GroupRelationshipChangedEvent[]> {
  const { a, b, mutual, actorUserId, actorJunjoUserId } = input;
  const directions: Array<{ aId: string; bId: string }> = [{ aId: a, bId: b }];
  if (mutual) directions.push({ aId: b, bId: a });

  const events: GroupRelationshipChangedEvent[] = [];
  for (const dir of directions) {
    const existing = await tx.groupRelationship.findUnique({
      where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
    });
    if (!existing) continue;

    const deleted = await tx.groupRelationship.deleteMany({
      where: { groupAId: dir.aId, groupBId: dir.bId },
    });
    if (deleted.count === 0) continue;
    await tx.auditEntry.create({
      data: {
        gameId,
        groupId: dir.aId,
        actorUserId: actorJunjoUserId,
        action: "group.relationship.cleared",
        targetId: dir.bId,
        payload: {
          groupAId: dir.aId,
          groupBId: dir.bId,
          type: existing.type,
          mutual,
        } as Prisma.InputJsonValue,
      },
    });
    events.push(
      await stageEvent<GroupRelationshipChangedEvent>(tx, {
        type: "group.relationship.changed",
        gameId: gameId as GameId,
        groupId: dir.aId as GroupId,
        otherGroupId: dir.bId as GroupId,
        relationship: null,
        actorUserId: actorUserId as UserId | null,
      }),
    );
  }
  return events;
}
