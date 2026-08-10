import type {
  BanHistoryEntry,
  CreateGroupInput,
  CreateInvitationInput,
  GameId,
  Group,
  GroupId,
  GroupRelationship,
  GroupRelationshipType,
  GroupVisibility,
  Invitation,
  InvitationId,
  JunjoEvent,
  Member,
  Page,
  PageOptions,
  RoleId,
  UpdateGroupInput,
  UserId,
} from "@junjo.io/shared";
import { type WireBanHistoryEntry, deserializeBanHistoryEntry } from "./bans.js";
import { JunjoError } from "./errors.js";
import {
  UNKNOWN_EVENT_TYPE,
  type WireJunjoEvent,
  deserializeEvent,
  parseSSEFrame,
} from "./events.js";
import type { HttpClient } from "./http.js";
import { type WireMember, deserializeMember } from "./members.js";
import { paginate } from "./pagination.js";
import { parseWireDate } from "./wire.js";

// Cap on an unterminated SSE frame (in UTF-16 code units, roughly 1 MiB
// of ASCII). Real Junjo events are a few KB; anything near this is a
// broken or hostile stream.
const MAX_SSE_BUFFER_CHARS = 1024 * 1024;

// Blank line ending a frame: \n\n from the server, or \r\n\r\n (and
// mixes) after a proxy normalizes line endings.
const SSE_FRAME_DELIMITER = /\r?\n\r?\n/;

/** Options for {@link GroupsApi.subscribe}. */
export interface SubscribeOptions {
  /**
   * Notified when a streaming error occurs after the connection is open
   * (network drop, malformed frame, JSON parse failure). The subscription
   * is closed before this fires; reconnect by calling `subscribe` again.
   */
  onError?: (err: Error) => void;
  /**
   * Notified when the SERVER ends the stream cleanly (a deploy, a proxy
   * idle timeout). The subscription is closed before this fires; events
   * that occur before you resubscribe are lost. Not invoked when you
   * end the stream yourself via `close()` or by aborting `signal`.
   */
  onClose?: () => void;
  /**
   * Aborting closes the subscription (equivalent to calling `close()`);
   * aborting before the connection is established rejects `subscribe`
   * with JunjoError code "cancelled". There is no `timeoutMs` here on
   * purpose: an event stream stays open by design.
   */
  signal?: AbortSignal;
}

/** Handle for an open event stream; `close()` ends it. */
export interface Subscription {
  close: () => void;
}

export interface WireGroupRelationship {
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setBy: string | null;
}

export function deserializeGroupRelationship(w: WireGroupRelationship): GroupRelationship {
  return {
    groupAId: w.groupAId as GroupId,
    groupBId: w.groupBId as GroupId,
    type: w.type,
    since: parseWireDate(w.since, "since"),
    setBy: w.setBy === null ? null : (w.setBy as UserId),
  };
}

export interface WireInvitation {
  id: string;
  groupId: string;
  code: string;
  roleId: string | null;
  targetUserId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedBy: string | null;
}

export function deserializeInvitation(w: WireInvitation): Invitation {
  return {
    id: w.id as InvitationId,
    groupId: w.groupId as GroupId,
    code: w.code,
    roleId: w.roleId === null ? null : (w.roleId as RoleId),
    targetUserId: w.targetUserId === null ? null : (w.targetUserId as UserId),
    createdBy: w.createdBy === null ? null : (w.createdBy as UserId),
    createdAt: parseWireDate(w.createdAt, "createdAt"),
    expiresAt: w.expiresAt === null ? null : parseWireDate(w.expiresAt, "expiresAt"),
    usedAt: w.usedAt === null ? null : parseWireDate(w.usedAt, "usedAt"),
    usedBy: w.usedBy === null ? null : (w.usedBy as UserId),
  };
}

export interface WireGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: GroupVisibility;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  hasPasscode: boolean;
  createdAt: string;
  updatedAt: string;
  softDeletedAt: string | null;
}

