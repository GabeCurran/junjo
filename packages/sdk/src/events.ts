import type {
  GameId,
  GroupId,
  JunjoEvent,
  MemberLeftEvent,
  PermissionKey,
  RoleId,
  UserId,
} from "@junjo-io/shared";
import { JunjoError } from "./errors.js";
import {
  type WireGroup,
  type WireGroupRelationship,
  type WireInvitation,
  deserializeGroup,
  deserializeGroupRelationship,
  deserializeInvitation,
} from "./groups.js";
import { type WireMember, deserializeMember } from "./members.js";
import { type WireRole, deserializeRole } from "./roles.js";
import { parseWireDate } from "./wire.js";

interface WireEventBase {
  id: string;
  gameId: string;
  occurredAt: string;
}

// Group-scoped events carry the routing groupId; user-scoped events
// (friends, game-wide bans) have no group context and omit it, matching
// `GroupEventBase` / `UserEventBase` in @junjo-io/shared.
interface WireGroupEventBase extends WireEventBase {
  groupId: string;
}

interface WireMemberJoinedEvent extends WireGroupEventBase {
  type: "member.joined";
  userId: string;
  member: WireMember;
}

interface WireMemberLeftEvent extends WireGroupEventBase {
  type: "member.left";
  userId: string;
  reason: "left" | "kicked";
  kickedBy?: string;
}

interface WireMemberInvitedEvent extends WireGroupEventBase {
  type: "member.invited";
  invitation: WireInvitation;
}

interface WireMemberBannedEvent extends WireGroupEventBase {
  type: "member.banned";
  userId: string;
  reason: string | null;
  bannedUntil: string | null;
}

interface WireMemberUnbannedEvent extends WireGroupEventBase {
  type: "member.unbanned";
  userId: string;
}

interface WireRoleCreatedEvent extends WireGroupEventBase {
  type: "role.created";
  role: WireRole;
}

interface WireRoleChangedEvent extends WireGroupEventBase {
  type: "role.changed";
  userId: string;
  added: string[];
  removed: string[];
  // External id of the moderator who performed the assign / unassign,
  // when supplied on the request body. Null for legacy callers and
  // server-side admin paths that don't attribute an actor.
  actorUserId: string | null;
}

interface WireRoleDeletedEvent extends WireGroupEventBase {
  type: "role.deleted";
  roleId: string;
}

interface WirePermissionGrantedEvent extends WireGroupEventBase {
  type: "permission.granted";
  roleId: string;
  permission: string;
}

interface WirePermissionRevokedEvent extends WireGroupEventBase {
  type: "permission.revoked";
  roleId: string;
  permission: string;
}

interface WireGroupUpdatedEvent extends WireGroupEventBase {
  type: "group.updated";
  group: WireGroup;
}

interface WireGroupDeletedEvent extends WireGroupEventBase {
  type: "group.deleted";
}

interface WireGroupRelationshipChangedEvent extends WireGroupEventBase {
  type: "group.relationship.changed";
  otherGroupId: string;
  relationship: WireGroupRelationship | null;
}

interface WireFriendRequestSentEvent extends WireEventBase {
  type: "friend.request.sent";
  requestId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
}

interface WireFriendRequestAcceptedEvent extends WireEventBase {
  type: "friend.request.accepted";
  relationshipId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
  respondedAt: string;
}

interface WireFriendRequestDeclinedEvent extends WireEventBase {
  type: "friend.request.declined";
  requestId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
}

interface WireFriendRequestCancelledEvent extends WireEventBase {
  type: "friend.request.cancelled";
  requestId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
}

interface WireFriendRemovedEvent extends WireEventBase {
  type: "friend.removed";
  removedByJunjoUserId: string;
  otherJunjoUserId: string;
}

interface WireFriendBlockedEvent extends WireEventBase {
  type: "friend.blocked";
  byJunjoUserId: string;
  otherJunjoUserId: string;
}

interface WireFriendUnblockedEvent extends WireEventBase {
  type: "friend.unblocked";
  byJunjoUserId: string;
  otherJunjoUserId: string;
}

interface WireGameUserBannedEvent extends WireEventBase {
  type: "game.user.banned";
  junjoUserId: string;
  reason: string | null;
  expiresAt: string | null;
}

interface WireGameUserUnbannedEvent extends WireEventBase {
  type: "game.user.unbanned";
  junjoUserId: string;
}

export type WireJunjoEvent =
  | WireMemberJoinedEvent
  | WireMemberLeftEvent
  | WireMemberInvitedEvent
  | WireMemberBannedEvent
  | WireMemberUnbannedEvent
  | WireRoleCreatedEvent
  | WireRoleChangedEvent
  | WireRoleDeletedEvent
  | WirePermissionGrantedEvent
  | WirePermissionRevokedEvent
  | WireGroupUpdatedEvent
  | WireGroupDeletedEvent
  | WireGroupRelationshipChangedEvent
  | WireFriendRequestSentEvent
  | WireFriendRequestAcceptedEvent
  | WireFriendRequestDeclinedEvent
  | WireFriendRequestCancelledEvent
  | WireFriendRemovedEvent
  | WireFriendBlockedEvent
  | WireFriendUnblockedEvent
  | WireGameUserBannedEvent
  | WireGameUserUnbannedEvent;

// Thrown (with this code) when the server sends an event type this SDK
// version does not know. `verifyWebhook` propagates it so receivers see
// a clear error; the SSE subscribe loop skips the frame instead, so a
// newer server cannot kill older clients' streams.
export const UNKNOWN_EVENT_TYPE = "unknown_event_type";

