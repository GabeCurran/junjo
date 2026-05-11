// Client surface for the Friends subsystem (per-game routes only;
// admin /v1/admin/games/:id/config is consumed by the dashboard via
// direct fetch and not exposed here).
//
// Mirrors the server routes in packages/server/src/routes/{friends,
// friendTags,visibility,suggestions}.ts.

import type { FriendsListVisibility, FriendshipRelationship, FriendshipState } from "@junjo/shared";
import type { HttpClient } from "./http.js";

interface WireFriendshipRelationship {
  state: FriendshipState;
  since: string | null;
}

// =====================================================================
// Wire shapes (mirror the server's wire types)
// =====================================================================

export interface FriendRequest {
  id: string;
  gameId: string;
  actorJunjoUserId: string;
  targetJunjoUserId: string;
  createdAt: Date;
}

export interface Friendship {
  id: string;
  gameId: string;
  junjoUserId: string;
  since: Date;
}

export interface FriendRequestSendResult {
  status: "pending" | "auto-accepted";
  request?: FriendRequest;
  friendship?: Friendship;
}

export interface FriendRequestList {
  inbound: FriendRequest[];
  outbound: FriendRequest[];
}

export interface FriendshipPage {
  items: Friendship[];
  nextCursor: string | null;
}

export interface Block {
  id: string;
  gameId: string;
  junjoUserId: string;
  blockedAt: Date;
}

export interface FriendTag {
  id: string;
  gameId: string;
  junjoUserId: string;
  name: string;
  color: string | null;
  createdAt: Date;
}

export interface FriendTagAssignment {
  friendJunjoUserId: string;
  tagIds: string[];
}

export interface UserVisibilitySettings {
  gameId: string;
  junjoUserId: string;
  friendsListVisibility: FriendsListVisibility;
  allowed: FriendsListVisibility[];
  updatedAt: Date | null;
}

export interface FriendSuggestion {
  junjoUserId: string;
  mutualCount: number;
  sampleMutualJunjoUserIds: string[];
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
  id: w.id,
  gameId: w.gameId,
  actorJunjoUserId: w.actorJunjoUserId,
  targetJunjoUserId: w.targetJunjoUserId,
  createdAt: new Date(w.createdAt),
});

const toFriendship = (w: WireFriendship): Friendship => ({
  id: w.id,
  gameId: w.gameId,
  junjoUserId: w.junjoUserId,
  since: new Date(w.since),
});

const toBlock = (w: WireBlock): Block => ({
  id: w.id,
  gameId: w.gameId,
  junjoUserId: w.junjoUserId,
  blockedAt: new Date(w.blockedAt),
});

const toFriendTag = (w: WireFriendTag): FriendTag => ({
  id: w.id,
  gameId: w.gameId,
  junjoUserId: w.junjoUserId,
  name: w.name,
  color: w.color,
  createdAt: new Date(w.createdAt),
});

const toVisibility = (w: WireUserVisibility): UserVisibilitySettings => ({
  gameId: w.gameId,
  junjoUserId: w.junjoUserId,
  friendsListVisibility: w.friendsListVisibility,
  allowed: w.allowed,
  updatedAt: w.updatedAt ? new Date(w.updatedAt) : null,
});

// =====================================================================
// Sub-namespaces
// =====================================================================

class FriendRequestsApi {
  constructor(private readonly http: HttpClient) {}

  async list(
    userId: string,
    opts?: { direction?: "in" | "out" | "both" },
  ): Promise<FriendRequestList> {
    const params = new URLSearchParams();
    if (opts?.direction !== undefined) params.set("direction", opts.direction);
    const qs = params.toString();
    const path = qs
      ? `/v1/users/${encodeURIComponent(userId)}/friend-requests?${qs}`
      : `/v1/users/${encodeURIComponent(userId)}/friend-requests`;
    const wire = await this.http.get<WireFriendRequestList>(path);
    return {
      inbound: wire.inbound.map(toFriendRequest),
      outbound: wire.outbound.map(toFriendRequest),
    };
  }

  async send(userId: string, targetJunjoUserId: string): Promise<FriendRequestSendResult> {
    const wire = await this.http.post<WireFriendRequestSendResult>(
      `/v1/users/${encodeURIComponent(userId)}/friend-requests`,
      { targetJunjoUserId },
    );
    return {
      status: wire.status,
      request: wire.request ? toFriendRequest(wire.request) : undefined,
      friendship: wire.friendship ? toFriendship(wire.friendship) : undefined,
    };
  }

  async accept(requestId: string): Promise<Friendship> {
    const wire = await this.http.post<WireFriendship>(
      `/v1/friend-requests/${encodeURIComponent(requestId)}/accept`,
    );
    return toFriendship(wire);
  }

  async decline(requestId: string): Promise<void> {
    await this.http.post<unknown>(`/v1/friend-requests/${encodeURIComponent(requestId)}/decline`);
  }

