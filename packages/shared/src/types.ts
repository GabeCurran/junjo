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
  // Free-text issuer recorded with the ban when it was not issued by a
  // Junjo user. Returned verbatim; never resolved or rendered.
  issuer: string | null;
  // The person's moderation version (see `UserModeration`).
  version: number;
}

// A person's moderation state in a game. `version` is 0 for a person
// never moderated and rises by one with every game ban create, change
// or lift and every sanction issue or lift; conditional moderation
// writes send it as `If-Match`. `ban` is the active game ban, or null.
export interface UserModeration {
  userId: UserId;
  version: number;
  ban: Ban | null;
  // The person's active sanctions, newest first.
  sanctions: Sanction[];
}

// =====================================================================
// Sanctions (game-scoped, game-defined types)
// =====================================================================

// A sanction type: 1 to 32 characters, starting with a lowercase letter
// or digit, then lowercase letters, digits, "_", "." or "-". "ban" is
// reserved for the ban API.
export const SANCTION_TYPE_PATTERN = "^[a-z0-9][a-z0-9_.-]{0,31}$";
export const RESERVED_SANCTION_TYPES = ["ban"] as const;

// A game-wide restriction of a person, of a type the game names. At most
// one is active per person and type; it is active until lifted or until
// `expiresAt` passes (lazy expiry).
export interface Sanction {
  id: string;
  // The sanctioned person, rendered like every other user id.
  userId: UserId;
  type: string;
  reason: string | null;
  // Free-text issuer recorded verbatim; never resolved or rendered.
  issuer: string | null;
  // The person who issued it, when the request named one; rendered.
  issuedBy: UserId | null;
  startedAt: Date;
  // Null = permanent.
  expiresAt: Date | null;
  // The person's moderation version, shared with bans.
  version: number;
}

export interface CreateSanctionInput {
  userId: UserId;
  type: string;
  reason?: string | null;
  expiresAt?: Date | string | null;
  // May lie in the past (imports); at most 60 seconds ahead of the server.
  startedAt?: Date | string;
  issuer?: string;
  actorUserId?: UserId;
}

// Append-only sanction record: one "set" row per create or replace and
// one "lifted" row per lift. Lazy expiry writes no row.
export interface SanctionHistoryEntry {
  id: string;
  gameId: GameId;
  userId: UserId;
  type: string;
  kind: "set" | "lifted";
  // Snapshots at the moment of the event; null on lifts.
  reason: string | null;
  expiresAt: Date | null;
  // When the sanction started (a create, or a stated `startedAt`), was
  // replaced, or was lifted.
  eventAt: Date;
  // Who issued ("set") or lifted ("lifted") it, when the request named
  // someone; rendered.
  actorUserId: UserId | null;
  // Free-text issuer on "set" rows; null otherwise.
  issuer: string | null;
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
  // Free-text issuer of a game ban; null on lifts, group rows and bans
  // issued without one.
  issuer: string | null;
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
  // Starts at 1 and rises by exactly one with every write that changes
  // the member. Member-scoped writes accept it as `If-Match`.
  version: number;
  // The person's display name (see `LinkedIdentity.displayName` for how
  // it is picked). Present on member reads and write responses; absent
  // from the member snapshot inside `member.joined` events.
  displayName?: string | null;
}

// One row of `POST /v1/groups/:id/members/import`. Each present field
// replaces the member's current value; an absent field is left as is.
export interface MemberImportRow {
  userId: UserId;
  roleIds?: RoleId[];
  overrides?: PermissionEntry[];
  metadata?: MemberMetadata;
}

export interface MemberImportInput {
  members: MemberImportRow[];
  // Imports roles, overrides and metadata for banned people without
  // changing any ban.
  allowBanned?: boolean;
  actorUserId?: UserId;
}

export type MemberImportStatus = "created" | "reactivated" | "updated" | "unchanged";

export interface MemberImportResult {
  created: number;
  reactivated: number;
  updated: number;
  unchanged: number;
  items: { userId: UserId; status: MemberImportStatus; version: number }[];
}

// One failing row of an import, listed under `details.rows` on the
// error envelope.
export interface MemberImportRowError {
  index: number;
  userId: UserId;
  code:
    | "banned"
    | "invalid_user_id"
    | "bad_request"
    | "not_found"
    | "group_full"
    | "group_limit_reached";
  message: string;
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
  // The keys this role grants: every entry whose value is true. Deny
  // entries are listed only in `entries`.
  permissions: PermissionKey[];
  // Every entry on the role, grants and denies, sorted by key.
  entries: PermissionEntry[];
  // Roles this role inherits from, all in the same group.
  parents: RoleId[];
  metadata: RoleMetadata;
  createdAt: Date;
}