export function deserializeGroup(w: WireGroup): Group {
  return {
    id: w.id as GroupId,
    gameId: w.gameId as GameId,
    kind: w.kind,
    name: w.name,
    visibility: w.visibility,
    metadata: w.metadata,
    defaultRoleId: w.defaultRoleId === null ? null : (w.defaultRoleId as RoleId),
    parentGroupId: w.parentGroupId === null ? null : (w.parentGroupId as GroupId),
    memberCount: w.memberCount,
    hasPasscode: w.hasPasscode,
    createdAt: parseWireDate(w.createdAt, "createdAt"),
    updatedAt: parseWireDate(w.updatedAt, "updatedAt"),
    softDeletedAt:
      w.softDeletedAt === null ? null : parseWireDate(w.softDeletedAt, "softDeletedAt"),
  };
}

// Drops `targetUserId`: the open-code path is by definition not addressed
// to a specific user, so silently passing one in via the shared
// `CreateInvitationInput` shape would be a programmer error masquerading
// as a feature.
function buildOpenInviteBody(input?: CreateInvitationInput): Record<string, string> {
  const body: Record<string, string> = {};
  if (input?.roleId !== undefined) body.roleId = input.roleId;
  if (input?.expiresIn !== undefined) body.expiresIn = input.expiresIn;
  return body;
}

/**
 * Groups: CRUD, membership (invitations, join/leave, kick, per-group
 * bans), real-time event subscriptions, group relationships, and
 * sub-group hierarchy.
 */
export class GroupsApi {
  constructor(
    private readonly http: HttpClient,
    // Undefined when the developer never configured `inviteBaseUrl`;
    // `inviteByLink` refuses to mint a URL in that case.
    private readonly inviteBaseUrl: string | undefined,
  ) {}