  async cancel(requestId: string): Promise<void> {
    await this.http.delete<unknown>(`/v1/friend-requests/${encodeURIComponent(requestId)}`);
  }
}

class BlocksApi {
  constructor(private readonly http: HttpClient) {}

  async list(userId: string): Promise<Block[]> {
    const wire = await this.http.get<{ items: WireBlock[] }>(
      `/v1/users/${encodeURIComponent(userId)}/blocks`,
    );
    return wire.items.map(toBlock);
  }

  async add(userId: string, targetJunjoUserId: string): Promise<Block> {
    const wire = await this.http.post<WireBlock>(`/v1/users/${encodeURIComponent(userId)}/blocks`, {
      targetJunjoUserId,
    });
    return toBlock(wire);
  }

  async remove(userId: string, otherUserId: string): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/users/${encodeURIComponent(userId)}/blocks/${encodeURIComponent(otherUserId)}`,
    );
  }
}

class FriendTagsApi {
  constructor(private readonly http: HttpClient) {}

  async list(userId: string): Promise<FriendTag[]> {
    const wire = await this.http.get<{ items: WireFriendTag[] }>(
      `/v1/users/${encodeURIComponent(userId)}/friend-tags`,
    );
    return wire.items.map(toFriendTag);
  }

  async create(userId: string, input: { name: string; color?: string }): Promise<FriendTag> {
    const wire = await this.http.post<WireFriendTag>(
      `/v1/users/${encodeURIComponent(userId)}/friend-tags`,
      input,
    );
    return toFriendTag(wire);
  }

  async update(tagId: string, patch: { name?: string; color?: string | null }): Promise<FriendTag> {
    const wire = await this.http.patch<WireFriendTag>(
      `/v1/friend-tags/${encodeURIComponent(tagId)}`,
      patch,
    );
    return toFriendTag(wire);
  }

  async delete(tagId: string): Promise<void> {
    await this.http.delete<unknown>(`/v1/friend-tags/${encodeURIComponent(tagId)}`);
  }

  async assign(
    userId: string,
    otherUserId: string,
    tagIds: string[],
  ): Promise<FriendTagAssignment> {
    const wire = await this.http.put<FriendTagAssignment>(
      `/v1/users/${encodeURIComponent(userId)}/friends/${encodeURIComponent(otherUserId)}/tags`,
      { tagIds },
    );
    return wire;
  }
}

class FriendVisibilityApi {
  constructor(private readonly http: HttpClient) {}

  async get(userId: string): Promise<UserVisibilitySettings> {
    const wire = await this.http.get<WireUserVisibility>(
      `/v1/users/${encodeURIComponent(userId)}/visibility`,
    );
    return toVisibility(wire);
  }

  async set(userId: string, value: FriendsListVisibility): Promise<UserVisibilitySettings> {
    const wire = await this.http.patch<WireUserVisibility>(
      `/v1/users/${encodeURIComponent(userId)}/visibility`,
      { friendsListVisibility: value },
    );
    return toVisibility(wire);
  }
}

// =====================================================================
// Top-level FriendsApi
// =====================================================================

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

  async list(
    userId: string,
    opts?: { limit?: number; cursor?: string; tagId?: string; viewer?: string },
  ): Promise<FriendshipPage> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.tagId !== undefined) params.set("tagId", opts.tagId);
    if (opts?.viewer !== undefined) params.set("viewer", opts.viewer);
    const qs = params.toString();
    const base = `/v1/users/${encodeURIComponent(userId)}/friends`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<WireFriendshipPage>(path);
    return {
      items: wire.items.map(toFriendship),
      nextCursor: wire.nextCursor,
    };
  }

  async remove(userId: string, otherUserId: string): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/users/${encodeURIComponent(userId)}/friends/${encodeURIComponent(otherUserId)}`,
    );
  }

  // Single-pair viewer-perspective relationship probe. Use on a profile
  // view to render a FriendButton in one round-trip instead of paging
  // through list(). Returns "none" when no relationship exists.
  // Priority order baked into the resolver: blocks (viewer-side wins
  // on both-blocked edge), friendship, pending request, none.
  async getRelationship(
    viewerUserId: string,
    otherUserId: string,
  ): Promise<FriendshipRelationship> {
    const wire = await this.http.get<WireFriendshipRelationship>(
      `/v1/users/${encodeURIComponent(viewerUserId)}/friends/${encodeURIComponent(
        otherUserId,
      )}/relationship`,
    );
    return {
      state: wire.state,
      since: wire.since === null ? undefined : new Date(wire.since),
    };
  }

  async suggestions(userId: string, opts?: { limit?: number }): Promise<FriendSuggestion[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const base = `/v1/users/${encodeURIComponent(userId)}/friends/suggestions`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{ items: FriendSuggestion[] }>(path);
    return wire.items;
  }
}
