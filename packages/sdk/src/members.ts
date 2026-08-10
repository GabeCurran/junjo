import type {
  GameId,
  GroupId,
  Member,
  MemberId,
  MemberPermissionOverride,
  MemberStatus,
  Page,
  PageOptions,
  PermissionKey,
  RoleId,
  SetMemberNotesInput,
  UserId,
} from "@junjo.io/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";
import { paginate } from "./pagination.js";
import { parseWireDate } from "./wire.js";

export interface WireMember {
  id: string;
  groupId: string;
  userId: string;
  status: string;
  roles: string[];
  metadata: Record<string, unknown>;
  notesPublic: string | null;
  notesPrivate: string | null;
  joinedAt: string;
  bannedUntil: string | null;
}

export function deserializeMember(w: WireMember): Member {
  return {
    id: w.id as MemberId,
    groupId: w.groupId as GroupId,
    userId: w.userId as UserId,
    status: w.status as MemberStatus,
    roles: w.roles.map((r) => r as RoleId),
    metadata: w.metadata,
    notesPublic: w.notesPublic,
    notesPrivate: w.notesPrivate,
    joinedAt: parseWireDate(w.joinedAt, "joinedAt"),
    bannedUntil: w.bannedUntil === null ? null : parseWireDate(w.bannedUntil, "bannedUntil"),
  };
}

export interface WireMemberPermissionOverride {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  setAt: string;
  setBy: string | null;
}

export function deserializeMemberPermissionOverride(
  w: WireMemberPermissionOverride,
): MemberPermissionOverride {
  return {
    groupId: w.groupId as GroupId,
    userId: w.userId as UserId,
    permission: w.permission as PermissionKey,
    grant: w.grant,
    setAt: parseWireDate(w.setAt, "setAt"),
    setBy: w.setBy === null ? null : (w.setBy as UserId),
  };
}

/** Options for {@link MembersApi.list}. */
export interface ListMembersOptions extends PageOptions {
  /**
   * Filter to one or more statuses. Omit for all statuses (the default).
   * Common shapes: ["active"] for "show me current members",
   * ["banned"] for the moderation panel.
   */
  status?: MemberStatus[];
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Group members: lookups, listing, per-member metadata and notes, role
 * assignment, and per-member permission overrides.
 */
export class MembersApi {
  constructor(private readonly http: HttpClient) {}

  async get(
    groupId: GroupId,
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member | null> {
    try {
      const wire = await this.http.get<WireMember>(
        `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
        { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
      );
      return deserializeMember(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async getById(
    id: MemberId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member | null> {
    try {
      const wire = await this.http.get<WireMember>(`/v1/members/${encodeURIComponent(id)}`, {
        signal: opts?.signal,
        timeoutMs: opts?.timeoutMs,
      });
      return deserializeMember(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  /**
   * Async-iterator wrapper over `list(...)`. Walks every page until
   * `nextCursor` is null. Combine with `status` to iterate all banned
   * members in a group, all kicked members, etc.
   */
  listAll(groupId: GroupId, opts?: Omit<ListMembersOptions, "cursor">): AsyncGenerator<Member> {
    return paginate((cursor) => this.list(groupId, { ...opts, cursor }));
  }

  async list(groupId: GroupId, opts?: ListMembersOptions): Promise<Page<Member>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.status !== undefined && opts.status.length > 0) {
      params.set("status", opts.status.join(","));
    }
    const qs = params.toString();
    const base = `/v1/groups/${encodeURIComponent(groupId)}/members`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{ items: WireMember[]; nextCursor: string | null }>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return {
      items: wire.items.map(deserializeMember),
      nextCursor: wire.nextCursor,
    };
  }

  async listForUser(
    userId: UserId,
    opts?: { gameId?: GameId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member[]> {
    const params = new URLSearchParams();
    if (opts?.gameId !== undefined) params.set("gameId", opts.gameId);
    const qs = params.toString();
    const base = `/v1/users/${encodeURIComponent(userId)}/members`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<WireMember[]>(path, {
      signal: opts?.signal,
      timeoutMs: opts?.timeoutMs,
    });
    return wire.map(deserializeMember);
  }

  async setMetadata(
    groupId: GroupId,
    userId: UserId,
    metadata: Record<string, unknown>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const wire = await this.http.patch<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      { metadata },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async setNotes(
    groupId: GroupId,
    userId: UserId,
    input: SetMemberNotesInput,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const body: Record<string, string | null> = {};
    if (input.notesPublic !== undefined) body.notesPublic = input.notesPublic;
    if (input.notesPrivate !== undefined) body.notesPrivate = input.notesPrivate;
    const wire = await this.http.patch<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async assignRole(
    groupId: GroupId,
    userId: UserId,
    roleId: RoleId,
    opts?: { actorUserId?: UserId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const body = opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async removeRole(
    groupId: GroupId,
    userId: UserId,
    roleId: RoleId,
    opts?: { actorUserId?: UserId; signal?: AbortSignal; timeoutMs?: number },
  ): Promise<Member> {
    const body = opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined;
    const wire = await this.http.delete<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      body,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMember(wire);
  }

  async overridePermission(
    groupId: GroupId,
    userId: UserId,
    permission: PermissionKey,
    grant: boolean,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MemberPermissionOverride> {
    const wire = await this.http.post<WireMemberPermissionOverride>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
      { grant },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return deserializeMemberPermissionOverride(wire);
  }

  async clearPermissionOverride(
    groupId: GroupId,
    userId: UserId,
    permission: PermissionKey,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
      undefined,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
  }

  async listPermissionOverrides(
    groupId: GroupId,
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MemberPermissionOverride[]> {
    const wire = await this.http.get<WireMemberPermissionOverride[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions`,
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.map(deserializeMemberPermissionOverride);
  }
}
