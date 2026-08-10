// Client surface for the Friends subsystem (per-game routes only;
// admin /v1/admin/games/:id/config is consumed by the dashboard via
// direct fetch and not exposed here).
//
// Mirrors the server routes in packages/server/src/routes/{friends,
// friendTags,visibility,suggestions}.ts.

import type {
  Block,
  FriendRequest,
  FriendRequestList,
  FriendRequestSendResult,
  FriendSuggestion,
  FriendTag,
  FriendTagAssignment,
  FriendTagId,
  FriendsListVisibility,
  Friendship,
  FriendshipRelationship,
  FriendshipState,
  GameId,
  Page,
  UserId,
  UserRelationshipId,
  UserVisibilitySettings,
} from "@junjo.io/shared";
import type { HttpClient } from "./http.js";
import { paginate } from "./pagination.js";
import { parseWireDate } from "./wire.js";

// The domain shapes live in @junjo.io/shared (the canonical contract
// package shared by every Junjo SDK); re-exported here so consumers can
// keep importing them from the SDK entrypoint.
export type {
  Block,
  FriendRequest,
  FriendRequestList,
  FriendRequestSendResult,
  FriendSuggestion,
  FriendTag,
  FriendTagAssignment,
  Friendship,
  UserVisibilitySettings,
};

/** One cursor-paginated page of friendships. */
export type FriendshipPage = Page<Friendship>;

interface WireFriendshipRelationship {
  state: FriendshipState;
  since: string | null;
}

// =====================================================================
// Wire (over-the-wire) shapes; dates as ISO strings
// =====================================================================

interface WireFriendRequest {
  id: string;
  gameId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
  createdAt: string;
}
interface WireFriendship {
  id: string;
  gameId: string;
  junjoUserId: string;
  since: string;
}
interface WireFriendRequestSendResult {
  status: "pending" | "auto-accepted";
  request?: WireFriendRequest;
  friendship?: WireFriendship;
}
interface WireFriendRequestList {
  inbound: WireFriendRequest[];
  outbound: WireFriendRequest[];
}
interface WireFriendshipPage {
  items: WireFriendship[];
  nextCursor: string | null;
}
interface WireBlock {
  id: string;
  gameId: string;
  junjoUserId: string;
  blockedAt: string;
}
interface WireFriendTag {
  id: string;
  gameId: string;
  junjoUserId: string;
  name: string;
  color: string | null;
  createdAt: string;
}
interface WireUserVisibility {
  gameId: string;
  junjoUserId: string;
  friendsListVisibility: FriendsListVisibility;
  allowed: FriendsListVisibility[];
  updatedAt: string | null;
}

// =====================================================================
// Deserializers
// =====================================================================

const toFriendRequest = (w: WireFriendRequest): FriendRequest => ({
  id: w.id as UserRelationshipId,
  gameId: w.gameId as GameId,
  actorJunjoUserId: w.actorJunjoUserId as UserId,
  targetJunjoUserId: w.targetJunjoUserId as UserId,
  createdAt: parseWireDate(w.createdAt, "createdAt"),
});

const toFriendship = (w: WireFriendship): Friendship => ({
  id: w.id as UserRelationshipId,
  gameId: w.gameId as GameId,
  junjoUserId: w.junjoUserId as UserId,
  since: parseWireDate(w.since, "since"),
});

const toBlock = (w: WireBlock): Block => ({
  id: w.id as UserRelationshipId,
  gameId: w.gameId as GameId,
  junjoUserId: w.junjoUserId as UserId,
  blockedAt: parseWireDate(w.blockedAt, "blockedAt"),
});

const toFriendTag = (w: WireFriendTag): FriendTag => ({
  id: w.id as FriendTagId,
  gameId: w.gameId as GameId,
  junjoUserId: w.junjoUserId as UserId,
  name: w.name,
  color: w.color,
  createdAt: parseWireDate(w.createdAt, "createdAt"),
});

const toVisibility = (w: WireUserVisibility): UserVisibilitySettings => ({
  gameId: w.gameId as GameId,
  junjoUserId: w.junjoUserId as UserId,
  friendsListVisibility: w.friendsListVisibility,
  allowed: w.allowed,
  updatedAt: w.updatedAt ? parseWireDate(w.updatedAt, "updatedAt") : null,
});

// =====================================================================
// Sub-namespaces
// =====================================================================

