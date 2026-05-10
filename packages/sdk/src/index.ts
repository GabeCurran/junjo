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
import { BansApi } from "./bans.js";
import { JunjoError } from "./errors.js";
import { FriendsApi } from "./friends.js";
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

// Per-game API keys are issued by the server in the shape `jk_<prefix>.<secret>`.
// The cross-game admin token (`jadm_<random>`) is a separate, narrower
// credential that ONLY gates /v1/admin/*; sending it as the SDK apiKey
// surfaces server-side as the cryptic "malformed API key". Catch the
// known confusion at construction time so the developer gets a useful
// message before any network round-trip.
const API_KEY_SHAPE = /^jk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

let warnedNonStandardKeyShape = false;

function validateApiKeyShape(apiKey: unknown): void {
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new JunjoError(
      "missing apiKey: pass a per-game API key to `new Junjo({ apiKey })`",
      "invalid_config",
    );
  }
  if (apiKey.startsWith("jadm_")) {
    throw new JunjoError(
      "apiKey looks like a cross-game admin token (jadm_*); the SDK needs a per-game API key (jk_<prefix>.<secret>). Mint one via POST /v1/admin/games/:gameId/api-keys.",
      "invalid_config",
    );
  }
  // Non-conforming strings might be valid in tests / forward-compat
  // contexts, so warn once instead of throwing -- the server is still
  // the source of truth and will reject genuinely-bad keys with 401.
  if (!API_KEY_SHAPE.test(apiKey) && !warnedNonStandardKeyShape) {
    warnedNonStandardKeyShape = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[junjo-sdk] apiKey does not match the expected jk_<prefix>.<secret> shape; the server may reject it as malformed. Pass a per-game key minted via /v1/admin/games/:gameId/api-keys.",
    );
  }
}

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
  readonly friends: FriendsApi;
  readonly bans: BansApi;
  private readonly http: HttpClient;
  private readonly authAdapter: AuthAdapter | undefined;

  constructor(config: JunjoConfig) {
    validateApiKeyShape(config.apiKey);
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
    this.friends = new FriendsApi(this.http);
    this.bans = new BansApi(this.http);
    this.authAdapter = config.authAdapter;
  }

  async can(userId: UserId, groupId: GroupId, permission: PermissionKey): Promise<boolean> {
    const result = await this.check(userId, groupId, permission);
    return result.allowed;
  }

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

  async whoami(token: string): Promise<{ userId: UserId } | null> {
    if (!this.authAdapter) {
      throw new JunjoError(
        "whoami requires an authAdapter; pass one to `new Junjo({ authAdapter })`",
        "invalid_config",
      );
    }
    return this.authAdapter.verifyToken(token);
  }
}

// =====================================================================
// Re-exports for ergonomics
// =====================================================================

export { AuditApi } from "./audit.js";
export { BansApi } from "./bans.js";
export type { CreateBanInput, ListBansOptions, ListBanHistoryOptions } from "./bans.js";
export { JunjoError } from "./errors.js";
export { FriendsApi } from "./friends.js";
export type {
  Block,
  Friendship,
  FriendRequest,
  FriendRequestList,
  FriendRequestSendResult,
  FriendshipPage,
  FriendSuggestion,
  FriendTag,
  FriendTagAssignment,
  UserVisibilitySettings,
} from "./friends.js";
export { GroupsApi } from "./groups.js";
export type { SubscribeOptions, Subscription } from "./groups.js";
export { InvitationsApi } from "./invitations.js";
export type { ListInvitationsOptions } from "./invitations.js";
export { MembersApi } from "./members.js";
export type { ListMembersOptions } from "./members.js";
export { paginate } from "./pagination.js";
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
  Ban,
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
  WebhookEndpointFormat,
  WebhookEndpointId,
  WebhookEndpointWithSecret,
  WebhookSignatureHeaders,
} from "@junjo/shared";
