import type {
  AuditEntry,
  AuthAdapter,
  CreateGroupInput,
  CreateInvitationInput,
  CreateRoleInput,
  GameId,
  Group,
  GroupId,
  GroupRelationship,
  GroupRelationshipType,
  Invitation,
  JunjoEvent,
  ListAuditOptions,
  Member,
  MemberId,
  MemberPermissionOverride,
  Page,
  PageOptions,
  PermissionCheckResult,
  PermissionKey,
  Role,
  RoleId,
  SetMemberNotesInput,
  UpdateGroupInput,
  UpdateRoleInput,
  UserId,
  WebhookSignatureHeaders,
} from "@junjo/shared";

// =====================================================================
// Configuration
// =====================================================================

export interface JunjoConfig {
  apiKey: string;
  baseUrl?: string;
  authAdapter?: AuthAdapter;
  fetch?: typeof fetch;
}

// =====================================================================
// Errors
// =====================================================================

export class JunjoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "JunjoError";
  }
}

const NOT_IMPLEMENTED = new JunjoError("not implemented", "not_implemented");

// =====================================================================
// Top-level client
// =====================================================================

export class Junjo {
  readonly groups: GroupsApi;
  readonly roles: RolesApi;
  readonly members: MembersApi;
  readonly invitations: InvitationsApi;
  readonly audit: AuditApi;
  readonly webhooks: WebhooksApi;

  constructor(_config: JunjoConfig) {
    this.groups = new GroupsApi();
    this.roles = new RolesApi();
    this.members = new MembersApi();
    this.invitations = new InvitationsApi();
    this.audit = new AuditApi();
    this.webhooks = new WebhooksApi();
  }

  // The hot path for any game logic: "is this user allowed to do X in
  // this group?" Server-side cached.
  async can(_userId: UserId, _groupId: GroupId, _permission: PermissionKey): Promise<boolean> {
    throw NOT_IMPLEMENTED;
  }

  // Slightly richer than `can`: returns *why* a check passed or failed.
  // Useful for admin tooling and "you don't have permission because
  // your role X is missing key Y" UX.
  async check(
    _userId: UserId,
    _groupId: GroupId,
    _permission: PermissionKey,
  ): Promise<PermissionCheckResult> {
    throw NOT_IMPLEMENTED;
  }

  // Resolve a player session token to a Junjo user id. Calls the
  // configured auth adapter and the cross-game identity layer (cloud).
  async whoami(_token: string): Promise<{ userId: UserId } | null> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Groups
// =====================================================================

export class GroupsApi {
  async create(_input: CreateGroupInput): Promise<Group> {
    throw NOT_IMPLEMENTED;
  }

  async get(_id: GroupId): Promise<Group | null> {
    throw NOT_IMPLEMENTED;
  }

  async update(_id: GroupId, _input: UpdateGroupInput): Promise<Group> {
    throw NOT_IMPLEMENTED;
  }

  // Soft delete with a 7-day undo window. Pass `hard: true` to bypass.
  async delete(_id: GroupId, _opts?: { hard?: boolean }): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async restore(_id: GroupId): Promise<Group> {
    throw NOT_IMPLEMENTED;
  }

  async list(_opts?: PageOptions & { gameId?: GameId }): Promise<Page<Group>> {
    throw NOT_IMPLEMENTED;
  }

  // ------ Membership ------

  async inviteByUserId(
    _groupId: GroupId,
    _userId: UserId,
    _opts?: { roleId?: RoleId },
  ): Promise<Invitation> {
    throw NOT_IMPLEMENTED;
  }

  async inviteByCode(_groupId: GroupId, _input?: CreateInvitationInput): Promise<Invitation> {
    throw NOT_IMPLEMENTED;
  }

  async inviteByLink(
    _groupId: GroupId,
    _input?: CreateInvitationInput,
  ): Promise<{ invitation: Invitation; url: string }> {
    throw NOT_IMPLEMENTED;
  }

  // CSV bulk-invite. Accepts a stream of user-ids or emails.
  async bulkInvite(
    _groupId: GroupId,
    _csv: string | ReadableStream<Uint8Array>,
    _opts?: { roleId?: RoleId },
  ): Promise<{ invited: number; skipped: number; errors: Array<{ row: number; reason: string }> }> {
    throw NOT_IMPLEMENTED;
  }

  async acceptInvitation(_code: string): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async declineInvitation(_code: string): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async leave(_groupId: GroupId): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async kick(_groupId: GroupId, _userId: UserId, _opts?: { reason?: string }): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  // ------ Real-time ------

  // Returns a subscription handle. `close()` ends the SSE connection.
  subscribe(_groupId: GroupId, _handler: (event: JunjoEvent) => void): { close: () => void } {
    throw NOT_IMPLEMENTED;
  }

  // ------ Group relationships ------

  // Set a directed relationship A -> B. Pass `mutual: true` to also
  // write the reverse row (useful for symmetric relationships like
  // "ally" or "enemy" where both sides should agree).
  async setRelationship(
    _groupAId: GroupId,
    _groupBId: GroupId,
    _type: GroupRelationshipType,
    _opts?: { mutual?: boolean },
  ): Promise<GroupRelationship> {
    throw NOT_IMPLEMENTED;
  }