/** Friend requests: list, send, accept, decline, cancel. */
class FriendRequestsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Lists a user's pending friend requests, inbound and outbound.
   * `direction` filters to one side; the omitted side comes back empty.
   */
  async list(
    userId: UserId,
    opts?: { direction?: "in" | "out" | "both"; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendRequestList> {
    const params = new URLSearchParams();
    if (opts?.direction !== undefined) params.set("direction", opts.direction);
    const qs = params.toString();
    const path = qs
      ? `/v1/users/${encodeURIComponent(userId)}/friend-requests?${qs}`
      : `/v1/users/${encodeURIComponent(userId)}/friend-requests`;
    const wire = await this.http.get<WireFriendRequestList>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      inbound: wire.inbound.map(toFriendRequest),
      outbound: wire.outbound.map(toFriendRequest),
    };
  }

  /**
   * Sends a friend request. The result's `status` is "pending" (with
   * the created request) or "auto-accepted" (with the new friendship,
   * e.g. when the target had already requested the sender).
   */
  async send(
    userId: UserId,
    targetJunjoUserId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendRequestSendResult> {
    const wire = await this.http.post<WireFriendRequestSendResult>(
      `/v1/users/${encodeURIComponent(userId)}/friend-requests`,
      { targetJunjoUserId },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return {
      status: wire.status,
      request: wire.request ? toFriendRequest(wire.request) : undefined,
      friendship: wire.friendship ? toFriendship(wire.friendship) : undefined,
    };
  }

  /** Accepts an inbound request and returns the resulting friendship. */
  async accept(
    requestId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Friendship> {
    const wire = await this.http.post<WireFriendship>(
      `/v1/friend-requests/${encodeURIComponent(requestId)}/accept`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return toFriendship(wire);
  }

  /** Declines an inbound request. */
  async decline(
    requestId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.http.post<unknown>(
      `/v1/friend-requests/${encodeURIComponent(requestId)}/decline`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
  }

  /** Cancels an outbound request the actor sent. */
  async cancel(
    requestId: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/friend-requests/${encodeURIComponent(requestId)}`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
  }
}

/** User-to-user blocks. */
class BlocksApi {
  constructor(private readonly http: HttpClient) {}

  /** Lists everyone the user has blocked. */
  async list(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Block[]> {
    const wire = await this.http.get<{ items: WireBlock[] }>(
      `/v1/users/${encodeURIComponent(userId)}/blocks`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.items.map(toBlock);
  }

  /** Blocks another user. */
  async add(
    userId: UserId,
    targetJunjoUserId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Block> {
    const wire = await this.http.post<WireBlock>(
      `/v1/users/${encodeURIComponent(userId)}/blocks`,
      { targetJunjoUserId },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return toBlock(wire);
  }

  /** Unblocks a previously blocked user. */
  async remove(
    userId: UserId,
    otherUserId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/users/${encodeURIComponent(userId)}/blocks/${encodeURIComponent(otherUserId)}`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
  }
}

/** Per-user friend tags (labels a user pins on their friends). */
class FriendTagsApi {
  constructor(private readonly http: HttpClient) {}

  /** Lists the user's tags. */
  async list(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendTag[]> {
    const wire = await this.http.get<{ items: WireFriendTag[] }>(
      `/v1/users/${encodeURIComponent(userId)}/friend-tags`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.items.map(toFriendTag);
  }

  /** Creates a tag. */
  async create(
    userId: UserId,
    input: { name: string; color?: string },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendTag> {
    const wire = await this.http.post<WireFriendTag>(
      `/v1/users/${encodeURIComponent(userId)}/friend-tags`,
      input,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return toFriendTag(wire);
  }

  /** Renames or recolors a tag; `color: null` clears the color. */
  async update(
    tagId: string,
    patch: { name?: string; color?: string | null },
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendTag> {
    const wire = await this.http.patch<WireFriendTag>(
      `/v1/friend-tags/${encodeURIComponent(tagId)}`,
      patch,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return toFriendTag(wire);
  }

  /** Deletes a tag. */
  async delete(tagId: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<void> {
    await this.http.delete<unknown>(`/v1/friend-tags/${encodeURIComponent(tagId)}`, undefined, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }

  /** Replaces the full set of tags on one friend (PUT semantics). */
  async assign(
    userId: UserId,
    otherUserId: UserId,
    tagIds: string[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendTagAssignment> {
    const wire = await this.http.put<FriendTagAssignment>(
      `/v1/users/${encodeURIComponent(userId)}/friends/${encodeURIComponent(otherUserId)}/tags`,
      { tagIds },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire;
  }
}

/** Per-user friends-list visibility settings. */
class FriendVisibilityApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Fetches the user's visibility settings. `updatedAt` is null until
   * the user first overrides the game default.
   */
  async get(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<UserVisibilitySettings> {
    const wire = await this.http.get<WireUserVisibility>(
      `/v1/users/${encodeURIComponent(userId)}/visibility`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return toVisibility(wire);
  }

  /** Sets the user's friends-list visibility (must be in the game's allowlist). */
  async set(
    userId: UserId,
    value: FriendsListVisibility,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<UserVisibilitySettings> {
    const wire = await this.http.patch<WireUserVisibility>(
      `/v1/users/${encodeURIComponent(userId)}/visibility`,
      { friendsListVisibility: value },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return toVisibility(wire);
  }
}

// =====================================================================
// Top-level FriendsApi
// =====================================================================

/**
 * The Friends subsystem: friendships plus the `requests`, `blocks`,
 * `tags`, and `visibility` sub-namespaces. Per-game routes only; the
 * admin config surface is not exposed here.
 */
export class FriendsApi {
  readonly requests: FriendRequestsApi;
  readonly blocks: BlocksApi;
  readonly tags: FriendTagsApi;
  readonly visibility: FriendVisibilityApi;

  constructor(private readonly http: HttpClient) {
    this.requests = new FriendRequestsApi(http);
    this.blocks = new BlocksApi(http);
    this.tags = new FriendTagsApi(http);
    this.visibility = new FriendVisibilityApi(http);
  }

  /**
   * Cursor-paginated friends list. `tagId` filters to one tag; `viewer`
   * applies the owner's visibility settings from that user's
   * perspective.
   */
  async list(
    userId: UserId,
    opts?: {
      limit?: number;
      cursor?: string;
      tagId?: string;
      viewer?: UserId;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<FriendshipPage> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.tagId !== undefined) params.set("tagId", opts.tagId);
    if (opts?.viewer !== undefined) params.set("viewer", opts.viewer);
    const qs = params.toString();
    const base = `/v1/users/${encodeURIComponent(userId)}/friends`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<WireFriendshipPage>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      items: wire.items.map(toFriendship),
      nextCursor: wire.nextCursor,
    };
  }

  /**
   * Async-iterator wrapper over `list(...)` that walks every page until
   * `nextCursor` is null. `tagId` and `viewer` filter exactly as on
   * `list`. Use for full exports; prefer `list(...)` with explicit
   * pagination for UI surfaces.
   */
  listAll(
    userId: UserId,
    opts?: {
      limit?: number;
      tagId?: string;
      viewer?: UserId;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): AsyncGenerator<Friendship> {
    return paginate((cursor) => this.list(userId, { ...opts, cursor }));
  }

  /** Ends a friendship (both sides; unfriending is symmetric). */
  async remove(
    userId: UserId,
    otherUserId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/users/${encodeURIComponent(userId)}/friends/${encodeURIComponent(otherUserId)}`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
  }

  /**
   * Single-pair viewer-perspective relationship probe. Use on a profile
   * view to render a FriendButton in one round-trip instead of paging
   * through list(). Returns "none" when no relationship exists.
   * Priority order baked into the resolver: blocks (viewer-side wins
   * on both-blocked edge), friendship, pending request, none.
   */
  async getRelationship(
    viewerUserId: UserId,
    otherUserId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendshipRelationship> {
    const wire = await this.http.get<WireFriendshipRelationship>(
      `/v1/users/${encodeURIComponent(viewerUserId)}/friends/${encodeURIComponent(
        otherUserId,
      )}/relationship`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return {
      state: wire.state,
      since: wire.since === null ? undefined : parseWireDate(wire.since, "since"),
    };
  }

  /** Friend suggestions for the user; each carries its mutual-friend count. */
  async suggestions(
    userId: UserId,
    opts?: { limit?: number; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<FriendSuggestion[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const base = `/v1/users/${encodeURIComponent(userId)}/friends/suggestions`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{ items: FriendSuggestion[] }>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return wire.items;
  }
}
