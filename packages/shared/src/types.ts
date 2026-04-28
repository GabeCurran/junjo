// =====================================================================
// Identity
// =====================================================================
//
// Branded string aliases. Zero runtime cost; they exist purely so a
// function signature like `kick(groupId, userId)` can't be called with
// the args swapped without TypeScript complaining.

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type GameId = Brand<string, "GameId">;
export type GroupId = Brand<string, "GroupId">;
export type RoleId = Brand<string, "RoleId">;
export type MemberId = Brand<string, "MemberId">;
export type UserId = Brand<string, "UserId">;
export type InvitationId = Brand<string, "InvitationId">;
export type AuditEntryId = Brand<string, "AuditEntryId">;

// =====================================================================
// Group
// =====================================================================

export type GroupVisibility = "public" | "invite-only" | "secret";

// Open string. Devs pass whatever taxonomy fits their game ("guild",
// "clan", "faction", "party", "crew"). The server stores it verbatim and
// never branches on it; it's there for the dev's UI and analytics.
export type GroupKind = string;

export type GroupMetadata = Record<string, unknown>;

export interface Group {
  id: GroupId;
  gameId: GameId;
  kind: GroupKind;
  name: string;
  visibility: GroupVisibility;
  metadata: GroupMetadata;
  defaultRoleId: RoleId | null;
  // The parent in a sub-group / alliance hierarchy. null for top-level
  // groups. Set via `groups.setParent`; cycle-checked server-side.
  parentGroupId: GroupId | null;
  memberCount: number;
  createdAt: Date;
  updatedAt: Date;
  softDeletedAt: Date | null;
}

export interface CreateGroupInput {
  kind: GroupKind;
  name: string;
  visibility?: GroupVisibility;
  metadata?: GroupMetadata;
  defaultRoleId?: RoleId;
}

export interface UpdateGroupInput {
  name?: string;
  visibility?: GroupVisibility;
  metadata?: GroupMetadata;
  defaultRoleId?: RoleId | null;
}

// =====================================================================
// Member
// =====================================================================

export type MemberStatus = "active" | "invited" | "left" | "kicked";

export type MemberMetadata = Record<string, unknown>;

export interface Member {
  id: MemberId;
  groupId: GroupId;
  userId: UserId;
  status: MemberStatus;
  roles: RoleId[];
  metadata: MemberMetadata;
  // notesPublic: visible to other group members. notesPrivate:
  // officer-only ("don't promote, has been late on raids" etc.).
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: Date;
}

export interface SetMemberNotesInput {
  notesPublic?: string | null;
  notesPrivate?: string | null;
}

// =====================================================================
// Role
// =====================================================================

export interface Role {
  id: RoleId;
  groupId: GroupId;
  name: string;
  // Higher number = more authority. Used by the SDK's "can this member
  // act on that member" helper (you can't kick someone with a higher
  // priority than yours).
  priority: number;
  color: string | null;
  isDefault: boolean;
  permissions: PermissionKey[];
  createdAt: Date;
}

export interface CreateRoleInput {
  name: string;
  priority: number;
  color?: string;
  isDefault?: boolean;
  permissions?: PermissionKey[];
}

export interface UpdateRoleInput {
  name?: string;
  priority?: number;
  color?: string | null;
  isDefault?: boolean;
}

// =====================================================================
// Permission
// =====================================================================

// Open string. The dev defines their own permission keys per game
// ("invite_member", "claim_territory", "edit_treasury"). Junjo stores
// them and answers can(user, group, key) without ever interpreting the
// key itself.
export type PermissionKey = string;

export type PermissionSource = "role" | "override" | "default" | "none";

export interface PermissionCheckResult {
  allowed: boolean;
  source: PermissionSource;
  // When source = "role", the role that granted it. When source =
  // "override", omitted (the override is by member).
  viaRoleId?: RoleId;
}

export interface MemberPermissionOverride {
  groupId: GroupId;
  userId: UserId;
  permission: PermissionKey;
  // true = grant regardless of roles. false = revoke regardless of roles.
  grant: boolean;
  setAt: Date;
  // null when set by the server itself with no acting user (no
  // auth-adapter actor wired yet in V1; parallels Invitation.createdBy
  // and AuditEntry.actorUserId).
  setBy: UserId | null;
}

// =====================================================================
// Group relationship
// =====================================================================

// Open string. "ally" / "enemy" / "neutral" are conventional but the
// dev can use any tag they want ("trade-partner", "vassal", etc.).
//
// Stored *directed* (A -> B) so asymmetric relationships are possible.
// The SDK exposes a setRelationship(a, b, type, { mutual: true }) helper
// that writes both rows when you want symmetry.
export type GroupRelationshipType = string;

export interface GroupRelationship {
  groupAId: GroupId;
  groupBId: GroupId;
  type: GroupRelationshipType;
  since: Date;
  // null when set by the server itself with no acting user (no
  // auth-adapter actor wired yet in V1; parallels Invitation.createdBy and
  // MemberPermissionOverride.setBy).
  setBy: UserId | null;
}