export type RoleMetadata = Record<string, unknown>;

export interface CreateRoleInput {
  name: string;
  priority: number;
  color?: string;
  isDefault?: boolean;
  permissions?: PermissionKey[];
  metadata?: RoleMetadata;
}

export interface UpdateRoleInput {
  name?: string;
  priority?: number;
  color?: string | null;
  isDefault?: boolean;
  // Replaces the whole object.
  metadata?: RoleMetadata;
}

// A group's roles with everything a local resolver needs, read in one
// call.
export interface RoleGraph {
  groupId: GroupId;
  mode: PermissionMode;
  defaultRoleId: RoleId | null;
  roles: Role[];
}

// One member's direct roles and overrides in a group, read in one call.
export interface MemberAccess {
  groupId: GroupId;
  userId: UserId;
  status: MemberStatus;
  roleIds: RoleId[];
  overrides: MemberPermissionOverride[];
  // The member's version (see `Member.version`).
  version: number;
  // The person's display name (see `Member.displayName`).
  displayName: string | null;
  // The member's metadata (see `Member.metadata`).
  metadata: Record<string, unknown>;
}

// Answer of the batch access read: one entry per requested id, in
// request order, null where the id names no member of the group.
export interface MemberAccessBatch {
  items: (MemberAccess | null)[];
}

// =====================================================================
// Permission
// =====================================================================

// An open string the game defines. In "exact" mode Junjo stores and
// matches each key verbatim; in "nodes" mode keys are normalized and
// matched as described on `PermissionMode`.
export type PermissionKey = string;

// How a game's permission keys are matched. "exact": keys are opaque
// and case-sensitive. "nodes": keys are dot-separated and folded to
// lowercase, a trailing `.*` matches one or more further segments, and
// a bare `*` matches every key.
export type PermissionMode = "exact" | "nodes";

export const PERMISSION_MODES = ["exact", "nodes"] as const satisfies readonly PermissionMode[];

// Conditions under which an entry applies: context key to value. An
// empty or absent context is global and applies to every check. Keys
// match `PERMISSION_CONTEXT_KEY_PATTERN`; values are 1 to
// `PERMISSION_CONTEXT_VALUE_MAX_LENGTH` characters with no control
// characters and are folded to lowercase with an ASCII-only fold on
// write and on check, in every permission mode.
export type PermissionContext = Record<string, string>;

export const PERMISSION_CONTEXT_KEY_PATTERN = "^[a-z][a-z0-9_]{0,31}$";
export const MAX_PERMISSION_CONTEXT_KEYS = 2;
export const PERMISSION_CONTEXT_VALUE_MAX_LENGTH = 64;
// Caps on `permissions.contexts` in the game config.
export const MAX_CONTEXT_INHERIT_DEPTH = 16;
export const MAX_CONTEXT_INHERIT_VALUES = 256;
export const MAX_CONTEXT_INHERIT_PARENTS = 8;

// One entry on a role. `value` true grants the key, false denies it.
// `context`, when present, limits the entry to checks whose context
// matches it (folded; absent for a global entry). An entry's identity
// is its permission and context together.
export interface PermissionEntry {
  permission: PermissionKey;
  value: boolean;
  context?: PermissionContext;
}

export type PermissionSource = "role" | "override" | "default" | "none";

export interface PermissionCheckResult {
  allowed: boolean;
  source: PermissionSource;
  // When source = "role", the role that granted it. When source =
  // "override", omitted (the override is by member).
  viaRoleId?: RoleId;
  // The group the decision was read from. Only populated on inherited
  // checks, and only when the result is decisive (source "role" or
  // "override"); it equals the queried group when the decision was
  // direct rather than inherited. Absent on non-inherited checks, so
  // their wire shape is unchanged.
  viaGroupId?: GroupId;
  // The deciding entry's context, folded. Absent when the deciding entry
  // is global or nothing decided.
  context?: PermissionContext;
}

// One triple of a batch permission check. Mirrors the query parameters
// of the single-check route. `context` is the check's context; absent
// means only global entries apply.
export interface PermissionCheckRequest {
  userId: UserId;
  groupId: GroupId;
  permission: PermissionKey;
  context?: PermissionContext;
}

// Results come back positionally: `results[i]` answers `checks[i]`.
export interface PermissionCheckBatchResult {
  results: PermissionCheckResult[];
}

