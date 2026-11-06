import type {
  Ban,
  BanHistoryEntry,
  GameId,
  GroupId,
  Page,
  PageOptions,
  UserId,
  UserModeration,
} from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import { type ConditionalWriteOptions, type HttpClient, writeOptions } from "./http.js";
import { paginate } from "./pagination.js";
import { type WireSanction, deserializeSanction } from "./sanctions.js";
import { parseWireDate, toWireDate } from "./wire.js";

interface WireGameBan {
  id: string;
  gameId: string;
  userId: string;
  bannedAt: string;
  expiresAt: string | null;
  reason: string | null;
  bannedBy: string | null;
  issuer: string | null;
  version: number;
}

function deserializeBan(w: WireGameBan): Ban {
  return {
    id: w.id,
    gameId: w.gameId as GameId,
    userId: w.userId as UserId,
    bannedAt: parseWireDate(w.bannedAt, "bannedAt"),
    expiresAt: w.expiresAt === null ? null : parseWireDate(w.expiresAt, "expiresAt"),
    reason: w.reason,
    bannedBy: w.bannedBy === null ? null : (w.bannedBy as UserId),
    issuer: w.issuer,
    version: w.version,
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
  issuer: string | null;
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
    expiresAt: w.expiresAt === null ? null : parseWireDate(w.expiresAt, "expiresAt"),
    eventAt: parseWireDate(w.eventAt, "eventAt"),
    actorUserId: w.actorUserId === null ? null : (w.actorUserId as UserId),
    issuer: w.issuer,
  };
}

/** Input for {@link BansApi.add}. */
export interface CreateBanInput {
  /**
   * External user id of the user to ban. Opaque to Junjo: whatever
   * external id the game's auth provider issues.
   */
  userId: UserId;
  /** Optional human-readable reason; surfaces in audit / dashboard. */
  reason?: string | null;
  /**
   * Optional ISO timestamp / Date for time-bounded bans. Omit / null =
   * permanent. Lazy expiry on read; the server does not auto-clean
   * expired rows.
   */
  expiresAt?: Date | string | null;
  /**
   * Optional moderator attribution. The dev's external user id of the
   * operator pressing the ban button. Auto-creates a JunjoUser if the
   * actor hasn't been seen in this game (mirrors the target user).
   * Surfaces back as `Ban.bannedBy` and on audit / BanHistory rows.
   */
  actorUserId?: UserId;
  /**
   * When the ban started, for a ban carried over from another system.
   * At most 60 seconds in the future. Recorded on the ban and as its
   * history row's `eventAt`; when sent it replaces an active ban's
   * original start. Omit to use the time of the call.
   */
  bannedAt?: Date | string;
  /**
   * Free-text issuer (1 to 128 characters) for a ban not issued by a
   * Junjo user. Stored and returned verbatim as `Ban.issuer`; never
   * resolved to a user. Independent of `actorUserId`.
   */
  issuer?: string;
}

/** Options for {@link BansApi.list}. */
export interface ListBansOptions extends PageOptions {
  /**
   * Default false. When true, also returns rows whose `expiresAt` is in
   * the past (the runtime ban-check ignores those, but operators may
   * want to see them in the dashboard).
   */
  includeExpired?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Options for {@link BansApi.history}. */
export interface ListBanHistoryOptions extends PageOptions {
  /**
   * Filter to one ban surface. Omit for both. Forced to "group" when
   * `groupId` is supplied; supplying both with `scope: "game"` is a
   * 400 error.
   */
  scope?: "game" | "group";
  groupId?: GroupId;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Game-level bans. Per-group bans live on `MembersApi` / `GroupsApi`
 * alongside kick semantics.
 *
 * Game-level ban applies across every group in the game: the user
 * cannot accept invitations or open-join any group while the ban is
 * active. Per-group ban (`groups.ban(...)`) is scoped to one group.
 * The two compose: enforcement on the server checks game-level
 * first, then per-group.
 *
 * `add` and `remove` accept `idempotencyKey`, and `ifMatch` with the
 * person's moderation version (`Ban.version`, or `moderation(userId)`
 * for a person with no active ban).
 */
export class BansApi {
  constructor(private readonly http: HttpClient) {}

  async list(opts?: ListBansOptions): Promise<Page<Ban>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.includeExpired === true) params.set("includeExpired", "true");
    const qs = params.toString();
    const path = qs ? `/v1/bans?${qs}` : "/v1/bans";
    const wire = await this.http.get<{ items: WireGameBan[]; nextCursor: string | null }>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      items: wire.items.map(deserializeBan),
      nextCursor: wire.nextCursor,
    };
  }

  /** Async-iterator wrapper over `list(...)`. See GroupsApi.listAll. */
  listAll(opts?: {
    limit?: number;
    includeExpired?: boolean;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): AsyncGenerator<Ban> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  async add(input: CreateBanInput, opts?: ConditionalWriteOptions): Promise<Ban> {
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
    if (input.bannedAt !== undefined) {
      body.bannedAt = toWireDate(input.bannedAt);
    }
    if (input.issuer !== undefined) body.issuer = input.issuer;
    const wire = await this.http.post<WireGameBan>("/v1/bans", body, writeOptions(opts));
    return deserializeBan(wire);
  }

  /**
   * Lifts the active game ban. With no active ban to lift (including a
   * user the game has never seen) it throws `not_found` with
   * `details.reason === "not_active"`, which `isNotActive(err)`
   * recognises. That answer wins over a stale `ifMatch`.
   */
  async remove(
    userId: UserId,
    opts?: ConditionalWriteOptions & { actorUserId?: UserId },
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/bans/${encodeURIComponent(userId)}`,
      opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined,
      writeOptions(opts),
    );
  }

  /**
   * A person's moderation state in one read (GET
   * /v1/users/:userId/moderation): the moderation version, the active
   * game ban or null, and the active sanctions newest first. A user
   * the game has never seen resolves to version 0 with no ban and no
   * sanctions, so the result is always usable as the `ifMatch` of the
   * next ban or sanction write.
   */
  async moderation(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<UserModeration> {
    const wire = await this.http.get<{
      userId: string;
      version: number;
      ban: WireGameBan | null;
      sanctions?: WireSanction[];
    }>(`/v1/users/${encodeURIComponent(userId)}/moderation`, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      userId: wire.userId as UserId,
      version: wire.version,
      ban: wire.ban === null ? null : deserializeBan(wire.ban),
      // A server predating sanctions omits the field; it then has none.
      sanctions: (wire.sanctions ?? []).map(deserializeSanction),
    };
  }

  /**
   * Fetch the current active game-level ban for a user. Returns null
   * if the user is not banned, the ban has expired, or the user has
   * never been seen in this game.
   */
  async get(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Ban | null> {
    try {
      const wire = await this.http.get<WireGameBan>(`/v1/bans/${encodeURIComponent(userId)}`, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
      });
      return deserializeBan(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  /**
   * Append-only ban-event timeline for a user in this game. Includes
   * both game-scope and group-scope rows by default. Cursor-paginated,
   * newest-first.
   */
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
    }>(path, { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
    return {
      items: wire.items.map(deserializeBanHistoryEntry),
      nextCursor: wire.nextCursor,
    };
  }

  /**
   * Async-iterator wrapper over `history(...)`. Walks every page of
   * ban events for the user until exhausted.
   */
  historyAll(
    userId: UserId,
    opts?: {
      limit?: number;
      scope?: "game" | "group";
      groupId?: GroupId;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): AsyncGenerator<BanHistoryEntry> {
    return paginate((cursor) => this.history(userId, { ...opts, cursor }));
  }
}