  async clearRelationship(
    _groupAId: GroupId,
    _groupBId: GroupId,
    _opts?: { mutual?: boolean },
  ): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async getRelationship(_groupAId: GroupId, _groupBId: GroupId): Promise<GroupRelationship | null> {
    throw NOT_IMPLEMENTED;
  }

  async listRelationships(_groupId: GroupId): Promise<GroupRelationship[]> {
    throw NOT_IMPLEMENTED;
  }

  // ------ Sub-groups / alliances ------

  async setParent(_groupId: GroupId, _parentGroupId: GroupId | null): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async listChildren(_groupId: GroupId): Promise<Group[]> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Roles
// =====================================================================

export class RolesApi {
  async create(_groupId: GroupId, _input: CreateRoleInput): Promise<Role> {
    throw NOT_IMPLEMENTED;
  }

  async get(_id: RoleId): Promise<Role | null> {
    throw NOT_IMPLEMENTED;
  }

  async update(_id: RoleId, _input: UpdateRoleInput): Promise<Role> {
    throw NOT_IMPLEMENTED;
  }

  async delete(_id: RoleId): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async list(_groupId: GroupId): Promise<Role[]> {
    throw NOT_IMPLEMENTED;
  }

  async grantPermission(_roleId: RoleId, _permission: PermissionKey): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async revokePermission(_roleId: RoleId, _permission: PermissionKey): Promise<void> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Members
// =====================================================================

export class MembersApi {
  async get(_groupId: GroupId, _userId: UserId): Promise<Member | null> {
    throw NOT_IMPLEMENTED;
  }

  async getById(_id: MemberId): Promise<Member | null> {
    throw NOT_IMPLEMENTED;
  }

  async list(_groupId: GroupId, _opts?: PageOptions): Promise<Page<Member>> {
    throw NOT_IMPLEMENTED;
  }

  // List the groups a user belongs to. Useful for the player profile UI.
  async listForUser(_userId: UserId, _opts?: { gameId?: GameId }): Promise<Member[]> {
    throw NOT_IMPLEMENTED;
  }

  async setMetadata(
    _groupId: GroupId,
    _userId: UserId,
    _metadata: Record<string, unknown>,
  ): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async setNotes(_groupId: GroupId, _userId: UserId, _input: SetMemberNotesInput): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async assignRole(_groupId: GroupId, _userId: UserId, _roleId: RoleId): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async removeRole(_groupId: GroupId, _userId: UserId, _roleId: RoleId): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  // Member-level permission override. Wins over role-derived permissions.
  async overridePermission(
    _groupId: GroupId,
    _userId: UserId,
    _permission: PermissionKey,
    _grant: boolean,
  ): Promise<MemberPermissionOverride> {
    throw NOT_IMPLEMENTED;
  }

  async clearPermissionOverride(
    _groupId: GroupId,
    _userId: UserId,
    _permission: PermissionKey,
  ): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async listPermissionOverrides(
    _groupId: GroupId,
    _userId: UserId,
  ): Promise<MemberPermissionOverride[]> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Invitations
// =====================================================================

export class InvitationsApi {
  // Pending + expired invites for a group. For moderation tooling and
  // the dashboard's "outstanding invites" view.
  async list(
    _groupId: GroupId,
    _opts?: PageOptions & { includeExpired?: boolean; includeUsed?: boolean },
  ): Promise<Page<Invitation>> {
    throw NOT_IMPLEMENTED;
  }

  async get(_code: string): Promise<Invitation | null> {
    throw NOT_IMPLEMENTED;
  }

  // Revoke an invite that hasn't been used yet. Already-used invites
  // are no-ops (a 200 with a "was-already-used" flag, not an error,
  // because the membership it created is the source of truth now).
  async revoke(_code: string): Promise<void> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Audit
// =====================================================================

export class AuditApi {
  async list(_groupId: GroupId, _opts?: ListAuditOptions): Promise<Page<AuditEntry>> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Webhooks
// =====================================================================

// Express-compatible request shape, kept structural so we don't take
// a runtime dependency on @types/express.
interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Buffer | string;
}
interface ExpressLikeResponse {
  status(code: number): ExpressLikeResponse;
  send(body?: unknown): void;
  sendStatus(code: number): void;
}
type ExpressLikeMiddleware = (
  req: ExpressLikeRequest,
  res: ExpressLikeResponse,
  next: (err?: unknown) => void,
) => void;

export class WebhooksApi {
  // Express-style middleware. Verifies the HMAC signature, parses the
  // event into a JunjoEvent, attaches it to req.body, then calls next().
  middleware(_opts?: { tolerance?: number }): ExpressLikeMiddleware {
    throw NOT_IMPLEMENTED;
  }

  // Lower-level: verify a raw body + signature header pair. Throws on
  // failure. Use this if you're not on Express.
  verify(
    _rawBody: string | Buffer,
    _headers: WebhookSignatureHeaders,
    _opts?: { tolerance?: number },
  ): JunjoEvent {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Re-exports for ergonomics
// =====================================================================

export type {
  AuditEntry,
  AuthAdapter,
  Group,
  GroupId,
  Invitation,
  JunjoEvent,
  Member,
  PermissionKey,
  Role,
  UserId,
} from "@junjo/shared";
