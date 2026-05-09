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
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";

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
    joinedAt: new Date(w.joinedAt),
    bannedUntil: w.bannedUntil === null ? null : new Date(w.bannedUntil),
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
    setAt: new Date(w.setAt),
    setBy: w.setBy === null ? null : (w.setBy as UserId),
  };
}

export class MembersApi {
  constructor(private readonly http: HttpClient) {}

  async get(groupId: GroupId, userId: UserId): Promise<Member | null> {
    try {
      const wire = await this.http.get<WireMember>(
        `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      );
      return deserializeMember(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async getById(id: MemberId): Promise<Member | null> {
    try {
      const wire = await this.http.get<WireMember>(`/v1/members/${encodeURIComponent(id)}`);
      return deserializeMember(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async list(groupId: GroupId, opts?: PageOptions): Promise<Page<Member>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    const qs = params.toString();
    const base = `/v1/groups/${encodeURIComponent(groupId)}/members`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<{ items: WireMember[]; nextCursor: string | null }>(path);
    return {
      items: wire.items.map(deserializeMember),
      nextCursor: wire.nextCursor,
    };
  }

  async listForUser(userId: UserId, opts?: { gameId?: GameId }): Promise<Member[]> {
    const params = new URLSearchParams();
    if (opts?.gameId !== undefined) params.set("gameId", opts.gameId);
    const qs = params.toString();
    const base = `/v1/users/${encodeURIComponent(userId)}/members`;
    const path = qs ? `${base}?${qs}` : base;
    const wire = await this.http.get<WireMember[]>(path);
    return wire.map(deserializeMember);
  }

  async setMetadata(
    groupId: GroupId,
    userId: UserId,
    metadata: Record<string, unknown>,
  ): Promise<Member> {
    const wire = await this.http.patch<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      { metadata },
    );
    return deserializeMember(wire);
  }

  async setNotes(groupId: GroupId, userId: UserId, input: SetMemberNotesInput): Promise<Member> {
    const body: Record<string, string | null> = {};
    if (input.notesPublic !== undefined) body.notesPublic = input.notesPublic;
    if (input.notesPrivate !== undefined) body.notesPrivate = input.notesPrivate;
    const wire = await this.http.patch<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      body,
    );
    return deserializeMember(wire);
  }

  async assignRole(groupId: GroupId, userId: UserId, roleId: RoleId): Promise<Member> {
    const wire = await this.http.post<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    );
    return deserializeMember(wire);
  }

  async removeRole(groupId: GroupId, userId: UserId, roleId: RoleId): Promise<Member> {
    const wire = await this.http.delete<WireMember>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
    );
    return deserializeMember(wire);
  }

  async overridePermission(
    groupId: GroupId,
    userId: UserId,
    permission: PermissionKey,
    grant: boolean,
  ): Promise<MemberPermissionOverride> {
    const wire = await this.http.post<WireMemberPermissionOverride>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
      { grant },
    );
    return deserializeMemberPermissionOverride(wire);
  }

  async clearPermissionOverride(
    groupId: GroupId,
    userId: UserId,
    permission: PermissionKey,
  ): Promise<void> {
    await this.http.delete<unknown>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions/${encodeURIComponent(permission)}`,
    );
  }

  async listPermissionOverrides(
    groupId: GroupId,
    userId: UserId,
  ): Promise<MemberPermissionOverride[]> {
    const wire = await this.http.get<WireMemberPermissionOverride[]>(
      `/v1/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/permissions`,
    );
    return wire.map(deserializeMemberPermissionOverride);
  }
}
