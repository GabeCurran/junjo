import type {
  AuditEntry,
  AuthAdapter,
  CreateRoleInput,
  GameId,
  GroupId,
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
  UpdateRoleInput,
  UserId,
  WebhookSignatureHeaders,
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import { GroupsApi } from "./groups.js";
import { HttpClient } from "./http.js";

// =====================================================================
// Configuration
// =====================================================================

export interface JunjoConfig {
  apiKey: string;
  baseUrl?: string;
  // Base URL used to build invite-link URLs from `inviteByLink`. The dev's
  // frontend handles the actual UI at `${inviteBaseUrl}/invite/${code}`.
  // Defaults to `baseUrl`; set this to your frontend's origin when the
  // frontend lives at a different host than the API.
  inviteBaseUrl?: string;
  authAdapter?: AuthAdapter;
  fetch?: typeof fetch;
}

const DEFAULT_BASE_URL = "https://api.junjo.io";

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

  constructor(config: JunjoConfig) {
    const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const http = new HttpClient({
      apiKey: config.apiKey,
      baseUrl,
      fetch: fetchImpl,
    });
    const inviteBaseUrl = (config.inviteBaseUrl ?? baseUrl).replace(/\/+$/, "");
    this.groups = new GroupsApi(http, inviteBaseUrl);
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
  async list(
    _groupId: GroupId,
    _opts?: PageOptions & { includeExpired?: boolean; includeUsed?: boolean },
  ): Promise<Page<Invitation>> {
    throw NOT_IMPLEMENTED;
  }

  async get(_code: string): Promise<Invitation | null> {
    throw NOT_IMPLEMENTED;
  }

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

interface ExpressLikeRequest {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
  rawBody?: Uint8Array | string;
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
  middleware(_opts?: { tolerance?: number }): ExpressLikeMiddleware {
    throw NOT_IMPLEMENTED;
  }

  verify(
    _rawBody: string | Uint8Array,
    _headers: WebhookSignatureHeaders,
    _opts?: { tolerance?: number },
  ): JunjoEvent {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Re-exports for ergonomics
// =====================================================================

export { JunjoError } from "./errors.js";
export { GroupsApi } from "./groups.js";

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
