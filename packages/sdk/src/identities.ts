import type {
  IdentityLinkResult,
  IdentityUnlinkResult,
  LinkCode,
  LinkedIdentity,
  UserId,
} from "@junjo.io/shared";
import type { HttpClient } from "./http.js";
import { parseWireDate } from "./wire.js";

interface WireLinkedIdentity {
  userId: string;
  namespace: string | null;
  linkedAt: string;
}

interface WireLinkCode {
  code: string;
  expiresAt: string;
}

interface WireIdentityLinked {
  userId: string;
  linkedUserId: string;
  identities: WireLinkedIdentity[];
}

interface WireIdentityUnlinked {
  userId: string;
  unlinkedUserId: string;
  identities: WireLinkedIdentity[];
}

function deserializeLinkedIdentity(w: WireLinkedIdentity): LinkedIdentity {
  return {
    userId: w.userId as UserId,
    namespace: w.namespace,
    linkedAt: parseWireDate(w.linkedAt, "linkedAt"),
  };
}

/** Input for {@link IdentitiesApi.redeemLinkCode}. */
export interface RedeemLinkCodeInput {
  /**
   * The code as issued by `requestLinkCode`. Matched case-insensitively
   * with hyphens and spaces ignored, so user-typed variants are accepted.
   */
  code: string;
  /** The id that joins the code requester's person. */
  userId: UserId;
}

/**
 * Identity linking: one person may hold several external ids in a
 * game. A code requested for one id and redeemed for another joins the
 * two ids into one person; `unlink` splits an id back out.
 */
export class IdentitiesApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Every id held by the person that `userId` belongs to, earliest-linked
   * first. An id the game has never seen yields an empty list, not an
   * error.
   */
  async list(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<LinkedIdentity[]> {
    const wire = await this.http.get<{ items: WireLinkedIdentity[] }>(
      `/v1/users/${encodeURIComponent(userId)}/identities`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.items.map(deserializeLinkedIdentity);
  }

  /**
   * Issues a single-use link code for `userId`, creating the person if
   * the id is new. A new code cancels the id's earlier codes. Throws
   * `banned` for a banned id and `rate_limit_exceeded` (with
   * `retryAfterSeconds`) when the id requests codes too quickly.
   */
  async requestLinkCode(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<LinkCode> {
    const wire = await this.http.post<WireLinkCode>(
      `/v1/users/${encodeURIComponent(userId)}/link-codes`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return { code: wire.code, expiresAt: parseWireDate(wire.expiresAt, "expiresAt") };
  }

  /**
   * Redeems a link code for `input.userId`, joining that id and the code
   * requester's id into one person. Redeeming for an id already in the
   * same person succeeds without change. Throws `link_code_invalid` for
   * an unknown, expired, or used code (one answer for all three),
   * `bad_request` when the requesting id redeems its own code, `banned`
   * when either side is banned, `link_refused` when both sides already
   * hold state that cannot be merged, and `rate_limit_exceeded`. A
   * refused attempt does not consume the code.
   */
  async redeemLinkCode(
    input: RedeemLinkCodeInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IdentityLinkResult> {
    const wire = await this.http.post<WireIdentityLinked>(
      "/v1/link-codes/redeem",
      { code: input.code, userId: input.userId },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return {
      userId: wire.userId as UserId,
      linkedUserId: wire.linkedUserId as UserId,
      identities: wire.identities.map(deserializeLinkedIdentity),
    };
  }

  /**
   * Splits `userId` out of its person into a fresh, empty person. Roles,
   * memberships, friends, bans, and history stay with the remaining ids;
   * the result's `userId` names the remaining person. Throws `not_found`
   * for an id the game has never seen, `bad_request` when it is the
   * person's only id, and `banned` while any game or group ban is active.
   */
  async unlink(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<IdentityUnlinkResult> {
    const wire = await this.http.post<WireIdentityUnlinked>(
      `/v1/users/${encodeURIComponent(userId)}/unlink`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return {
      userId: wire.userId as UserId,
      unlinkedUserId: wire.unlinkedUserId as UserId,
      identities: wire.identities.map(deserializeLinkedIdentity),
    };
  }
}
