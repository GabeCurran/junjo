// =====================================================================
// Identity
// =====================================================================
//
// Brand prevents `kick(groupId, userId)` from being called with the args
// swapped (TS would accept it if both were plain `string`).

declare const brand: unique symbol;
type Brand<T, B> = T & { readonly [brand]: B };

export type GameId = Brand<string, "GameId">;
export type GroupId = Brand<string, "GroupId">;
export type RoleId = Brand<string, "RoleId">;
export type MemberId = Brand<string, "MemberId">;
export type UserId = Brand<string, "UserId">;
export type InvitationId = Brand<string, "InvitationId">;
export type AuditEntryId = Brand<string, "AuditEntryId">;
export type WebhookEndpointId = Brand<string, "WebhookEndpointId">;

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
  // null = top-level group. Cycle-checked server-side.
  parentGroupId: GroupId | null;
  memberCount: number;
  // True when the group has a passcode set. The plaintext passcode is
  // never returned by the API; this flag tells callers whether they
  // need to prompt for one before calling `groups.join`.
  hasPasscode: boolean;
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
  // Optional external user id of the group's creator. When supplied, the
  // create call atomically adds them as an active member, writes a
  // `member.joined` audit entry tagged `via: "creator"`, and fires the
  // `member.joined` webhook event in the same flow as a public-join.
  // Works for every visibility (public, invite-only, secret) so creators
  // of non-public groups don't need a separate join call. If
  // `defaultRoleId` is set AND a Role row with that id already exists in
  // the (newly created) group, the role is assigned to the creator in
  // the same transaction; otherwise the role assignment is silently
  // skipped.
  creatorUserId?: UserId;
  // Optional shared-secret join gate. 4-128 chars. Stored as a
  // scrypt hash; never returned by the API. Members joining via
  // `groups.join` must supply the same string.
  passcode?: string;
}

export interface UpdateGroupInput {
  name?: string;
  visibility?: GroupVisibility;
  metadata?: GroupMetadata;
  defaultRoleId?: RoleId | null;
  // Pass a string to set/replace the passcode; pass `null` to clear it.
  // Omit to leave the existing passcode (if any) untouched.
  passcode?: string | null;
}

// =====================================================================
// Bans (game-scoped)
// =====================================================================

// Game-wide ban applied across every group in the game. Per-group bans
// live as `Member.status = "banned"` instead.
export interface Ban {
  id: string;
  gameId: GameId;
  // The dev's external user id (the one their auth provider returns),
  // not the internal JunjoUser id. Same convention as Member.userId.
  userId: UserId;
  bannedAt: Date;
  // Null = permanent. A value in the past means the ban has lapsed
  // (lazy expiry; the server does not auto-clean expired rows).
  expiresAt: Date | null;
  reason: string | null;
  // Resolved actor external user id; null when issued server-side.
  bannedBy: UserId | null;
}

// Append-only ban-event record. One row per set/lift on either surface
// (game-wide or per-group). The structured timeline keyed by
// (gameId, userId) for "show me this user's ban history" without
// scanning AuditEntry payloads. Returned by `bans.history(userId)`.
export interface BanHistoryEntry {
  id: string;
  gameId: GameId;
  userId: UserId;
  // "game" rows have groupId=null; "group" rows have groupId set.
  scope: "game" | "group";
  groupId: GroupId | null;
  // "set" = ban issued. "lifted" = ban removed (manual unban; the
  // server does not write a row for lazy expiry, only for explicit
  // operator action).
  kind: "set" | "lifted";
  // Snapshot at the moment of the event; null on lifts and on bans
  // issued without a reason / with no expiry.
  reason: string | null;
  expiresAt: Date | null;
  eventAt: Date;
  // Resolved actor external user id; null when issued server-side.
  actorUserId: UserId | null;
}

// =====================================================================
// Member
// =====================================================================

export type MemberStatus = "active" | "invited" | "left" | "kicked" | "banned";

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
  // Only meaningful when status="banned". Null = permanent ban; an ISO
  // timestamp in the past means the ban has lapsed (lazy expiry, server
  // does not auto-flip status). Always null for non-banned members.
  bannedUntil: Date | null;
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
  // Higher number = more authority. You can't kick someone with a higher
  // priority than yours.
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
// Stored *directed* (A -> B) so asymmetric relationships are possible;
// symmetry is opt-in (`setRelationship(..., { mutual: true })` writes
// both rows).
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
  | "group.passcode.set"
  | "group.passcode.cleared"
  | "member.invited"
  | "member.joined"
  | "member.left"
  | "member.kicked"
  | "member.banned"
  | "member.unbanned"
  | "member.metadata.updated"
  | "member.notes.updated"
  | "game.user.banned"
  | "game.user.unbanned"
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
  occurredAt: Date;
}

