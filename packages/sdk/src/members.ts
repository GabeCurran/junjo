import type {
  GameId,
  GroupId,
  Member,
  MemberAccess,
  MemberId,
  MemberImportInput,
  MemberImportResult,
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
import {
  type ConditionalWriteOptions,
  type HttpClient,
  type WriteOptions,
  writeOptions,
} from "./http.js";
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
  version: number;
  displayName?: string | null;
}

// `displayName` is copied only when sent: the member snapshot inside
// `member.joined` omits it, and an absent field must stay absent rather
// than read as "no name".
export function deserializeMember(w: WireMember): Member {
  const member: Member = {
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
    version: w.version,
  };
  if (w.displayName !== undefined) member.displayName = w.displayName;
  return member;
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

export interface WireMemberAccess {
  groupId: string;
  userId: string;
  status: string;
  roleIds: string[];
  overrides: WireMemberPermissionOverride[];
  version: number;
  displayName: string | null;
  metadata?: Record<string, unknown>;
}

export function deserializeMemberAccess(w: WireMemberAccess): MemberAccess {
  return {
    groupId: w.groupId as GroupId,
    userId: w.userId as UserId,
    status: w.status as MemberStatus,
    roleIds: w.roleIds.map((r) => r as RoleId),
    overrides: w.overrides.map(deserializeMemberPermissionOverride),
    version: w.version,
    displayName: w.displayName ?? null,
    metadata: w.metadata ?? {},
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
 *
 * Every write accepts `idempotencyKey`. The member-scoped writes
 * (`setMetadata`, `setNotes`, `assignRole`, `removeRole`,
 * `overridePermission`, `clearPermissionOverride`) also accept
 * `ifMatch`, the member version the write expects (`Member.version`,
 * `MemberAccess.version`); a missing member still fails `not_found`,
 * never `precondition_failed`.
 */
export class MembersApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Adds a user to a group directly (POST /v1/groups/:id/members), the
   * server-to-server counterpart to `groups.join`. Unlike `join` it
   * ignores the group's `visibility`, so provisioning does not have to
   * make internal authorization groups publicly joinable. Bans are
   * still enforced.
   *
   * Idempotent: re-adding an active member returns the existing member
   * unchanged. Pass `roleId` to assign a role in the same transaction
   * instead of following up with `assignRole`.
   */
  async add(
    groupId: GroupId,
    userId: UserId,
    opts?: WriteOptions & {
      roleId?: RoleId;
      actorUserId?: UserId;
    },
  ): Promise<Member> {
    const body: { userId: string; roleId?: string; actorUserId?: string } = { userId };
    if (opts?.roleId !== undefined) body.roleId = opts.roleId;
    if (opts?.actorUserId !== undefined) body.actorUserId = opts.actorUserId;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members`,
      body,
      writeOptions(opts),
    );
    return deserializeMember(wire);
  }

  /**
   * Imports up to 500 memberships into one group in a single
   * transaction (POST /v1/groups/:id/members/import): every row applies
   * or none does. Each row ensures an active membership; a present
   * `roleIds`, `overrides` or `metadata` replaces the current value and
   * an absent one is left as is. Like `add`, it ignores the group's
   * `visibility`.
   *
   * Rows are validated before anything is written. A rejected import
   * throws `JunjoError` (`bad_request`, or `banned` when every failing
   * row is a ban) whose failing rows `memberImportErrors(err)` reads.
   * Re-running an identical import reports every row `unchanged` and
   * writes nothing.
   */
  async import(
    groupId: GroupId,
    input: MemberImportInput,
    opts?: WriteOptions,
  ): Promise<MemberImportResult> {
    return this.http.post<MemberImportResult>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/import`,
      input,
      writeOptions(opts),
    );
  }

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
    opts?: ConditionalWriteOptions,
  ): Promise<Member> {
    const wire = await this.http.patch<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      { metadata },
      writeOptions(opts),
    );
    return deserializeMember(wire);
  }

  async setNotes(
    groupId: GroupId,
    userId: UserId,
    input: SetMemberNotesInput,
    opts?: ConditionalWriteOptions,
  ): Promise<Member> {
    const body: Record<string, string | null> = {};
    if (input.notesPublic !== undefined) body.notesPublic = input.notesPublic;
    if (input.notesPrivate !== undefined) body.notesPrivate = input.notesPrivate;
    const wire = await this.http.patch<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      body,
      writeOptions(opts),
    );
    return deserializeMember(wire);
  }

  async assignRole(
    groupId: GroupId,
    userId: UserId,
    roleId: RoleId,
    opts?: ConditionalWriteOptions & { actorUserId?: UserId },
  ): Promise<Member> {
    const body = opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined;
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      body,
      writeOptions(opts),
    );
    return deserializeMember(wire);
  }

  async removeRole(
    groupId: GroupId,
    userId: UserId,
    roleId: RoleId,
    opts?: ConditionalWriteOptions & { actorUserId?: UserId },
  ): Promise<Member> {
    const body = opts?.actorUserId !== undefined ? { actorUserId: opts.actorUserId } : undefined;
    const wire = await this.http.delete<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
      body,
      writeOptions(opts),
    );
    return deserializeMember(wire);
  }

  /**
   * Sets one personal permission entry. The response is the entry, not
   * the member, so it carries no member version; read `getAccess` for
   * the version after the write.
   */
  async overridePermission(
    groupId: GroupId,
    userId: UserId,
    permission: PermissionKey,
    grant: boolean,
    opts?: ConditionalWriteOptions,
  ): Promise<MemberPermissionOverride> {
    const wire = await this.http.post<WireMemberPermissionOverride>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
      { grant },
      writeOptions(opts),
    );
    return deserializeMemberPermissionOverride(wire);
  }

  async clearPermissionOverride(
    groupId: GroupId,
    userId: UserId,
    permission: PermissionKey,
    opts?: ConditionalWriteOptions,
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
      undefined,
      writeOptions(opts),
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

  /**
   * Reads one member's direct role ids and permission overrides in a
   * group, in one call. Resolves to null when the user is not a member
   * of the group (or the group does not exist), like `get`.
   */
  async getAccess(
    groupId: GroupId,
    userId: UserId,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<MemberAccess | null> {
    try {
      const wire = await this.http.get<WireMemberAccess>(
        `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/access`,
        { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
      );
      return deserializeMemberAccess(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  /**
   * Reads the access of up to 100 users in a group in one request
   * (POST /v1/groups/:id/members/access). The result lines up with
   * `userIds`: entry i is null when `userIds[i]` names no member of the
   * group. Any of a person's linked ids finds them. Rejects with
   * `not_found` when the group does not exist.
   */
  async getAccessMany(
    groupId: GroupId,
    userIds: readonly UserId[],
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<(MemberAccess | null)[]> {
    const wire = await this.http.post<{ items: (WireMemberAccess | null)[] }>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/access`,
      { userIds },
      { signal: opts?.signal, timeoutMs: opts?.timeoutMs },
    );
    return wire.items.map((item) => (item === null ? null : deserializeMemberAccess(item)));
  }
}
