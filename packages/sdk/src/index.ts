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
  // Per-game secret API key (`jk_<prefix>.<secret>`). This credential
  // authorizes every read and mutation on the game; treat it like a
  // database password. Never ship it to browsers (no NEXT_PUBLIC_ /
  // VITE_ env vars, no client bundles): construct the client on your
  // server, or use `proxy: true` and inject the key in a backend proxy.
  // Required unless `proxy` is true, in which case it must be omitted.
  apiKey?: string;
  baseUrl?: string;
  // Base URL used to build invite-link URLs from `inviteByLink`. The dev's
  // frontend handles the actual UI at `${inviteBaseUrl}/invite/${code}`.
  // Defaults to `baseUrl`; set this to your frontend's origin when the
  // frontend lives at a different host than the API.
  inviteBaseUrl?: string;
  // Proxy mode, for browser apps: requests are sent with NO authorization
  // header to your own backend (`baseUrl` is required, e.g. "/api/junjo"),
  // which forwards them to the Junjo API and injects the real API key
  // server-side. The proxy is also the place to enforce per-user
  // authorization: the jk_ key is full-control, so forward only the
  // routes (and user ids) the signed-in user is allowed to touch.
  proxy?: boolean;
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
let warnedBrowserSecretKey = false;

// A jk_ key in a browser context is readable by every visitor (bundle,
// devtools, network tab). Warn loudly but once; throwing would break
// legitimate non-window environments that happen to polyfill `window`.
function warnIfSecretKeyInBrowser(apiKey: string): void {
  if (warnedBrowserSecretKey) return;
  if (typeof window === "undefined") return;
  if (!API_KEY_SHAPE.test(apiKey)) return;
  warnedBrowserSecretKey = true;
  // eslint-disable-next-line no-console
  console.warn(
    '[junjo-sdk] a secret per-game API key (jk_*) is being used in a browser; every visitor can read it and gain full control of the game. Construct the client on your server instead, or use `new Junjo({ proxy: true, baseUrl: "/api/junjo" })` with a backend proxy that injects the key.',
  );
}

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
    let apiKey: string | undefined;
    let baseUrl: string;
    if (config.proxy) {
      // In proxy mode the SDK must never hold a credential: accepting an
      // apiKey here would defeat the point (the key would still ship to
      // the browser), so it is a hard error rather than silently ignored.
      if (config.apiKey !== undefined) {
        throw new JunjoError(
          "proxy mode does not take an apiKey; your backend proxy injects the credential. Remove `apiKey` or remove `proxy: true`.",
          "invalid_config",
        );
      }
      if (config.baseUrl === undefined) {
        throw new JunjoError(
          'proxy mode requires `baseUrl` pointing at your proxy (e.g. "/api/junjo"); the default Junjo API would reject unauthenticated requests.',
          "invalid_config",
        );
      }
      baseUrl = config.baseUrl;
    } else {
      validateApiKeyShape(config.apiKey);
      apiKey = config.apiKey as string;
      warnIfSecretKeyInBrowser(apiKey);
      baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    }
    const fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.http = new HttpClient({
      apiKey,
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
export { UNKNOWN_EVENT_TYPE } from "./events.js";
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
