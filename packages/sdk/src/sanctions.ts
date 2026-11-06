import type {
  GameId,
  Page,
  PageOptions,
  Sanction,
  SanctionHistoryEntry,
  UserId,
} from "@junjo.io/shared";
import { type ConditionalWriteOptions, type HttpClient, writeOptions } from "./http.js";
import { paginate } from "./pagination.js";
import { parseWireDate, toWireDate } from "./wire.js";

export interface WireSanction {
  id: string;
  userId: string;
  type: string;
  reason: string | null;
  issuer: string | null;
  issuedBy: string | null;
  startedAt: string;
  expiresAt: string | null;
  version: number;
}

export function deserializeSanction(w: WireSanction): Sanction {
  return {
    id: w.id,
    userId: w.userId as UserId,
    type: w.type,
    reason: w.reason,
    issuer: w.issuer,
    issuedBy: w.issuedBy === null ? null : (w.issuedBy as UserId),
    startedAt: parseWireDate(w.startedAt, "startedAt"),
    expiresAt: w.expiresAt === null ? null : parseWireDate(w.expiresAt, "expiresAt"),
    version: w.version,
  };
}

interface WireSanctionHistoryEntry {
  id: string;
  gameId: string;
  userId: string;
  type: string;
  kind: "set" | "lifted";
  reason: string | null;
  expiresAt: string | null;
  eventAt: string;
  actorUserId: string | null;
  issuer: string | null;
}

function deserializeSanctionHistoryEntry(w: WireSanctionHistoryEntry): SanctionHistoryEntry {
  return {
    id: w.id,
    gameId: w.gameId as GameId,
    userId: w.userId as UserId,
    type: w.type,
    kind: w.kind,
    reason: w.reason,
    expiresAt: w.expiresAt === null ? null : parseWireDate(w.expiresAt, "expiresAt"),
    eventAt: parseWireDate(w.eventAt, "eventAt"),
    actorUserId: w.actorUserId === null ? null : (w.actorUserId as UserId),
    issuer: w.issuer,
  };
}

/** Input for {@link SanctionsApi.add}. */
export interface AddSanctionInput {
  /**
   * The game-defined type: 1 to 32 characters matching
   * `^[a-z0-9][a-z0-9_.-]{0,31}$`. `ban` is reserved and refused.
   */
  type: string;
  /** Up to 500 characters, or null. */
  reason?: string | null;
  /** Omit or null for a permanent sanction. A past value creates one already expired. */
  expiresAt?: Date | string | null;
  /** May lie in the past; at most 60 seconds ahead of the server. Omit to use now. */
  startedAt?: Date | string;
  /** Free text (1 to 128 characters) recorded verbatim; never resolved to a user. */
  issuer?: string;
  /** The person who issued it; surfaces as `Sanction.issuedBy`. */
  actorUserId?: UserId;
}

/** Options for {@link SanctionsApi.list} and {@link SanctionsApi.history}. */
export interface ListSanctionsOptions extends PageOptions {
  /** Only sanctions of this type. */
  type?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function pageQuery(opts?: ListSanctionsOptions): string {
  const params = new URLSearchParams();
  if (opts?.type !== undefined) params.set("type", opts.type);
  if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * Game-wide sanctions of game-defined types. A person holds at most one
 * active sanction per type; it stays active until lifted or until
 * `expiresAt` passes (lazy expiry, no event at expiry).
 *
 * `add` and `remove` accept `idempotencyKey`, and `ifMatch` with the
 * person's moderation version, which bans and sanctions share
 * (`Sanction.version`, or `bans.moderation(userId).version`).
 */
export class SanctionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Creates the person's sanction of `input.type`, or replaces the
   * active one. An identical repeat changes nothing and bumps no
   * version. Throws `bad_request` for a malformed or reserved type and
   * `precondition_failed` on a stale `ifMatch`.
   */
  async add(
    userId: UserId,
    input: AddSanctionInput,
    opts?: ConditionalWriteOptions,
  ): Promise<Sanction> {
    const body: Record<string, unknown> = { userId, type: input.type };
    if (input.reason !== undefined) body.reason = input.reason;
    if (input.expiresAt !== undefined) {
      body.expiresAt = input.expiresAt === null ? null : toWireDate(input.expiresAt);
    }
    if (input.startedAt !== undefined) body.startedAt = toWireDate(input.startedAt);
    if (input.issuer !== undefined) body.issuer = input.issuer;
    if (input.actorUserId !== undefined) body.actorUserId = input.actorUserId;
    const wire = await this.http.post<WireSanction>("/v1/sanctions", body, writeOptions(opts));
    return deserializeSanction(wire);
  }

  /**
   * Lifts the person's active sanction of `type`. With none active
   * (including an expired one or an unknown user) it throws `not_found`
   * with `details.reason === "not_active"`, which `isNotActive(err)`
   * recognises; that answer wins over a stale `ifMatch`.
   */
  async remove(
    userId: UserId,
    type: string,
    opts?: ConditionalWriteOptions & { actorUserId?: UserId },
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/sanctions/${encodeURIComponent(userId)}/${encodeURIComponent(type)}`,
      opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined,
      writeOptions(opts),
    );
  }

  /** Active sanctions in the game, newest `startedAt` first. */
  async list(opts?: ListSanctionsOptions): Promise<Page<Sanction>> {
    const wire = await this.http.get<{ items: WireSanction[]; nextCursor: string | null }>(
      `/v1/sanctions${pageQuery(opts)}`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return { items: wire.items.map(deserializeSanction), nextCursor: wire.nextCursor };
  }

  /** Async-iterator wrapper over `list(...)`, walking every page. */
  listAll(opts?: Omit<ListSanctionsOptions, "cursor">): AsyncGenerator<Sanction> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  /**
   * The person's active sanctions, newest first. A user the game has
   * never seen yields an empty list.
   */
  async forUser(
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Sanction[]> {
    const wire = await this.http.get<{ items: WireSanction[] }>(
      `/v1/users/${encodeURIComponent(userId)}/sanctions`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.items.map(deserializeSanction);
  }

  /**
   * Every set and lift for the person, newest first. Lazy expiry writes
   * no entry.
   */
  async history(userId: UserId, opts?: ListSanctionsOptions): Promise<Page<SanctionHistoryEntry>> {
    const wire = await this.http.get<{
      items: WireSanctionHistoryEntry[];
      nextCursor: string | null;
    }>(`/v1/users/${encodeURIComponent(userId)}/sanctions/history${pageQuery(opts)}`, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      items: wire.items.map(deserializeSanctionHistoryEntry),
      nextCursor: wire.nextCursor,
    };
  }

  /** Async-iterator wrapper over `history(...)`, walking every page. */
  historyAll(
    userId: UserId,
    opts?: Omit<ListSanctionsOptions, "cursor">,
  ): AsyncGenerator<SanctionHistoryEntry> {
    return paginate((cursor) => this.history(userId, { ...opts, cursor }));
  }
}