// =====================================================================
// Invitation
// =====================================================================

export interface Invitation {
  id: InvitationId;
  groupId: GroupId;
  code: string;
  roleId: RoleId | null;
  // null = open invite (anyone with the code/link). Set = direct push
  // to a specific user.
  targetUserId: UserId | null;
  // null when issued by the server itself with no acting user (no
  // auth-adapter actor wired yet in V1; parallels AuditEntry.actorUserId).
  createdBy: UserId | null;
  createdAt: Date;
  expiresAt: Date | null;
  usedAt: Date | null;
  usedBy: UserId | null;
}

export interface CreateInvitationInput {
  roleId?: RoleId;
  targetUserId?: UserId;
  expiresIn?: string; // e.g. "7d", "1h", parsed by the server
}

// =====================================================================
// Audit log
// =====================================================================

export type AuditAction =
  | "group.created"
  | "group.updated"
  | "group.deleted"
  | "group.restored"
  | "group.relationship.set"
  | "group.relationship.cleared"
  | "group.parent.set"
  | "group.parent.cleared"
  | "member.invited"
  | "member.joined"
  | "member.left"
  | "member.kicked"
  | "member.metadata.updated"
  | "member.notes.updated"
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "role.assigned"
  | "role.unassigned"
  | "permission.granted"
  | "permission.revoked"
  | "permission.override.set"
  | "permission.override.cleared";

export interface AuditEntry {
  id: AuditEntryId;
  groupId: GroupId;
  // null when an action is taken by the system (e.g. invitation expiry).
  actorUserId: UserId | null;
  action: AuditAction;
  // Free-form pointer to whatever the action targeted: a user id, role
  // id, permission key. Type depends on action.
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface ListAuditOptions {
  limit?: number;
  before?: Date;
  actions?: AuditAction[];
}

// =====================================================================
// Events (SSE + webhooks share these payload shapes)
// =====================================================================
//
// Each event carries enough denormalized data for a handler to act on
// it without a follow-up API call. (Cost: payloads are slightly larger.
// Benefit: SDK consumers don't need to round-trip on every event.)

interface EventBase {
  id: string;
  gameId: GameId;
  groupId: GroupId;
  occurredAt: Date;
}

export interface MemberJoinedEvent extends EventBase {
  type: "member.joined";
  userId: UserId;
  member: Member;
}

export interface MemberLeftEvent extends EventBase {
  type: "member.left";
  userId: UserId;
  reason: "left" | "kicked";
  kickedBy?: UserId;
}

export interface MemberInvitedEvent extends EventBase {
  type: "member.invited";
  invitation: Invitation;
}

export interface RoleCreatedEvent extends EventBase {
  type: "role.created";
  role: Role;
}

export interface RoleChangedEvent extends EventBase {
  type: "role.changed";
  userId: UserId;
  added: RoleId[];
  removed: RoleId[];
}

export interface RoleDeletedEvent extends EventBase {
  type: "role.deleted";
  roleId: RoleId;
}

export interface PermissionGrantedEvent extends EventBase {
  type: "permission.granted";
  roleId: RoleId;
  permission: PermissionKey;
}

export interface PermissionRevokedEvent extends EventBase {
  type: "permission.revoked";
  roleId: RoleId;
  permission: PermissionKey;
}

export interface GroupUpdatedEvent extends EventBase {
  type: "group.updated";
  group: Group;
}

export interface GroupDeletedEvent extends EventBase {
  type: "group.deleted";
}

export interface GroupRelationshipChangedEvent extends EventBase {
  type: "group.relationship.changed";
  otherGroupId: GroupId;
  relationship: GroupRelationship | null; // null = cleared
}

export type JunjoEvent =
  | MemberJoinedEvent
  | MemberLeftEvent
  | MemberInvitedEvent
  | RoleCreatedEvent
  | RoleChangedEvent
  | RoleDeletedEvent
  | PermissionGrantedEvent
  | PermissionRevokedEvent
  | GroupUpdatedEvent
  | GroupDeletedEvent
  | GroupRelationshipChangedEvent;

export type JunjoEventType = JunjoEvent["type"];

// =====================================================================
// Auth adapter
// =====================================================================

export interface AuthAdapter {
  // Verifies the player's session token and returns the dev's own user
  // id. The id is opaque to Junjo: it's whatever the dev's auth provider
  // returns (Clerk user_xyz, Supabase uuid, Roblox UserId as string).
  verifyToken(token: string): Promise<{ userId: UserId } | null>;
}

// =====================================================================
// Webhooks
// =====================================================================

export interface WebhookSignatureHeaders {
  "junjo-signature": string;
  "junjo-timestamp": string;
}

export interface WebhookDelivery {
  id: string;
  endpointId: string;
  eventId: string;
  status: "pending" | "delivered" | "failed";
  attemptCount: number;
  lastAttemptAt: Date | null;
  nextAttemptAt: Date | null;
  responseStatus: number | null;
}

// =====================================================================
// Pagination
// =====================================================================

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PageOptions {
  limit?: number;
  cursor?: string;
}
