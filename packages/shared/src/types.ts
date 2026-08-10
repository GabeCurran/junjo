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

// An open string the game defines. The server stores it verbatim and
// never branches on it; it exists for the dev's UI and analytics.
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
  // notesPublic: intended for display to other group members.
  // notesPrivate: intended for group staff only. The server stores both
  // verbatim and returns both to API callers; enforcing who sees which
  // is the game's responsibility.
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

// An open string the game defines. Junjo stores each key verbatim and
// answers can(user, group, key) without ever interpreting the key
// itself.
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

// An open string the game defines. The server stores it verbatim and
// never branches on it.
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
  // Page boundary: a Date (sent as ISO 8601) or an opaque cursor string
  // from a previous page's `nextCursor`, passed through verbatim.
  before?: Date | string;
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
  // External id of the operator who performed the assign / unassign.
  // Null when the change was made via a per-game API key with no
  // explicit actor body (legacy callers and server-side admin paths).
  // Populated when the caller supplies `actorUserId` on the role
  // assign / unassign request.
  actorUserId: UserId | null;
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

// User-scoped friend events. No `groupId`. All friend events route
// through webhook delivery only (SSE is per-group). Field convention
// across the request lifecycle: `actorJunjoUserId` is always the
// ORIGINAL sender of the request, `targetJunjoUserId` is always the
// original target. The event type tells you who took the action.
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

// Fires when the recipient declines a pending request via
// POST /v1/friend-requests/:id/decline.
export interface FriendRequestDeclinedEvent extends UserEventBase {
  type: "friend.request.declined";
  requestId: string;
  // The original sender (and who receives this event).
  actorJunjoUserId: string;
  // The recipient who declined.
  targetJunjoUserId: string;
}

// Fires when the original sender cancels their own outbound request.
// Same actor-required contract as declined.
export interface FriendRequestCancelledEvent extends UserEventBase {
  type: "friend.request.cancelled";
  requestId: string;
  // The original sender (who cancelled).
  actorJunjoUserId: string;
  // The original target (who is being told the request is gone).
  targetJunjoUserId: string;
}

export interface FriendRemovedEvent extends UserEventBase {
  type: "friend.removed";
  // The party who initiated the removal.
  removedByJunjoUserId: string;
  // The party who was removed (and who receives this event).
  otherJunjoUserId: string;
}

export interface FriendBlockedEvent extends UserEventBase {
  type: "friend.blocked";
  // The user who initiated the block.
  byJunjoUserId: string;
  // The user who was blocked.
  otherJunjoUserId: string;
}

export interface FriendUnblockedEvent extends UserEventBase {
  type: "friend.unblocked";
  byJunjoUserId: string;
  otherJunjoUserId: string;
}

// =====================================================================
// Friendship state (single-pair probe)
// =====================================================================

// The viewer-perspective relationship state between two users.
// "friends": there is a mutual friendship.
// "request_outgoing": viewer has sent a request to other, awaiting.
// "request_incoming": other has sent a request to viewer, awaiting.
// "blocked_by_me": viewer has blocked other.
// "blocked_by_them": other has blocked viewer.
// "none": no relationship.
export type FriendshipState =
  | "friends"
  | "request_outgoing"
  | "request_incoming"
  | "blocked_by_me"
  | "blocked_by_them"
  | "none";

export interface FriendshipRelationship {
  state: FriendshipState;
  // friends: friendship start (respondedAt).
  // request_*: when the request was sent (createdAt).
  // blocked_*: when the block happened (createdAt).
  // none: undefined.
  since?: Date;
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
  | FriendRequestDeclinedEvent
  | FriendRequestCancelledEvent
  | FriendRemovedEvent
  | FriendBlockedEvent
  | FriendUnblockedEvent
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
  // The userId is opaque to Junjo: whatever external id the game's
  // auth provider issues, passed through as a string.
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

// Domain shapes returned by the friends routes. Ids are the underlying
// UserRelationship / FriendTag row ids. `junjoUserId` fields carry the
// dev's EXTERNAL user ids (resolved by the server before serialization),
// matching the userId convention on Member and Ban.

export interface FriendRequest {
  id: UserRelationshipId;
  gameId: GameId;
  // The original sender.
  actorJunjoUserId: UserId;
  // The original target.
  targetJunjoUserId: UserId;
  createdAt: Date;
}

// One side of a mutual friendship, from the queried user's point of
// view: `junjoUserId` is the OTHER party.
export interface Friendship {
  id: UserRelationshipId;
  gameId: GameId;
  junjoUserId: UserId;
  since: Date;
}

// Response of `requests.send`. `status` tells the caller which shape is
// populated: "pending" carries `request`; "auto-accepted" (games with
// requestsRequired=false) carries `friendship`.
export interface FriendRequestSendResult {
  status: "pending" | "auto-accepted";
  request?: FriendRequest;
  friendship?: Friendship;
}

export interface FriendRequestList {
  inbound: FriendRequest[];
  outbound: FriendRequest[];
}

export interface Block {
  id: UserRelationshipId;
  gameId: GameId;
  // The blocked party, from the queried user's point of view.
  junjoUserId: UserId;
  blockedAt: Date;
}

export interface FriendTag {
  id: FriendTagId;
  gameId: GameId;
  // The tag owner.
  junjoUserId: UserId;
  name: string;
  color: string | null;
  createdAt: Date;
}

export interface FriendTagAssignment {
  friendJunjoUserId: UserId;
  tagIds: FriendTagId[];
}

export interface UserVisibilitySettings {
  gameId: GameId;
  junjoUserId: UserId;
  friendsListVisibility: FriendsListVisibility;
  // The game-config allowlist the user may pick from.
  allowed: FriendsListVisibility[];
  // Null until the user first overrides the game default.
  updatedAt: Date | null;
}

export interface FriendSuggestion {
  junjoUserId: UserId;
  mutualCount: number;
  sampleMutualJunjoUserIds: UserId[];
}

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

// =====================================================================
// Errors
// =====================================================================

// Canonical set of `code` values the server's error envelope can carry.
// The server types its error factory against this union, so adding a
// code there without listing it here fails to compile. SDK-side-only
// failure codes (transport errors, webhook verification, wire parsing)
// are defined by each SDK, not here.
export const JUNJO_ERROR_CODES = [
  "bad_request",
  "invalid_api_key",
  "invalid_admin_token",
  "permission_denied",
  "not_found",
  "already_member",
  "role_has_members",
  "role_name_taken",
  "role_group_mismatch",
  "parent_cycle",
  "banned",
  "passcode_required",
  "passcode_invalid",
  "invitation_expired",
  "invitation_used",
  "restore_window_expired",
  "rate_limit_exceeded",
  "internal",
] as const;

export type JunjoErrorCode = (typeof JUNJO_ERROR_CODES)[number];

// The JSON envelope every non-2xx server response carries.
export interface JunjoErrorEnvelope {
  code: JunjoErrorCode;
  status: number;
  message: string;
  // Correlation id, present on internal-500 responses; matches the
  // x-request-id response header.
  requestId?: string;
}
