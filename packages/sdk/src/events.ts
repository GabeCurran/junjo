import type {
  GameId,
  GroupId,
  JunjoEvent,
  MemberLeftEvent,
  PermissionKey,
  RoleId,
  UserId,
} from "@junjo/shared";
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

interface WireEventBase {
  id: string;
  gameId: string;
  groupId: string;
  occurredAt: string;
}

interface WireMemberJoinedEvent extends WireEventBase {
  type: "member.joined";
  userId: string;
  member: WireMember;
}

interface WireMemberLeftEvent extends WireEventBase {
  type: "member.left";
  userId: string;
  reason: "left" | "kicked";
  kickedBy?: string;
}

interface WireMemberInvitedEvent extends WireEventBase {
  type: "member.invited";
  invitation: WireInvitation;
}

interface WireRoleCreatedEvent extends WireEventBase {
  type: "role.created";
  role: WireRole;
}

interface WireRoleChangedEvent extends WireEventBase {
  type: "role.changed";
  userId: string;
  added: string[];
  removed: string[];
  // External id of the moderator who performed the assign / unassign,
  // when supplied on the request body. Null for legacy callers and
  // server-side admin paths that don't attribute an actor.
  actorUserId: string | null;
}

interface WireRoleDeletedEvent extends WireEventBase {
  type: "role.deleted";
  roleId: string;
}

interface WirePermissionGrantedEvent extends WireEventBase {
  type: "permission.granted";
  roleId: string;
  permission: string;
}

interface WirePermissionRevokedEvent extends WireEventBase {
  type: "permission.revoked";
  roleId: string;
  permission: string;
}

interface WireGroupUpdatedEvent extends WireEventBase {
  type: "group.updated";
  group: WireGroup;
}

interface WireGroupDeletedEvent extends WireEventBase {
  type: "group.deleted";
}

interface WireGroupRelationshipChangedEvent extends WireEventBase {
  type: "group.relationship.changed";
  otherGroupId: string;
  relationship: WireGroupRelationship | null;
}

export type WireJunjoEvent =
  | WireMemberJoinedEvent
  | WireMemberLeftEvent
  | WireMemberInvitedEvent
  | WireRoleCreatedEvent
  | WireRoleChangedEvent
  | WireRoleDeletedEvent
  | WirePermissionGrantedEvent
  | WirePermissionRevokedEvent
  | WireGroupUpdatedEvent
  | WireGroupDeletedEvent
  | WireGroupRelationshipChangedEvent;

export function deserializeEvent(w: WireJunjoEvent): JunjoEvent {
  const base = {
    id: w.id,
    gameId: w.gameId as GameId,
    groupId: w.groupId as GroupId,
    occurredAt: new Date(w.occurredAt),
  };
  switch (w.type) {
    case "member.joined":
      return {
        ...base,
        type: "member.joined",
        userId: w.userId as UserId,
        member: deserializeMember(w.member),
      };
    case "member.left": {
      const event: MemberLeftEvent = {
        ...base,
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
        type: "member.invited",
        invitation: deserializeInvitation(w.invitation),
      };
    case "role.created":
      return {
        ...base,
        type: "role.created",
        role: deserializeRole(w.role),
      };
    case "role.changed":
      return {
        ...base,
        type: "role.changed",
        userId: w.userId as UserId,
        added: w.added.map((r) => r as RoleId),
        removed: w.removed.map((r) => r as RoleId),
        actorUserId: w.actorUserId === null ? null : (w.actorUserId as UserId),
      };
    case "role.deleted":
      return {
        ...base,
        type: "role.deleted",
        roleId: w.roleId as RoleId,
      };
    case "permission.granted":
      return {
        ...base,
        type: "permission.granted",
        roleId: w.roleId as RoleId,
        permission: w.permission as PermissionKey,
      };
    case "permission.revoked":
      return {
        ...base,
        type: "permission.revoked",
        roleId: w.roleId as RoleId,
        permission: w.permission as PermissionKey,
      };
    case "group.updated":
      return {
        ...base,
        type: "group.updated",
        group: deserializeGroup(w.group),
      };
    case "group.deleted":
      return { ...base, type: "group.deleted" };
    case "group.relationship.changed":
      return {
        ...base,
        type: "group.relationship.changed",
        otherGroupId: w.otherGroupId as GroupId,
        relationship: w.relationship === null ? null : deserializeGroupRelationship(w.relationship),
      };
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
// ever emits a single `data:` line per event today.
export function parseSSEFrame(block: string): ParsedSSEFrame | null {
  const result: ParsedSSEFrame = {};
  let sawNonComment = false;
  for (const line of block.split("\n")) {
    if (line.startsWith(":") || line.length === 0) continue;
    sawNonComment = true;
    if (line.startsWith("event: ")) result.event = line.slice(7);
    else if (line.startsWith("data: ")) {
      result.data = result.data === undefined ? line.slice(6) : `${result.data}\n${line.slice(6)}`;
    } else if (line.startsWith("id: ")) result.id = line.slice(4);
  }
  return sawNonComment ? result : null;
}
