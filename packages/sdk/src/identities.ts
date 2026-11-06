import type {
  DisplayNameMatch,
  IdentityLinkResult,
  IdentityUnlinkResult,
  LinkCode,
  LinkedIdentity,
  UserId,
} from "@junjo.io/shared";
import { type HttpClient, type WriteOptions, writeOptions } from "./http.js";
import { parseWireDate } from "./wire.js";

interface WireLinkedIdentity {
  userId: string;
  namespace: string | null;
  linkedAt: string;
  displayName?: string | null;
}

interface WireDisplayNameMatch {
  userId: string;
  displayName: string;
  displayNameUpdatedAt: string;
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
    displayName: w.displayName ?? null,
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
   * Sets the display name (1 to 64 characters) of exactly `userId`, or
   * clears it with null; the person's other ids keep theirs. An id the
   * game has never seen becomes a new person first. Returns the id as
   * an identity list item. An unchanged name writes nothing and emits
   * no event; a change emits `identity.updated`. Throws `bad_request`
   * for an empty or over-long name.
   */
  async setDisplayName(
    userId: UserId,
    displayName: string | null,
    opts?: WriteOptions,
  ): Promise<LinkedIdentity> {
    const wire = await this.http.put<WireLinkedIdentity>(
      `/v1/users/${encodeURIComponent(userId)}/display-name`,
      { displayName },
      writeOptions(opts),
    );
    return deserializeLinkedIdentity(wire);
  }

  /**
   * Ids whose display name equals `name` ignoring case, most recently
   * named first, at most 20. Each `userId` is the matching id itself,
   * never swapped for another id of its person. `namespace` restricts
   * the match to ids in that namespace.
   */
  async findByName(
    name: string,
    opts?: { namespace?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DisplayNameMatch[]> {
    const params = new URLSearchParams({ name });
    if (opts?.namespace !== undefined) params.set("namespace", opts.namespace);
    const wire = await this.http.get<{ items: WireDisplayNameMatch[] }>(
      `/v1/identities/by-name?${params.toString()}`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.items.map((w) => ({
      userId: w.userId as UserId,
      displayName: w.displayName,
      displayNameUpdatedAt: parseWireDate(w.displayNameUpdatedAt, "displayNameUpdatedAt"),
    }));
  }

  /**
   * Issues a single-use link code for `userId`, creating the person if
   * the id is new. A new code cancels the id's earlier codes. Throws
   * `banned` for a banned id and `rate_limit_exceeded` (with
   * `retryAfterSeconds`) when the id requests codes too quickly.
   */
  async requestLinkCode(userId: UserId, opts?: WriteOptions): Promise<LinkCode> {
    const wire = await this.http.post<WireLinkCode>(
      `/v1/users/${encodeURIComponent(userId)}/link-codes`,
      undefined,
      writeOptions(opts),
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
    opts?: WriteOptions,
  ): Promise<IdentityLinkResult> {
    const wire = await this.http.post<WireIdentityLinked>(
      "/v1/link-codes/redeem",
      { code: input.code, userId: input.userId },
      writeOptions(opts),
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
  async unlink(userId: UserId, opts?: WriteOptions): Promise<IdentityUnlinkResult> {
    const wire = await this.http.post<WireIdentityUnlinked>(
      `/v1/users/${encodeURIComponent(userId)}/unlink`,
      undefined,
      writeOptions(opts),
    );
    return {
      userId: wire.userId as UserId,
      unlinkedUserId: wire.unlinkedUserId as UserId,
      identities: wire.identities.map(deserializeLinkedIdentity),
    };
  }
}