// Most JunjoEvent types are scoped to a single group (members, roles,
// permissions, group-level mutations). The EventHub uses `groupId` to
// route SSE deliveries to per-group subscribers.
interface GroupEventBase extends EventBase {
  groupId: GroupId;
}

// User-scoped events (friends, blocks). They have no group context;
// SSE delivery for these will use a separate per-user channel that
// post-V1 work introduces. Webhooks deliver them today.
type UserEventBase = EventBase;

export interface MemberJoinedEvent extends GroupEventBase {
  type: "member.joined";
  userId: UserId;
  member: Member;
}

export interface MemberLeftEvent extends GroupEventBase {
  type: "member.left";
  userId: UserId;
  reason: "left" | "kicked";
  kickedBy?: UserId;
}

export interface MemberInvitedEvent extends GroupEventBase {
  type: "member.invited";
  invitation: Invitation;
}

export interface RoleCreatedEvent extends GroupEventBase {
  type: "role.created";
  role: Role;
}

export interface RoleChangedEvent extends GroupEventBase {
  type: "role.changed";
  userId: UserId;
  added: RoleId[];
  removed: RoleId[];
}

export interface RoleDeletedEvent extends GroupEventBase {
  type: "role.deleted";
  roleId: RoleId;
}

export interface PermissionGrantedEvent extends GroupEventBase {
  type: "permission.granted";
  roleId: RoleId;
  permission: PermissionKey;
}

export interface PermissionRevokedEvent extends GroupEventBase {
  type: "permission.revoked";
  roleId: RoleId;
  permission: PermissionKey;
}

export interface GroupUpdatedEvent extends GroupEventBase {
  type: "group.updated";
  group: Group;
}

export interface GroupDeletedEvent extends GroupEventBase {
  type: "group.deleted";
}

export interface GroupRelationshipChangedEvent extends GroupEventBase {
  type: "group.relationship.changed";
  otherGroupId: GroupId;
  relationship: GroupRelationship | null; // null = cleared
}

// User-scoped friend events. No `groupId`. The accepted-event fires
// only to the original sender (the accepter does not need to be told
// they accepted). The removed-event fires only to the OTHER party
// (the user who triggered the removal already knows). The decline-
// path is intentionally silent (no event); same for blocks.
export interface FriendRequestSentEvent extends UserEventBase {
  type: "friend.request.sent";
  requestId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
}

export interface FriendRequestAcceptedEvent extends UserEventBase {
  type: "friend.request.accepted";
  relationshipId: string;
  // The user who originally sent the request (and who receives this event).
  actorJunjoUserId: string;
  // The user who accepted.
  targetJunjoUserId: string;
  respondedAt: Date;
}

export interface FriendRemovedEvent extends UserEventBase {
  type: "friend.removed";
  // The party who initiated the removal.
  removedByJunjoUserId: string;
  // The party who was removed (and who receives this event).
  otherJunjoUserId: string;
}

// Group-scoped ban events. Fire when a moderator flips a member to
// status="banned" / unbans them via the per-group ban endpoints.
export interface MemberBannedEvent extends GroupEventBase {
  type: "member.banned";
  userId: UserId;
  reason: string | null;
  // Null = permanent. ISO timestamp = lazy-expiry deadline.
  bannedUntil: Date | null;
}

export interface MemberUnbannedEvent extends GroupEventBase {
  type: "member.unbanned";
  userId: UserId;
}

// Game-scoped ban events. No groupId; route through webhook delivery
// only (SSE is per-group; same precedent as friend events).
export interface GameUserBannedEvent extends UserEventBase {
  type: "game.user.banned";
  junjoUserId: string;
  reason: string | null;
  expiresAt: Date | null;
}

export interface GameUserUnbannedEvent extends UserEventBase {
  type: "game.user.unbanned";
  junjoUserId: string;
}

export type JunjoEvent =
  | MemberJoinedEvent
  | MemberLeftEvent
  | MemberInvitedEvent
  | MemberBannedEvent
  | MemberUnbannedEvent
  | RoleCreatedEvent
  | RoleChangedEvent
  | RoleDeletedEvent
  | PermissionGrantedEvent
  | PermissionRevokedEvent
  | GroupUpdatedEvent
  | GroupDeletedEvent
  | GroupRelationshipChangedEvent
  | FriendRequestSentEvent
  | FriendRequestAcceptedEvent
  | FriendRemovedEvent
  | GameUserBannedEvent
  | GameUserUnbannedEvent;

export type JunjoEventType = JunjoEvent["type"];

// Type guard: events with a groupId can be fanned to per-group SSE
// subscribers; user-scoped events skip the SSE hub and only flow
// through webhook delivery.
export function isGroupScopedEvent(event: JunjoEvent): event is JunjoEvent & { groupId: GroupId } {
  return "groupId" in event && (event as { groupId?: unknown }).groupId !== undefined;
}

