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

const NOT_IMPLEMENTED = new JunjoError("not implemented", "not_implemented");

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
    _groupId: GroupId,
    _userId: UserId,
    _metadata: Record<string, unknown>,
  ): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async setNotes(_groupId: GroupId, _userId: UserId, _input: SetMemberNotesInput): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async assignRole(_groupId: GroupId, _userId: UserId, _roleId: RoleId): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async removeRole(_groupId: GroupId, _userId: UserId, _roleId: RoleId): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async overridePermission(
    _groupId: GroupId,
    _userId: UserId,
    _permission: PermissionKey,
    _grant: boolean,
  ): Promise<MemberPermissionOverride> {
    throw NOT_IMPLEMENTED;
  }

  async clearPermissionOverride(
    _groupId: GroupId,
    _userId: UserId,
    _permission: PermissionKey,
  ): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async listPermissionOverrides(
    _groupId: GroupId,
    _userId: UserId,
  ): Promise<MemberPermissionOverride[]> {
    throw NOT_IMPLEMENTED;
  }
}