export interface MemberPermissionOverride {
  groupId: GroupId;
  userId: UserId;
  permission: PermissionKey;
  // true = grant regardless of roles. false = revoke regardless of roles.
  grant: boolean;
  // As on `PermissionEntry`: absent for a global override.
  context?: PermissionContext;
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
  | "game.user.sanctioned"
  | "game.user.unsanctioned"
  | "game.permissions.mode.set"
  | "role.created"
  | "role.updated"
  | "role.deleted"
  | "role.assigned"
  | "role.unassigned"
  | "role.entries.changed"
  | "role.parents.set"
  | "permission.granted"
  | "permission.revoked"
  | "permission.override.set"
  | "permission.override.cleared"
  | "identity.linked"
  | "identity.unlinked";

export interface AuditEntry {
  id: AuditEntryId;
  // Null for game-scoped actions (game bans, identity links), which no
  // group audit listing returns.
  groupId: GroupId | null;
  // null when an action is taken by the system (e.g. invitation expiry).
  actorUserId: UserId | null;
  // The API key whose request wrote the entry; null for dashboard and
  // system writes.
  apiKey: AuditApiKey | null;
  action: AuditAction;
  // Free-form pointer to whatever the action targeted: a user id, role
  // id, permission key. Type depends on action. Ids are recorded as
  // written and are not re-rendered.
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditApiKey {
  id: string;
  name: string | null;
  prefix: string;
}

// =====================================================================
// Identity linking
// =====================================================================

// One of a person's ids in a game.
export interface LinkedIdentity {
  userId: UserId;
  // Text before the id's first ":", or null when it has none.
  namespace: string | null;
  // When the id joined the person; orders a person's ids.
  linkedAt: Date;
  // This id's own display name, or null. Where a response names a whole
  // person (members, member access, friends), `displayName` is the name
  // of the id the rendering rule picks; when that id has none, the most
  // recently set name among the person's ids; else null.
  displayName: string | null;
}

export const DISPLAY_NAME_MAX_LENGTH = 64;
export const DISPLAY_NAME_LOOKUP_LIMIT = 20;

// One match of `GET /v1/identities/by-name`. `userId` is the matching id
// itself, recorded literally (not rendered).
export interface DisplayNameMatch {
  userId: UserId;
  displayName: string;
  displayNameUpdatedAt: Date;
}

// A single-use code that links the redeeming id to the requesting id's
// person. Shown as two groups of four characters.
export interface LinkCode {
  code: string;
  expiresAt: Date;
}

export interface IdentityLinkResult {
  // The person after the link, named by the rendering rule.
  userId: UserId;
  // The id that joined the person.
  linkedUserId: UserId;
  identities: LinkedIdentity[];
}

export interface IdentityUnlinkResult {
  // The person the id left, named by one of their remaining ids.
  userId: UserId;
  // The id that left; it now names a new, empty person.
  unlinkedUserId: UserId;
  identities: LinkedIdentity[];
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
// permissions, group-level mutations). `groupId` routes them to that
// group's stream; the game stream carries every event of the game.
interface GroupEventBase extends EventBase {
  groupId: GroupId;
}

// Events with no group context (friends, blocks, game bans, identity
// links). Delivered by webhooks and the game stream, never by a group
// stream.
type UserEventBase = EventBase;

export interface MemberJoinedEvent extends GroupEventBase {
  type: "member.joined";
  userId: UserId;
  member: Member;
  // The member's version after the write. Every event one write emits
  // carries the same value.
  memberVersion: number;
}

export interface MemberLeftEvent extends GroupEventBase {
  type: "member.left";
  userId: UserId;
  reason: "left" | "kicked";
  kickedBy?: UserId;
  memberVersion: number;
}

// Which parts of a member a `member.updated` event changed. "notes"
// covers both the public and the private note; "overrides" covers the
// member's personal permission entries.
export type MemberChangeField = "metadata" | "notes" | "overrides";

// A change signal: carries what changed, not the new values. Read the
// member, or the member's access, for the current state.
export interface MemberUpdatedEvent extends GroupEventBase {
  type: "member.updated";
  userId: UserId;
  changed: MemberChangeField[];
  memberVersion: number;
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
  memberVersion: number;
}

// Which parts of a role a `role.updated` event changed.
export type RoleChangeField =
  | "name"
  | "priority"
  | "color"
  | "isDefault"
  | "metadata"
  | "entries"
  | "parents";

// A change signal: carries what changed, not the new values. Read the
// role or the group's role graph for the current state; the audit entry
// for the change carries the diff.
export interface RoleUpdatedEvent extends GroupEventBase {
  type: "role.updated";
  roleId: RoleId;
  changed: RoleChangeField[];
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

// User-scoped friend events. No `groupId`, so no group stream carries
// them. Across the request lifecycle `actorJunjoUserId` is the sender
// of the request and `targetJunjoUserId` its target; the event type
// tells you who took the action.
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
  memberVersion: number;
}

export interface MemberUnbannedEvent extends GroupEventBase {
  type: "member.unbanned";
  userId: UserId;
  memberVersion: number;
}

// Game-scoped ban events. No groupId, so no group stream carries them.
export interface GameUserBannedEvent extends UserEventBase {
  type: "game.user.banned";
  // Internal JunjoUser id.
  junjoUserId: string;
  // The banned person's external id, rendered per subscriber.
  userId: UserId;
  reason: string | null;
  expiresAt: Date | null;
  // The person's moderation version after the write.
  moderationVersion: number;
}

export interface GameUserUnbannedEvent extends UserEventBase {
  type: "game.user.unbanned";
  // Internal JunjoUser id.
  junjoUserId: string;
  // The unbanned person's external id, rendered per subscriber.
  userId: UserId;
  moderationVersion: number;
}

// Game-scoped sanction events. No groupId, so no group stream carries
// them. Lazy expiry emits nothing. The sanction's type travels as
// `sanctionType` because `type` is the event's own discriminator.
export interface GameUserSanctionedEvent extends UserEventBase {
  type: "game.user.sanctioned";
  // The sanctioned person, rendered per subscriber.
  userId: UserId;
  sanctionType: string;
  reason: string | null;
  expiresAt: Date | null;
  // The person's moderation version after the write.
  moderationVersion: number;
}

export interface GameUserUnsanctionedEvent extends UserEventBase {
  type: "game.user.unsanctioned";
  userId: UserId;
  sanctionType: string;
  moderationVersion: number;
}

// Game-scoped identity change signal. `userId` names the person and is
// rendered per subscriber; `changedUserId` is the id whose value changed,
// recorded literally.
export type IdentityChangeField = "displayName";

export interface IdentityUpdatedEvent extends UserEventBase {
  type: "identity.updated";
  userId: UserId;
  changedUserId: UserId;
  // The changed id's new display name, or null when it was cleared.
  displayName: string | null;
  changed: IdentityChangeField[];
}

// Game-scoped identity events. No groupId, so no group stream carries
// them. `userId` names the person and is rendered per subscriber like
// every other user id; the remaining id fields are literal and never
// rewritten.
export interface IdentityLinkedEvent extends UserEventBase {
  type: "identity.linked";
  userId: UserId;
  // The id that joined the person.
  linkedUserId: UserId;
  // Every id the person holds in the game after the link,
  // earliest-linked first.
  identities: UserId[];
}

export interface IdentityUnlinkedEvent extends UserEventBase {
  type: "identity.unlinked";
  // The person the id left, named by one of their remaining ids.
  userId: UserId;
  // The id that left; it now names a new, empty person.
  unlinkedUserId: UserId;
  // The ids the person still holds, earliest-linked first.
  identities: UserId[];
}

export type JunjoEvent =
  | MemberJoinedEvent
  | MemberLeftEvent
  | MemberInvitedEvent
  | MemberUpdatedEvent
  | MemberBannedEvent
  | MemberUnbannedEvent
  | RoleCreatedEvent
  | RoleChangedEvent
  | RoleUpdatedEvent
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
  | GameUserUnbannedEvent
  | GameUserSanctionedEvent
  | GameUserUnsanctionedEvent
  | IdentityLinkedEvent
  | IdentityUnlinkedEvent
  | IdentityUpdatedEvent;

export type JunjoEventType = JunjoEvent["type"];

// Type guard: events with a groupId are fanned to that group's stream
// subscribers; events without one reach only webhooks and the game
// stream.
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
  // Ordered namespace preference applied to the user ids in this
  // endpoint's payloads. Empty means no preference.
  preferredNamespaces: string[];
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
  // At most MAX_PREFERRED_NAMESPACES entries, no repeats. Defaults to none.
  preferredNamespaces?: string[];
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  events?: JunjoEventType[];
  // true sets `disabledAt = now()`; false clears it.
  disabled?: boolean;
  format?: WebhookEndpointFormat;
  // Replaces the stored preference; an empty list clears it.
  preferredNamespaces?: string[];
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
  // The friend's display name (see `Member.displayName`). Present on
  // friends list entries only.
  displayName?: string | null;
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

// Inheritance between the values of one context key: each value maps
// to the values whose entries it inherits. Resolution is transitive and
// ranks a nearer value above a farther one.
export interface GameConfigPermissionContext {
  inherit: Record<string, string[]>;
}

export interface GameConfigPermissions {
  mode: PermissionMode;
  // Context key to its value inheritance. A key that is not listed has
  // none: only entries for the exact value apply.
  contexts: Record<string, GameConfigPermissionContext>;
}

// A canonical id format a game can declare for one namespace. "uuid" is
// the lowercase, hyphenated 8-4-4-4-12 hex form.
export type UserIdFormat = "uuid";

export const USER_ID_FORMATS = ["uuid"] as const satisfies readonly UserIdFormat[];

// A user id's namespace is the text before its first ":". It is only
// consulted when a caller states a preference or the game declares a
// format for it; ids without a ":" have no namespace.
export const USER_ID_NAMESPACE_PATTERN = "^[a-z0-9_-]{1,32}$";
export const MAX_DECLARED_ID_FORMATS = 16;
export const MAX_PREFERRED_NAMESPACES = 8;

export interface GameConfigIdentity {
  // Namespace to the format every id in it must match. Ids in a declared
  // namespace that do not match are rejected on every path that accepts
  // a user id.
  formats: Record<string, UserIdFormat>;
}

// Limits for every group of one kind. Each field is optional; an absent
// field imposes nothing.
export interface GroupKindLimits {
  // Active members one group of the kind may hold (1 to 100000).
  maxMembers?: number;
  // Active memberships one person may hold across live groups of the
  // kind (1 to 1000).
  maxPerUser?: number;
  // Soft-delete a group of the kind when a leave, kick or ban leaves it
  // with no active members.
  deleteWhenEmpty?: boolean;
  // Soft-delete a live group of the kind once its membership has not
  // changed for this many hours (1 to 8760).
  idleDeleteHours?: number;
}

export const MAX_GROUP_KINDS = 32;

export interface GameConfigGroups {
  // Group kind to its limits. A kind that is not listed has none.
  kinds: Record<string, GroupKindLimits>;
}

export interface GameConfig {
  friends: GameConfigFriends;
  blocks: GameConfigBlocks;
  permissions: GameConfigPermissions;
  identity: GameConfigIdentity;
  groups: GameConfigGroups;
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
  // `contexts` replaces the stored map as a whole.
  permissions?: Partial<GameConfigPermissions>;
  // `formats` replaces the stored map as a whole.
  identity?: Partial<GameConfigIdentity>;
  // `kinds` replaces the stored map as a whole.
  groups?: Partial<GameConfigGroups>;
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
  "permission_mode_conflict",
  "invalid_user_id",
  "identity_format_conflict",
  "link_code_invalid",
  "link_refused",
  "banned",
  "group_full",
  "group_limit_reached",
  "passcode_required",
  "passcode_invalid",
  "invitation_expired",
  "invitation_used",
  "restore_window_expired",
  "rate_limit_exceeded",
  "too_many_streams",
  "stream_position_expired",
  "idempotency_key_reused",
  "idempotency_key_in_progress",
  "precondition_failed",
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
  // Structured detail. The member import sets
  // `{ rows: MemberImportRowError[] }`; ban and sanction lifts with
  // nothing to lift set `{ reason: "not_active" }`.
  details?: Record<string, unknown>;
}

// =====================================================================
// Game export
// =====================================================================

// Record kinds of `GET /v1/export`, in the order they appear between
// the header line and the end line.
export const EXPORT_RECORD_KINDS = [
  "game",
  "person",
  "group",
  "role",
  "member",
  "invitation",
  "relationship",
  "ban",
  "banHistory",
  "sanction",
  "sanctionHistory",
  "friendship",
  "friendRequest",
  "block",
  "friendTag",
  "audit",
] as const;

export type ExportRecordKind = (typeof EXPORT_RECORD_KINDS)[number];

export interface ExportHeader {
  kind: "header";
  format: "junjo-export";
  version: 1;
  gameId: GameId;
  exportedAt: string;
  // The game's stream position, read before any record.
  position: string;
}

export interface ExportEnd {
  kind: "end";
  // Records written per kind; every kind is listed.
  counts: Record<ExportRecordKind, number>;
}
