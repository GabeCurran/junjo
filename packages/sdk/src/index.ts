import type {
  AuthAdapter,
  GroupId,
  PermissionCheckResult,
  PermissionKey,
  PermissionSource,
  RoleId,
  UserId,
} from "@junjo/shared";
import { AuditApi } from "./audit.js";
import { JunjoError } from "./errors.js";
import { GroupsApi } from "./groups.js";
import { HttpClient } from "./http.js";
import { InvitationsApi } from "./invitations.js";
import { MembersApi } from "./members.js";
import { RolesApi } from "./roles.js";
import { WebhooksApi } from "./webhooks.js";

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

interface WirePermissionCheckResult {
  allowed: boolean;
  source: PermissionSource;
  viaRoleId?: string;
}

export class Junjo {
  readonly groups: GroupsApi;
  readonly roles: RolesApi;
  readonly members: MembersApi;
  readonly invitations: InvitationsApi;
  readonly audit: AuditApi;
  readonly webhooks: WebhooksApi;
  private readonly http: HttpClient;

  constructor(config: JunjoConfig) {
    const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.http = new HttpClient({
      apiKey: config.apiKey,
      baseUrl,
      fetch: fetchImpl,
    });
    const inviteBaseUrl = (config.inviteBaseUrl ?? baseUrl).replace(/\/+$/, "");
    this.groups = new GroupsApi(this.http, inviteBaseUrl);
    this.roles = new RolesApi(this.http);
    this.members = new MembersApi(this.http);
    this.invitations = new InvitationsApi(this.http);
    this.audit = new AuditApi(this.http);
    this.webhooks = new WebhooksApi(this.http);
  }

  // The hot path for any game logic: "is this user allowed to do X in
  // this group?" Server-side cached. Boolean wrapper around `check`.
  async can(userId: UserId, groupId: GroupId, permission: PermissionKey): Promise<boolean> {
    const result = await this.check(userId, groupId, permission);
    return result.allowed;
  }

  // Slightly richer than `can`: returns *why* a check passed or failed.
  // Useful for admin tooling and "you don't have permission because
  // your role X is missing key Y" UX.
  async check(
    userId: UserId,
    groupId: GroupId,
    permission: PermissionKey,
  ): Promise<PermissionCheckResult> {
    const params = new URLSearchParams({
      userId,
      groupId,
      permission,
    });
    const wire = await this.http.get<WirePermissionCheckResult>(
      `/v1/permissions/check?${params.toString()}`,
    );
    const result: PermissionCheckResult = {
      allowed: wire.allowed,
      source: wire.source,
    };
    if (wire.viaRoleId !== undefined) result.viaRoleId = wire.viaRoleId as RoleId;
    return result;
  }

  // Resolve a player session token to a Junjo user id. Calls the
  // configured auth adapter and the cross-game identity layer (cloud).
  async whoami(_token: string): Promise<{ userId: UserId } | null> {
    throw NOT_IMPLEMENTED;
  }
}

// =====================================================================
// Re-exports for ergonomics
// =====================================================================

export { AuditApi } from "./audit.js";
export { JunjoError } from "./errors.js";
export { GroupsApi } from "./groups.js";
export { InvitationsApi } from "./invitations.js";
export { MembersApi } from "./members.js";
export { RolesApi } from "./roles.js";
export {
  WebhookEndpointsApi,
  WebhooksApi,
  WEBHOOK_DEFAULT_TOLERANCE_MS,
  WEBHOOK_SIGNATURE_SCHEME,
  signWebhookBody,
  verifyWebhook,
} from "./webhooks.js";
export type {
  ExpressLikeMiddleware,
  ExpressLikeRequest,
  ExpressLikeResponse,
  VerifyOptions,
  WebhookHeaders,
} from "./webhooks.js";

export type {
  AuditAction,
  AuditEntry,
  AuthAdapter,
  CreateWebhookEndpointInput,
  Group,
  GroupId,
  Invitation,
  JunjoEvent,
  JunjoEventType,
  ListAuditOptions,
  Member,
  PermissionCheckResult,
  PermissionKey,
  PermissionSource,
  Role,
  UpdateWebhookEndpointInput,
  UserId,
  WebhookEndpoint,
  WebhookEndpointId,
  WebhookEndpointWithSecret,
  WebhookSignatureHeaders,
} from "@junjo/shared";
