import { randomBytes } from "node:crypto";
import type {
  GameId,
  GroupId,
  GroupRelationshipType,
  GroupVisibility,
  InvitationId,
  JunjoEvent,
  MemberId,
  MemberStatus,
  PermissionKey,
  Group as PublicGroup,
  GroupRelationship as PublicGroupRelationship,
  Invitation as PublicInvitation,
  Member as PublicMember,
  Role as PublicRole,
  RoleId,
  UserId,
} from "@junjo.io/shared";
import type {
  PrismaClient,
  Group as PrismaGroup,
  GroupMember as PrismaGroupMember,
  GroupRelationship as PrismaGroupRelationship,
  Invitation as PrismaInvitation,
  Role as PrismaRole,
} from "@prisma/client";
import { type EventHub, eventHub as defaultHub } from "./eventHub.js";
import {
  type WebhookDb,
  enqueueWebhookDeliveries,
  enqueueWebhookDeliveriesBatch,
} from "./webhooks.js";

// 24 hex chars (96 bits). Random so any emitter can mint one without a
// DB round-trip; surfaces on the SSE `id:` line for future
// replay-on-reconnect.
export function newEventId(): string {
  return randomBytes(12).toString("hex");
}

export function toPublicGroup(group: PrismaGroup, memberCount: number): PublicGroup {
  return {
    id: group.id as GroupId,
    gameId: group.gameId as GameId,
    kind: group.kind,
    name: group.name,
    visibility: group.visibility as GroupVisibility,
    metadata: (group.metadata ?? {}) as Record<string, unknown>,
    defaultRoleId: group.defaultRoleId ? (group.defaultRoleId as RoleId) : null,
    parentGroupId: group.parentGroupId ? (group.parentGroupId as GroupId) : null,
    memberCount,
    hasPasscode: group.passcodeHash !== null,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    softDeletedAt: group.softDeletedAt,
  };
}

// Wire `userId` is the dev's external id, NOT the internal `junjoUserId`;
// the caller threads it in.
export function toPublicMember(
  member: PrismaGroupMember,
  externalUserId: string,
  roleIds: string[] = [],
): PublicMember {
  return {
    id: member.id as MemberId,
    groupId: member.groupId as GroupId,
    userId: externalUserId as UserId,
    status: member.status as MemberStatus,
    roles: roleIds.map((r) => r as RoleId),
    metadata: (member.metadata ?? {}) as Record<string, unknown>,
    notesPublic: member.notesPublic,
    notesPrivate: member.notesPrivate,
    joinedAt: member.joinedAt,
    bannedUntil: member.bannedUntil,
  };
}

export function toPublicRole(role: PrismaRole, permissions: string[] = []): PublicRole {
  return {
    id: role.id as RoleId,
    groupId: role.groupId as GroupId,
    name: role.name,
    priority: role.priority,
    color: role.color,
    isDefault: role.isDefault,
    permissions: permissions as PermissionKey[],
    createdAt: role.createdAt,
  };
}

export function toPublicInvitation(inv: PrismaInvitation): PublicInvitation {
  return {
    id: inv.id as InvitationId,
    groupId: inv.groupId as GroupId,
    code: inv.code,
    roleId: inv.roleId ? (inv.roleId as RoleId) : null,
    targetUserId: inv.targetUserId ? (inv.targetUserId as UserId) : null,
    createdBy: inv.createdByUserId ? (inv.createdByUserId as UserId) : null,
    createdAt: inv.createdAt,
    expiresAt: inv.expiresAt,
    usedAt: inv.usedAt,
    usedBy: inv.usedByUserId ? (inv.usedByUserId as UserId) : null,
  };
}

export function toPublicGroupRelationship(rel: PrismaGroupRelationship): PublicGroupRelationship {
  return {
    groupAId: rel.groupAId as GroupId,
    groupBId: rel.groupBId as GroupId,
    type: rel.type as GroupRelationshipType,
    since: rel.since,
    setBy: rel.setByUserId ? (rel.setByUserId as UserId) : null,
  };
}

// Mints the full event envelope without publishing it anywhere.
export function mintEvent<E extends JunjoEvent>(payload: Omit<E, "id" | "occurredAt">): E {
  return {
    id: newEventId(),
    occurredAt: new Date(),
    ...payload,
  } as unknown as E;
}

// Hub is injected per-router so tests can swap a fresh `EventHub` via
// `createApp({ events: { hub } })`.
export function publishEvent<E extends JunjoEvent>(
  hub: EventHub,
  payload: Omit<E, "id" | "occurredAt">,
): E {
  const event = mintEvent<E>(payload);
  hub.publish(event);
  return event;
}

// Transactional-outbox staging: mints the event and writes its webhook
// delivery rows on the caller's transaction, so a rollback takes the
// staged deliveries with it and a commit guarantees the worker sees
// them. The caller MUST publish the returned event to the SSE hub only
// after the transaction commits (SSE subscribers must never observe a
// rolled-back mutation); `publishStagedEvents` is the usual way.
export async function stageEvent<E extends JunjoEvent>(
  db: WebhookDb,
  payload: Omit<E, "id" | "occurredAt">,
): Promise<E> {
  const event = mintEvent<E>(payload);
  await enqueueWebhookDeliveries(db, event);
  return event;
}

// Batch stage for homogeneous events (same gameId and type). Costs one
// endpoint lookup and one delivery insert regardless of batch size;
// bulk routes use this so their transaction stays a handful of
// statements instead of scaling with row count.
export async function stageEventsBatch<E extends JunjoEvent>(
  db: WebhookDb,
  payloads: Omit<E, "id" | "occurredAt">[],
): Promise<E[]> {
  const events = payloads.map((p) => mintEvent<E>(p));
  await enqueueWebhookDeliveriesBatch(db, events);
  return events;
}

// Post-commit half of the stage/publish pair. Accepts the events a
// transaction staged and fans them to transient SSE subscribers.
export function publishStagedEvents(hub: EventHub, ...events: JunjoEvent[]): void {
  for (const event of events) hub.publish(event);
}

// Publishes to the SSE hub AND enqueues durable webhook deliveries in
// the same call, with NO transactional tie to the caller's mutation.
// Mutation routes should prefer stageEvent inside their transaction +
// publishStagedEvents after commit; this remains for callers with no
// surrounding transaction where the mutation and the enqueue cannot be
// atomic anyway.
export async function dispatchEvent<E extends JunjoEvent>(
  prisma: PrismaClient,
  hub: EventHub,
  payload: Omit<E, "id" | "occurredAt">,
): Promise<E> {
  const event = publishEvent<E>(hub, payload);
  await enqueueWebhookDeliveries(prisma, event);
  return event;
}

export { defaultHub };