export function deserializeEvent(w: WireJunjoEvent): JunjoEvent {
  const base = {
    id: w.id,
    gameId: w.gameId as GameId,
    occurredAt: parseWireDate(w.occurredAt, "occurredAt"),
  };
  switch (w.type) {
    case "member.joined":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "member.joined",
        userId: w.userId as UserId,
        member: deserializeMember(w.member),
      };
    case "member.left": {
      const event: MemberLeftEvent = {
        ...base,
        groupId: w.groupId as GroupId,
        type: "member.left",
        userId: w.userId as UserId,
        reason: w.reason,
      };
      if (w.kickedBy !== undefined) event.kickedBy = w.kickedBy as UserId;
      return event;
    }
    case "member.invited":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "member.invited",
        invitation: deserializeInvitation(w.invitation),
      };
    case "member.banned":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "member.banned",
        userId: w.userId as UserId,
        reason: w.reason,
        bannedUntil: w.bannedUntil === null ? null : parseWireDate(w.bannedUntil, "bannedUntil"),
      };
    case "member.unbanned":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "member.unbanned",
        userId: w.userId as UserId,
      };
    case "role.created":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "role.created",
        role: deserializeRole(w.role),
      };
    case "role.changed":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "role.changed",
        userId: w.userId as UserId,
        added: w.added.map((r) => r as RoleId),
        removed: w.removed.map((r) => r as RoleId),
        actorUserId: w.actorUserId === null ? null : (w.actorUserId as UserId),
      };
    case "role.deleted":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "role.deleted",
        roleId: w.roleId as RoleId,
      };
    case "permission.granted":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "permission.granted",
        roleId: w.roleId as RoleId,
        permission: w.permission as PermissionKey,
      };
    case "permission.revoked":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "permission.revoked",
        roleId: w.roleId as RoleId,
        permission: w.permission as PermissionKey,
      };
    case "group.updated":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "group.updated",
        group: deserializeGroup(w.group),
      };
    case "group.deleted":
      return { ...base, groupId: w.groupId as GroupId, type: "group.deleted" };
    case "group.relationship.changed":
      return {
        ...base,
        groupId: w.groupId as GroupId,
        type: "group.relationship.changed",
        otherGroupId: w.otherGroupId as GroupId,
        relationship: w.relationship === null ? null : deserializeGroupRelationship(w.relationship),
      };
    case "friend.request.sent":
      return {
        ...base,
        type: "friend.request.sent",
        requestId: w.requestId,
        actorJunjoUserId: w.actorJunjoUserId,
        targetJunjoUserId: w.targetJunjoUserId,
      };
    case "friend.request.accepted":
      return {
        ...base,
        type: "friend.request.accepted",
        relationshipId: w.relationshipId,
        actorJunjoUserId: w.actorJunjoUserId,
        targetJunjoUserId: w.targetJunjoUserId,
        respondedAt: parseWireDate(w.respondedAt, "respondedAt"),
      };
    case "friend.request.declined":
      return {
        ...base,
        type: "friend.request.declined",
        requestId: w.requestId,
        actorJunjoUserId: w.actorJunjoUserId,
        targetJunjoUserId: w.targetJunjoUserId,
      };
    case "friend.request.cancelled":
      return {
        ...base,
        type: "friend.request.cancelled",
        requestId: w.requestId,
        actorJunjoUserId: w.actorJunjoUserId,
        targetJunjoUserId: w.targetJunjoUserId,
      };
    case "friend.removed":
      return {
        ...base,
        type: "friend.removed",
        removedByJunjoUserId: w.removedByJunjoUserId,
        otherJunjoUserId: w.otherJunjoUserId,
      };
    case "friend.blocked":
      return {
        ...base,
        type: "friend.blocked",
        byJunjoUserId: w.byJunjoUserId,
        otherJunjoUserId: w.otherJunjoUserId,
      };
    case "friend.unblocked":
      return {
        ...base,
        type: "friend.unblocked",
        byJunjoUserId: w.byJunjoUserId,
        otherJunjoUserId: w.otherJunjoUserId,
      };
    case "game.user.banned":
      return {
        ...base,
        type: "game.user.banned",
        junjoUserId: w.junjoUserId,
        reason: w.reason,
        expiresAt: w.expiresAt === null ? null : parseWireDate(w.expiresAt, "expiresAt"),
      };
    case "game.user.unbanned":
      return {
        ...base,
        type: "game.user.unbanned",
        junjoUserId: w.junjoUserId,
      };
    default: {
      // `w` is `never` here for compile-time-known wire events; at
      // runtime a newer server can still send types this SDK predates.
      const type = (w as { type?: unknown }).type;
      throw new JunjoError(
        `unknown event type ${JSON.stringify(type)}; upgrade @junjo-io/sdk to handle it`,
        UNKNOWN_EVENT_TYPE,
        400,
      );
    }
  }
}

export interface ParsedSSEFrame {
  event?: string;
  data?: string;
  id?: string;
}

// Returns `null` for comment-only frames (lines starting with `:`);
// these are SSE keep-alives and carry no event payload. Multi-line
// `data:` is joined with `\n` per the spec, even though the server only
// ever emits a single `data:` line per event today. Lines arriving with
// CRLF endings (a proxy or middlebox can normalize them) are tolerated
// by stripping exactly one trailing `\r`; data content is untouched
// otherwise.
export function parseSSEFrame(block: string): ParsedSSEFrame | null {
  const result: ParsedSSEFrame = {};
  let sawNonComment = false;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":") || line.length === 0) continue;
    sawNonComment = true;
    if (line.startsWith("event: ")) result.event = line.slice(7);
    else if (line.startsWith("data: ")) {
      result.data = result.data === undefined ? line.slice(6) : `${result.data}\n${line.slice(6)}`;
    } else if (line.startsWith("id: ")) result.id = line.slice(4);
  }
  return sawNonComment ? result : null;
}
