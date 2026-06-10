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
} from "@junjo/shared";
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

export interface SubscribeOptions {
  // Notified when a streaming error occurs after the connection is open
  // (network drop, malformed frame, JSON parse failure). The subscription
  // is closed before this fires; reconnect by calling `subscribe` again.
  onError?: (err: Error) => void;
}

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

export class GroupsApi {
  constructor(
    private readonly http: HttpClient,
    private readonly inviteBaseUrl: string,
  ) {}

  // Pass `creatorUserId` to atomically add the creator as an active
  // member in the same transaction as the group insert, with a
  // `member.joined` audit entry tagged `via: "creator"` and a
  // `member.joined` webhook event. Useful for non-public groups where
  // the creator can't reach themselves through `groups.join` (which
  // requires `visibility = "public"`). When `defaultRoleId` is set and
  // a matching Role already exists in the new group, the role is
  // assigned to the creator in the same transaction.
  async create(input: CreateGroupInput): Promise<Group> {
    const wire = await this.http.post<WireGroup>("/v1/groups", input);
    return deserializeGroup(wire);
  }

  // Pass `viewer` (an external userId) to scope visibility to that user;
  // secret groups they aren't a member of will return null. Without it
  // the server treats the call as admin/server-side and returns the group
  // regardless of visibility.
  async get(id: GroupId, opts?: { viewer?: UserId }): Promise<Group | null> {
    try {
      const params = new URLSearchParams();
      if (opts?.viewer !== undefined) params.set("viewer", opts.viewer);
      const qs = params.toString();
      const path = qs
        ? `/v1/groups/${encodeURIComponent(id)}?${qs}`
        : `/v1/groups/${encodeURIComponent(id)}`;
      const wire = await this.http.get<WireGroup>(path);
      return deserializeGroup(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async list(opts?: PageOptions & { gameId?: GameId; viewer?: UserId }): Promise<Page<Group>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.gameId !== undefined) params.set("gameId", opts.gameId);
    if (opts?.viewer !== undefined) params.set("viewer", opts.viewer);
    const qs = params.toString();
    const path = qs ? `/v1/groups?${qs}` : "/v1/groups";
    const wire = await this.http.get<{ items: WireGroup[]; nextCursor: string | null }>(path);
    return {
      items: wire.items.map(deserializeGroup),
      nextCursor: wire.nextCursor,
    };
  }

  // Async-iterator wrapper over `list(...)` that walks every page until
  // `nextCursor` is null. Use when you genuinely need every group --
  // prefer `list(...)` with explicit pagination for UI surfaces. The
  // underlying server still caps `limit` at JUNJO_MAX_PAGE_SIZE.
  listAll(opts?: { limit?: number; gameId?: GameId; viewer?: UserId }): AsyncGenerator<Group> {
    return paginate((cursor) => this.list({ ...opts, cursor }));
  }

  async update(id: GroupId, input: UpdateGroupInput): Promise<Group> {
    const wire = await this.http.patch<WireGroup>(`/v1/groups/${encodeURIComponent(id)}`, input);
    return deserializeGroup(wire);
  }

  // Soft delete with a 7-day undo window; `hard: true` bypasses it.
  async delete(id: GroupId, opts?: { hard?: boolean }): Promise<void> {
    const path = opts?.hard
      ? `/v1/groups/${encodeURIComponent(id)}?hard=true`
      : `/v1/groups/${encodeURIComponent(id)}`;
    await this.http.delete<unknown>(path);
  }

  async restore(id: GroupId): Promise<Group> {
    const wire = await this.http.post<WireGroup>(`/v1/groups/${encodeURIComponent(id)}/restore`);
    return deserializeGroup(wire);
  }

  // ------ Membership ------

  async inviteByUserId(
    groupId: GroupId,
    userId: UserId,
    opts?: { roleId?: RoleId },
  ): Promise<Invitation> {
    const body: { targetUserId: string; roleId?: string } = { targetUserId: userId };
    if (opts?.roleId !== undefined) body.roleId = opts.roleId;
    const wire = await this.http.post<WireInvitation>(
      `/v1/groups/${encodeURIComponent(groupId)}/invitations`,
      body,
    );
    return deserializeInvitation(wire);
  }

  async inviteByCode(groupId: GroupId, input?: CreateInvitationInput): Promise<Invitation> {
    const wire = await this.http.post<WireInvitation>(
      `/v1/groups/${encodeURIComponent(groupId)}/invitations`,
      buildOpenInviteBody(input),
    );
    return deserializeInvitation(wire);
  }

  async inviteByLink(
    groupId: GroupId,
    input?: CreateInvitationInput,
  ): Promise<{ invitation: Invitation; url: string }> {
    const invitation = await this.inviteByCode(groupId, input);
    const url = `${this.inviteBaseUrl}/invite/${encodeURIComponent(invitation.code)}`;
    return { invitation, url };
  }

  async bulkInvite(
    groupId: GroupId,
    csv: string | ReadableStream<Uint8Array>,
    opts?: { roleId?: RoleId },
  ): Promise<{ invited: number; skipped: number; errors: Array<{ row: number; reason: string }> }> {
    const params = new URLSearchParams();
    if (opts?.roleId !== undefined) params.set("roleId", opts.roleId);
    const qs = params.toString();
    const path = `/v1/groups/${encodeURIComponent(groupId)}/bulk-invite${qs ? `?${qs}` : ""}`;
    return this.http.postRaw<{
      invited: number;
      skipped: number;
      errors: Array<{ row: number; reason: string }>;
    }>(path, csv, "text/csv");
  }

  async acceptInvitation(code: string, userId: UserId): Promise<Member> {
    const wire = await this.http.post<WireMember>(
      `/v1/invitations/${encodeURIComponent(code)}/accept`,
      { userId },
    );
    return deserializeMember(wire);
  }

  async declineInvitation(code: string, opts?: { userId?: UserId }): Promise<void> {
    const body: Record<string, string> = {};
    if (opts?.userId !== undefined) body.userId = opts.userId;
    await this.http.post<unknown>(`/v1/invitations/${encodeURIComponent(code)}/decline`, body);
  }

  async leave(groupId: GroupId, userId: UserId): Promise<Member> {
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/leave`,
      { userId },
    );
    return deserializeMember(wire);
  }

  // Open join. Server enforces that the group's `visibility` is "public";
  // invite-only groups return 403 and secret groups return 404.
  // Pass `opts.passcode` when the group has `hasPasscode: true`; the
  // server returns 403 `passcode_required` / `passcode_invalid` otherwise.
  async join(groupId: GroupId, userId: UserId, opts?: { passcode?: string }): Promise<Member> {
    const body: Record<string, string> = { userId };
    if (opts?.passcode !== undefined) body.passcode = opts.passcode;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/join`,
      body,
    );
    return deserializeMember(wire);
  }

