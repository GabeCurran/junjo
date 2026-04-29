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
} from "@junjo/shared";
import type {
  PrismaClient,
  Group as PrismaGroup,
  GroupMember as PrismaGroupMember,
  GroupRelationship as PrismaGroupRelationship,
  Invitation as PrismaInvitation,
  Role as PrismaRole,
} from "@prisma/client";
import { type EventHub, eventHub as defaultHub } from "./eventHub.js";
import { enqueueWebhookDeliveries } from "./webhooks.js";

// 24 hex chars (96 bits of entropy). Random ids let any emitter mint one
// without a database round-trip; the id surfaces on the SSE `id:` line so
// future replay-on-reconnect support has a stable handle.
export function newEventId(): string {
  return randomBytes(12).toString("hex");
}

// Brand-cast a Prisma `Group` row into the public `Group` shape with an
// attached memberCount. Field types are structurally identical; only the
// branded id types and the open-string-to-union casts change at the type
// level.
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
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    softDeletedAt: group.softDeletedAt,
  };
}

// Brand-cast a Prisma `GroupMember` row into the public `Member` shape.
// The wire's `userId` is the dev's external user id (looked up via
// ExternalIdentity by the route), not the internal `junjoUserId`; the
// caller threads it in alongside the optional role-id list.
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

// Stamps a fresh `id` and `occurredAt` onto the supplied payload and pushes
// the resulting event through the hub. The hub is injected per-router so
// tests can swap a fresh `EventHub` instance via `createApp({ events: { hub } })`
// (matches the SSE route's seam from Phase 5.1a).
export function publishEvent<E extends JunjoEvent>(
  hub: EventHub,
  payload: Omit<E, "id" | "occurredAt">,
): E {
  const event = {
    id: newEventId(),
    occurredAt: new Date(),
    ...payload,
  } as unknown as E;
  hub.publish(event);
  return event;
}

// Publishes an event to the SSE hub and enqueues durable webhook
// deliveries to every matching endpoint in the same call. Mutation
// routes use this in place of `publishEvent` whenever they would have
// fired an SSE event; transient subscribers and durable webhook
// consumers stay in lockstep that way (one event -> one hub broadcast +
// one delivery per matching endpoint).
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