// =====================================================================
// Auth adapter
// =====================================================================

export interface AuthAdapter {
  // The userId is opaque to Junjo: whatever the dev's auth provider
  // returns (Clerk user_xyz, Supabase uuid, Roblox UserId as string).
  verifyToken(token: string): Promise<{ userId: UserId } | null>;
}

// =====================================================================
// Webhooks
// =====================================================================

export interface WebhookSignatureHeaders {
  "x-junjo-signature": string;
  "x-junjo-timestamp": string;
  "x-junjo-event": string;
  "x-junjo-event-id": string;
  "x-junjo-delivery-id": string;
}

// Wire format the worker applies at delivery time. "junjo" (the default)
// posts the raw JunjoEvent JSON with HMAC headers; "discord" and "slack"
// post target-shaped payloads and skip the HMAC (those targets
// authenticate via URL token, not headers).
export type WebhookEndpointFormat = "junjo" | "discord" | "slack";

export interface WebhookEndpoint {
  id: WebhookEndpointId;
  gameId: GameId;
  url: string;
  // Empty array = match every event type (the friendly default).
  events: JunjoEventType[];
  format: WebhookEndpointFormat;
  createdAt: Date;
  // When set, the endpoint is muted: matching events do not enqueue
  // deliveries.
  disabledAt: Date | null;
}

// Returned exactly once, as the response body of `endpoints.create`.
// The dev MUST persist this secret immediately: it is never surfaced
// again by `endpoints.list` or `endpoints.update`.
export interface WebhookEndpointWithSecret extends WebhookEndpoint {
  secret: string;
}

export interface CreateWebhookEndpointInput {
  url: string;
  events?: JunjoEventType[];
  // When omitted, the server generates a 32-byte base64url secret and
  // returns it on the create response.
  secret?: string;
  // Defaults to "junjo".
  format?: WebhookEndpointFormat;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  events?: JunjoEventType[];
  // true sets `disabledAt = now()`; false clears it.
  disabled?: boolean;
  format?: WebhookEndpointFormat;
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
// User relationships (Friends + blocks)
// =====================================================================

// Three states share one table. See the schema model for storage rules.
export type UserRelationshipType = "request" | "friend" | "blocked";

export const USER_RELATIONSHIP_TYPES = [
  "request",
  "friend",
  "blocked",
] as const satisfies readonly UserRelationshipType[];

declare const userRelBrand: unique symbol;
export type UserRelationshipId = string & { readonly [userRelBrand]: "UserRelationshipId" };

declare const friendTagBrand: unique symbol;
export type FriendTagId = string & { readonly [friendTagBrand]: "FriendTagId" };

// =====================================================================
// Game configuration
// =====================================================================
//
// Per-game toggles for the Friends subsystem (and a few related knobs).
// Each Game row carries a `config` JSON column that is a partial
// `GameConfig`; reading goes through `resolveGameConfig` on the server
// to fill missing branches with defaults so handlers always see a
// fully-populated tree.
//
// `friends.scope = "network"` AND a non-null `Game.networkId` shared
// with sibling Games means friends/blocks created in any sibling are
// visible from the others. Default null `networkId` keeps games
// isolated regardless of `scope`.

export type FriendsScope = "per-game" | "network";

export type FriendsListVisibility = "private" | "friends-only" | "public";

export const FRIENDS_LIST_VISIBILITY_VALUES = [
  "private",
  "friends-only",
  "public",
] as const satisfies readonly FriendsListVisibility[];

export interface GameConfigFriendsTags {
  enabled: boolean;
  maxPerUser: number;
}

export interface GameConfigFriendsDiscovery {
  enabled: boolean;
  minMutuals: number;
}

export interface GameConfigFriendsVisibility {
  allowed: FriendsListVisibility[];
  default: FriendsListVisibility;
}

export interface GameConfigFriends {
  enabled: boolean;
  scope: FriendsScope;
  requestsRequired: boolean;
  maxFriends: number;
  maxPendingRequests: number;
  tags: GameConfigFriendsTags;
  discovery: GameConfigFriendsDiscovery;
  visibility: GameConfigFriendsVisibility;
}

export interface GameConfigBlocks {
  enabled: boolean;
}

export interface GameConfig {
  friends: GameConfigFriends;
  blocks: GameConfigBlocks;
}

// Deeply-partial shape for PATCH payloads. Every nested branch is
// optional so callers can flip a single toggle without restating the
// rest of the tree.
export type PartialGameConfig = {
  friends?: Partial<Omit<GameConfigFriends, "tags" | "discovery" | "visibility">> & {
    tags?: Partial<GameConfigFriendsTags>;
    discovery?: Partial<GameConfigFriendsDiscovery>;
    visibility?: Partial<GameConfigFriendsVisibility>;
  };
  blocks?: Partial<GameConfigBlocks>;
};

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