  /**
   * Pass `creatorUserId` to atomically add the creator as an active
   * member in the same transaction as the group insert, with a
   * `member.joined` audit entry tagged `via: "creator"` and a
   * `member.joined` webhook event. Useful for non-public groups where
   * the creator can't reach themselves through `groups.join` (which
   * requires `visibility = "public"`). When `defaultRoleId` is set and
   * a matching Role already exists in the new group, the role is
   * assigned to the creator in the same transaction.
   */
  async create(
    input: CreateGroupInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Group> {
    const wire = await this.http.post<WireGroup>("/v1/groups", input, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return deserializeGroup(wire);
  }

  /**
   * Pass `viewer` (an external userId) to scope visibility to that user;
   * secret groups they aren't a member of will return null. Without it
   * the server treats the call as admin/server-side and returns the group
   * regardless of visibility.
   */
  async get(
    id: GroupId,
    opts?: { viewer?: UserId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Group | null> {
    try {
      const params = new URLSearchParams();
      if (opts?.viewer !== undefined) params.set("viewer", opts.viewer);
      const qs = params.toString();
      const path = qs
        ? `/v1/groups/${encodeURIComponent(id)}?${qs}`
        : `/v1/groups/${encodeURIComponent(id)}`;
      const wire = await this.http.get<WireGroup>(path, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
      });
      return deserializeGroup(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async list(
    opts?: PageOptions & {
      gameId?: GameId;
      viewer?: UserId;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<Page<Group>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.gameId !== undefined) params.set("gameId", opts.gameId);
    if (opts?.viewer !== undefined) params.set("viewer", opts.viewer);
    const qs = params.toString();
    const path = qs ? `/v1/groups?${qs}` : "/v1/groups";
    const wire = await this.http.get<{ items: WireGroup[]; nextCursor: string | null }>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      items: wire.items.map(deserializeGroup),
      nextCursor: wire.nextCursor,
    };
  }

  /**
   * Async-iterator wrapper over `list(...)` that walks every page until
   * `nextCursor` is null. Use when you genuinely need every group --
   * prefer `list(...)` with explicit pagination for UI surfaces. The
   * underlying server still caps `limit` at JUNJO_MAX_PAGE_SIZE.
   */
  listAll(opts?: {
    limit?: number;
    gameId?: GameId;
    viewer?: UserId;
    signal?: AbortSignal;
    timeoutMs?: number;
  }): AsyncGenerator<Group> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  async update(
    id: GroupId,
    input: UpdateGroupInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Group> {
    const wire = await this.http.patch<WireGroup>(`/v1/groups/${encodeURIComponent(id)}`, input, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return deserializeGroup(wire);
  }

  /** Soft delete with a 7-day undo window; `hard: true` bypasses it. */
  async delete(
    id: GroupId,
    opts?: { hard?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    const path = opts?.hard
      ? `/v1/groups/${encodeURIComponent(id)}?hard=true`
      : `/v1/groups/${encodeURIComponent(id)}`;
    await this.http.delete<unknown>(path, undefined, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }

  async restore(id: GroupId, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<Group> {
    const wire = await this.http.post<WireGroup>(
      `/v1/groups/${encodeURIComponent(id)}/restore`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeGroup(wire);
  }

  // ------ Membership ------

  async inviteByUserId(
    groupId: GroupId,
    userId: UserId,
    opts?: { roleId?: RoleId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Invitation> {
    const body: { targetUserId: string; roleId?: string } = { targetUserId: userId };
    if (opts?.roleId !== undefined) body.roleId = opts.roleId;
    const wire = await this.http.post<WireInvitation>(
      `/v1/groups/${encodeURIComponent(groupId)}/invitations`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeInvitation(wire);
  }

  async inviteByCode(
    groupId: GroupId,
    input?: CreateInvitationInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Invitation> {
    const wire = await this.http.post<WireInvitation>(
      `/v1/groups/${encodeURIComponent(groupId)}/invitations`,
      buildOpenInviteBody(input),
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeInvitation(wire);
  }

  async inviteByLink(
    groupId: GroupId,
    input?: CreateInvitationInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ invitation: Invitation; url: string }> {
    // Refuse to mint a link nobody can open: without a configured
    // inviteBaseUrl the only candidate would be the API origin, where
    // /invite/CODE is a 404. Fail before creating the invitation so a
    // misconfigured client leaves nothing behind.
    if (this.inviteBaseUrl === undefined) {
      throw new JunjoError(
        "inviteByLink requires `inviteBaseUrl`: set it in `new Junjo({ inviteBaseUrl })` to your frontend origin (the site that renders /invite/:code). Use inviteByCode if you only need the code.",
        "invalid_config",
      );
    }
    const invitation = await this.inviteByCode(groupId, input, opts);
    const url = `${this.inviteBaseUrl}/invite/${encodeURIComponent(invitation.code)}`;
    return { invitation, url };
  }

  /**
   * Streams a CSV of user ids to the server, which mints one invitation
   * per row. Large uploads can legitimately outlive the default 30s
   * request timeout; pass a higher `timeoutMs` (or 0 to disable) when
   * feeding big files.
   */
  async bulkInvite(
    groupId: GroupId,
    csv: string | ReadableStream<Uint8Array>,
    opts?: { roleId?: RoleId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<{ invited: number; skipped: number; errors: Array<{ row: number; reason: string }> }> {
    const params = new URLSearchParams();
    if (opts?.roleId !== undefined) params.set("roleId", opts.roleId);
    const qs = params.toString();
    const path = `/v1/groups/${encodeURIComponent(groupId)}/bulk-invite${qs ? `?${qs}` : ""}`;
    return this.http.postRaw<{
      invited: number;
      skipped: number;
      errors: Array<{ row: number; reason: string }>;
    }>(path, csv, "text/csv", { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
  }

  async acceptInvitation(
    code: string,
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const wire = await this.http.post<WireMember>(
      `/v1/invitations/${encodeURIComponent(code)}/accept`,
      { userId },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async declineInvitation(
    code: string,
    opts?: { userId?: UserId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    const body: Record<string, string> = {};
    if (opts?.userId !== undefined) body.userId = opts.userId;
    await this.http.post<unknown>(`/v1/invitations/${encodeURIComponent(code)}/decline`, body, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }

  async leave(
    groupId: GroupId,
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/leave`,
      { userId },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  /**
   * Open join. Server enforces that the group's `visibility` is "public";
   * invite-only groups return 403 and secret groups return 404.
   * Pass `opts.passcode` when the group has `hasPasscode: true`; the
   * server returns 403 `passcode_required` / `passcode_invalid` otherwise.
   */
  async join(
    groupId: GroupId,
    userId: UserId,
    opts?: { passcode?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const body: Record<string, string> = { userId };
    if (opts?.passcode !== undefined) body.passcode = opts.passcode;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/join`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async kick(
    groupId: GroupId,
    userId: UserId,
    opts?: { reason?: string; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const body: Record<string, string> = {};
    if (opts?.reason !== undefined) body.reason = opts.reason;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/kick`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  /**
   * Per-group ban. Distinct from kick: the banned user cannot rejoin
   * via public-join or invitation accept; the routes return 403 with
   * `code: "banned"`. `expiresAt` enables time-bounded bans (omit /
   * null = permanent). Use `client.bans.add(...)` for game-wide bans.
   */
  async ban(
    groupId: GroupId,
    userId: UserId,
    opts?: {
      reason?: string | null;
      expiresAt?: Date | string | null;
      // Optional moderator attribution (mirrors `bans.add`).
      actorUserId?: UserId;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<Member> {
    const body: Record<string, unknown> = {};
    if (opts?.reason !== undefined) body.reason = opts.reason;
    if (opts?.expiresAt !== undefined) {
      body.expiresAt =
        opts.expiresAt === null
          ? null
          : opts.expiresAt instanceof Date
            ? opts.expiresAt.toISOString()
            : opts.expiresAt;
    }
    if (opts?.actorUserId !== undefined) body.actorUserId = opts.actorUserId;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/ban`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async unban(
    groupId: GroupId,
    userId: UserId,
    opts?: { actorUserId?: UserId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const wire = await this.http.delete<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/ban`,
      opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  /**
   * Group-scoped ban-event timeline: every set/lift on this group
   * across all users, newest-first. Game-wide bans are NOT included
   * (use `client.bans.history(userId)` for that). Cursor-paginated.
   */
  async banHistory(
    groupId: GroupId,
    opts?: PageOptions & { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Page<BanHistoryEntry>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const base = `/v1/groups/${encodeURIComponent(groupId)}/bans/history`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{
      items: WireBanHistoryEntry[];
      nextCursor: string | null;
    }>(path, { signal: opts?.signal, timeoutMs: opts?.timeoutMs });
    return {
      items: wire.items.map(deserializeBanHistoryEntry),
      nextCursor: wire.nextCursor,
    };
  }

  banHistoryAll(
    groupId: GroupId,
    opts?: { limit?: number; signal?: AbortSignal; timeoutMs?: number },
  ): AsyncGenerator<BanHistoryEntry> {
    return paginate((cursor) => this.banHistory(groupId, { ...opts, cursor }));
  }

  // ------ Real-time ------

  /**
   * Subscribes to the group's live event stream (SSE). Resolves after
   * the server has accepted the connection, so 401 / 404 surface as a
   * thrown `JunjoError` rather than via `onError`; mid-stream failures
   * fire `onError` and end the stream. A clean server-side close (a
   * deploy, a proxy idle timeout) fires `onClose` instead: resubscribe
   * from there. There is no replay in either case: events that occur
   * between a disconnect and a resubscribe are lost. Reconnect by
   * calling `subscribe` again.
   */
  async subscribe(
    groupId: GroupId,
    handler: (event: JunjoEvent) => void,
    opts?: SubscribeOptions,
  ): Promise<Subscription> {
    // An already-aborted signal means the caller has cancelled before
    // the connection attempt; refuse to open one at all.
    if (opts?.signal?.aborted) {
      throw new JunjoError("request cancelled", "cancelled");
    }
    const controller = new AbortController();
    // The caller's signal feeds the internal controller, so aborting it
    // cancels the connection attempt and, once open, closes the stream
    // (onAbort is upgraded to the full close() once the reader exists,
    // so a mid-stream abort runs the same cleanup as close()).
    const callerSignal = opts?.signal;
    let onAbort: () => void = () => controller.abort();
    const onCallerAbort = () => onAbort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    let res: Response;
    try {
      res = await this.http.openStream(`/v1/events/${encodeURIComponent(groupId)}`, {
        signal: controller.signal,
      });
    } catch (err) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      throw err;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      throw new JunjoError("response has no body", "invalid_wire_data");
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      callerSignal?.removeEventListener("abort", onCallerAbort);
      controller.abort();
      reader.cancel().catch(() => undefined);
    };
    onAbort = close;

    const reportError = (err: Error) => {
      if (closed) return;
      close();
      opts?.onError?.(err);
    };

    void (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) {
            // The SERVER ended the stream cleanly. Run the same cleanup
            // close() performs (listener removal, closed state) and tell
            // the consumer via onClose so the subscription doesn't die
            // silently. A close()/abort that raced this read has already
            // set `closed`; the consumer initiated that one, so no
            // notification.
            const serverInitiated = !closed;
            close();
            if (serverInitiated) opts?.onClose?.();
            break;
          }
          if (value) buffer += decoder.decode(value, { stream: true });
          // A server (or middlebox) that never sends the frame delimiter
          // would otherwise grow the buffer without bound; treat an
          // over-long unterminated frame as a stream error.
          if (buffer.length > MAX_SSE_BUFFER_CHARS) {
            reportError(
              new JunjoError(
                `SSE frame exceeded ${MAX_SSE_BUFFER_CHARS} characters without a delimiter`,
                "stream_overflow",
              ),
            );
            return;
          }
          // Frames end at a blank line; tolerate CRLF-normalized
          // streams by accepting \r\n\r\n (and mixes) as the delimiter.
          let match = buffer.match(SSE_FRAME_DELIMITER);
          while (match?.index !== undefined) {
            const block = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const frame = parseSSEFrame(block);
            if (frame?.data !== undefined) {
              let event: JunjoEvent | null = null;
              try {
                const wire = JSON.parse(frame.data) as WireJunjoEvent;
                event = deserializeEvent(wire);
              } catch (err) {
                if (err instanceof JunjoError && err.code === UNKNOWN_EVENT_TYPE) {
                  // A newer server sent an event type this SDK predates;
                  // skip the frame rather than killing the stream.
                  event = null;
                } else {
                  reportError(err instanceof Error ? err : new Error(String(err)));
                  return;
                }
              }
              if (event !== null) {
                try {
                  handler(event);
                } catch (err) {
                  reportError(err instanceof Error ? err : new Error(String(err)));
                  return;
                }
              }
            }
            match = buffer.match(SSE_FRAME_DELIMITER);
          }
        }
      } catch (err) {
        const name = (err as { name?: string } | null)?.name;
        if (closed || name === "AbortError") return;
        reportError(err instanceof Error ? err : new Error(String(err)));
      }
    })();

    return { close };
  }

  // ------ Group relationships ------

  async setRelationship(
    groupAId: GroupId,
    groupBId: GroupId,
    type: GroupRelationshipType,
    opts?: { mutual?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GroupRelationship> {
    const body: { type: string; mutual?: boolean } = { type };
    if (opts?.mutual !== undefined) body.mutual = opts.mutual;
    const wire = await this.http.put<WireGroupRelationship>(
      `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeGroupRelationship(wire);
  }

  async clearRelationship(
    groupAId: GroupId,
    groupBId: GroupId,
    opts?: { mutual?: boolean; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    const path = opts?.mutual
      ? `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}?mutual=true`
      : `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`;
    await this.http.delete<unknown>(path, undefined, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
  }

  async getRelationship(
    groupAId: GroupId,
    groupBId: GroupId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GroupRelationship | null> {
    try {
      const wire = await this.http.get<WireGroupRelationship>(
        `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`,
        { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
      );
      return deserializeGroupRelationship(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async listRelationships(
    groupId: GroupId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<GroupRelationship[]> {
    const wire = await this.http.get<WireGroupRelationship[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/relationships`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.map(deserializeGroupRelationship);
  }

  // ------ Sub-groups / alliances ------

  async setParent(
    groupId: GroupId,
    parentGroupId: GroupId | null,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Group> {
    const wire = await this.http.put<WireGroup>(
      `/v1/groups/${encodeURIComponent(groupId)}/parent`,
      { parentGroupId },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeGroup(wire);
  }

  async listChildren(
    groupId: GroupId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Group[]> {
    const wire = await this.http.get<WireGroup[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/children`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.map(deserializeGroup);
  }
}
