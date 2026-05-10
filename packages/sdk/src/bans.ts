import type {
  Ban,
  BanHistoryEntry,
  GameId,
  GroupId,
  Page,
  PageOptions,
  UserId,
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { paginate } from "./pagination.js";

interface WireGameBan {
  id: string;
  gameId: string;
  userId: string;
  bannedAt: string;
  expiresAt: string | null;
  reason: string | null;
  bannedBy: string | null;
}

function deserializeBan(w: WireGameBan): Ban {
  return {
    id: w.id,
    gameId: w.gameId as GameId,
    userId: w.userId as UserId,
    bannedAt: new Date(w.bannedAt),
    expiresAt: w.expiresAt === null ? null : new Date(w.expiresAt),
    reason: w.reason,
    bannedBy: w.bannedBy === null ? null : (w.bannedBy as UserId),
  };
}

export interface WireBanHistoryEntry {
  id: string;
  gameId: string;
  userId: string;
  scope: "game" | "group";
  groupId: string | null;
  kind: "set" | "lifted";
  reason: string | null;
  expiresAt: string | null;
  eventAt: string;
  actorUserId: string | null;
}

export function deserializeBanHistoryEntry(w: WireBanHistoryEntry): BanHistoryEntry {
  return {
    id: w.id,
    gameId: w.gameId as GameId,
    userId: w.userId as UserId,
    scope: w.scope,
    groupId: w.groupId === null ? null : (w.groupId as GroupId),
    kind: w.kind,
    reason: w.reason,
    expiresAt: w.expiresAt === null ? null : new Date(w.expiresAt),
    eventAt: new Date(w.eventAt),
    actorUserId: w.actorUserId === null ? null : (w.actorUserId as UserId),
  };
}

export interface CreateBanInput {
  // External user id of the user to ban (Clerk sub, Supabase uuid,
  // Roblox UserId-as-string -- whatever the dev's auth provider returns).
  userId: UserId;
  // Optional human-readable reason; surfaces in audit / dashboard.
  reason?: string | null;
  // Optional ISO timestamp / Date for time-bounded bans. Omit / null =
  // permanent. Lazy expiry on read; the server does not auto-clean
  // expired rows.
  expiresAt?: Date | string | null;
  // Optional moderator attribution. The dev's external user id of the
  // operator pressing the ban button. Auto-creates a JunjoUser if the
  // actor hasn't been seen in this game (mirrors the target user).
  // Surfaces back as `Ban.bannedBy` and on audit / BanHistory rows.
  actorUserId?: UserId;
}

export interface ListBansOptions extends PageOptions {
  // Default false. When true, also returns rows whose `expiresAt` is in
  // the past (the runtime ban-check ignores those, but operators may
  // want to see them in the dashboard).
  includeExpired?: boolean;
}

export interface ListBanHistoryOptions extends PageOptions {
  // Filter to one ban surface. Omit for both. Forced to "group" when
  // `groupId` is supplied; supplying both with `scope: "game"` is a
  // 400 error.
  scope?: "game" | "group";
  groupId?: GroupId;
}

// Game-level bans. Per-group bans live on `MembersApi` / `GroupsApi`
// alongside kick semantics.
//
// Game-level ban applies across every group in the game: the user
// cannot accept invitations or open-join any group while the ban is
// active. Per-group ban (`groups.ban(...)`) is scoped to one group.
// The two compose -- enforcement on the server checks game-level
// first, then per-group.
export class BansApi {
  constructor(private readonly http: HttpClient) {}

  async list(opts?: ListBansOptions): Promise<Page<Ban>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.includeExpired === true) params.set("includeExpired", "true");
    const qs = params.toString();
    const path = qs ? `/v1/bans?${qs}` : "/v1/bans";
    const wire = await this.http.get<{ items: WireGameBan[]; nextCursor: string | null }>(path);
    return {
      items: wire.items.map(deserializeBan),
      nextCursor: wire.nextCursor,
    };
  }

  // Async-iterator wrapper over `list(...)`. See GroupsApi.listAll.
  listAll(opts?: { limit?: number; includeExpired?: boolean }): AsyncGenerator<Ban> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  async add(input: CreateBanInput): Promise<Ban> {
    const body: Record<string, unknown> = { userId: input.userId };
    if (input.reason !== undefined) body.reason = input.reason;
    if (input.expiresAt !== undefined) {
      body.expiresAt =
        input.expiresAt === null
          ? null
          : input.expiresAt instanceof Date
            ? input.expiresAt.toISOString()
            : input.expiresAt;
    }
    if (input.actorUserId !== undefined) body.actorUserId = input.actorUserId;
    const wire = await this.http.post<WireGameBan>("/v1/bans", body);
    return deserializeBan(wire);
  }

  async remove(userId: UserId, opts?: { actorUserId?: UserId }): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/bans/${encodeURIComponent(userId)}`,
      opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined,
    );
  }

  // Fetch the current active game-level ban for a user. Returns null
  // if the user is not banned, the ban has expired, or the user has
  // never been seen in this game.
  async get(userId: UserId): Promise<Ban | null> {
    try {
      const wire = await this.http.get<WireGameBan>(`/v1/bans/${encodeURIComponent(userId)}`);
      return deserializeBan(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  // Append-only ban-event timeline for a user in this game. Includes
  // both game-scope and group-scope rows by default. Cursor-paginated,
  // newest-first.
  async history(userId: UserId, opts?: ListBanHistoryOptions): Promise<Page<BanHistoryEntry>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.scope !== undefined) params.set("scope", opts.scope);
    if (opts?.groupId !== undefined) params.set("groupId", opts.groupId);
    const qs = params.toString();
    const path = qs
      ? `/v1/bans/${encodeURIComponent(userId)}/history?${qs}`
      : `/v1/bans/${encodeURIComponent(userId)}/history`;
    const wire = await this.http.get<{
      items: WireBanHistoryEntry[];
      nextCursor: string | null;
    }>(path);
    return {
      items: wire.items.map(deserializeBanHistoryEntry),
      nextCursor: wire.nextCursor,
    };
  }

  // Async-iterator wrapper over `history(...)`. Walks every page of
  // ban events for the user until exhausted.
  historyAll(
    userId: UserId,
    opts?: { limit?: number; scope?: "game" | "group"; groupId?: GroupId },
  ): AsyncGenerator<BanHistoryEntry> {
    return paginate((cursor) => this.history(userId, { ...opts, cursor }));
  }
}