  async kick(groupId: GroupId, userId: UserId, opts?: { reason?: string }): Promise<Member> {
    const body: Record<string, string> = {};
    if (opts?.reason !== undefined) body.reason = opts.reason;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/kick`,
      body,
    );
    return deserializeMember(wire);
  }

  // Per-group ban. Distinct from kick: the banned user cannot rejoin
  // via public-join or invitation accept; the routes return 403 with
  // `code: "banned"`. `expiresAt` enables time-bounded bans (omit /
  // null = permanent). Use `client.bans.add(...)` for game-wide bans.
  async ban(
    groupId: GroupId,
    userId: UserId,
    opts?: {
      reason?: string | null;
      expiresAt?: Date | string | null;
      // Optional moderator attribution (mirrors `bans.add`).
      actorUserId?: UserId;
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
    );
    return deserializeMember(wire);
  }

  async unban(groupId: GroupId, userId: UserId, opts?: { actorUserId?: UserId }): Promise<Member> {
    const wire = await this.http.delete<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/ban`,
      opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined,
    );
    return deserializeMember(wire);
  }

  // Group-scoped ban-event timeline: every set/lift on this group
  // across all users, newest-first. Game-wide bans are NOT included
  // (use `client.bans.history(userId)` for that). Cursor-paginated.
  async banHistory(groupId: GroupId, opts?: PageOptions): Promise<Page<BanHistoryEntry>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const base = `/v1/groups/${encodeURIComponent(groupId)}/bans/history`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{
      items: WireBanHistoryEntry[];
      nextCursor: string | null;
    }>(path);
    return {
      items: wire.items.map(deserializeBanHistoryEntry),
      nextCursor: wire.nextCursor,
    };
  }

  banHistoryAll(groupId: GroupId, opts?: { limit?: number }): AsyncGenerator<BanHistoryEntry> {
    return paginate((cursor) => this.banHistory(groupId, { ...opts, cursor }));
  }

  // ------ Real-time ------

  // Resolves after the server has accepted the connection, so 401 / 404
  // surface as a thrown `JunjoError` rather than via `onError`; mid-stream
  // failures fire `onError` and end the stream.
  async subscribe(
    groupId: GroupId,
    handler: (event: JunjoEvent) => void,
    opts?: SubscribeOptions,
  ): Promise<Subscription> {
    const controller = new AbortController();
    const res = await this.http.openStream(`/v1/events/${encodeURIComponent(groupId)}`, {
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    if (!reader) {
      throw new JunjoError("response has no body", "internal");
    }

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      controller.abort();
      reader.cancel().catch(() => undefined);
    };

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
          if (done) break;
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
    opts?: { mutual?: boolean },
  ): Promise<GroupRelationship> {
    const body: { type: string; mutual?: boolean } = { type };
    if (opts?.mutual !== undefined) body.mutual = opts.mutual;
    const wire = await this.http.put<WireGroupRelationship>(
      `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`,
      body,
    );
    return deserializeGroupRelationship(wire);
  }

  async clearRelationship(
    groupAId: GroupId,
    groupBId: GroupId,
    opts?: { mutual?: boolean },
  ): Promise<void> {
    const path = opts?.mutual
      ? `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}?mutual=true`
      : `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`;
    await this.http.delete<unknown>(path);
  }

  async getRelationship(groupAId: GroupId, groupBId: GroupId): Promise<GroupRelationship | null> {
    try {
      const wire = await this.http.get<WireGroupRelationship>(
        `/v1/groups/${encodeURIComponent(groupAId)}/relationships/${encodeURIComponent(groupBId)}`,
      );
      return deserializeGroupRelationship(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async listRelationships(groupId: GroupId): Promise<GroupRelationship[]> {
    const wire = await this.http.get<WireGroupRelationship[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/relationships`,
    );
    return wire.map(deserializeGroupRelationship);
  }

  // ------ Sub-groups / alliances ------

  async setParent(groupId: GroupId, parentGroupId: GroupId | null): Promise<Group> {
    const wire = await this.http.put<WireGroup>(
      `/v1/groups/${encodeURIComponent(groupId)}/parent`,
      { parentGroupId },
    );
    return deserializeGroup(wire);
  }

  async listChildren(groupId: GroupId): Promise<Group[]> {
    const wire = await this.http.get<WireGroup[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/children`,
    );
    return wire.map(deserializeGroup);
  }
}
