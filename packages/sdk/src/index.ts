import type {
  AuditEntry,
  AuthAdapter,
  GroupId,
  JunjoEvent,
  ListAuditOptions,
  Page,
  PermissionCheckResult,
  PermissionKey,
  UserId,
  WebhookSignatureHeaders,
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import { GroupsApi } from "./groups.js";
import { HttpClient } from "./http.js";
import { InvitationsApi } from "./invitations.js";
import { MembersApi } from "./members.js";
import { RolesApi } from "./roles.js";

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
    this.roles = new RolesApi(http);
    this.members = new MembersApi(http);
    this.invitations = new InvitationsApi(http);
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
export { InvitationsApi } from "./invitations.js";
export { MembersApi } from "./members.js";
export { RolesApi } from "./roles.js";

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
