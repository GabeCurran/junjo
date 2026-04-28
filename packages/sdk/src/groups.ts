import type {
  CreateGroupInput,
  CreateInvitationInput,
  GameId,
  Group,
  GroupId,
  GroupRelationship,
  GroupRelationshipType,
  GroupVisibility,
  Invitation,
  JunjoEvent,
  Member,
  Page,
  PageOptions,
  RoleId,
  UpdateGroupInput,
  UserId,
} from "@junjo/shared";
import { JunjoError } from "./errors.js";
import type { HttpClient } from "./http.js";

const NOT_IMPLEMENTED = new JunjoError("not implemented", "not_implemented");

export interface WireGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: GroupVisibility;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  memberCount: number;
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
    memberCount: w.memberCount,
    createdAt: new Date(w.createdAt),
    updatedAt: new Date(w.updatedAt),
    softDeletedAt: w.softDeletedAt === null ? null : new Date(w.softDeletedAt),
  };
}

export class GroupsApi {
  constructor(private readonly http: HttpClient) {}

  async create(input: CreateGroupInput): Promise<Group> {
    const wire = await this.http.post<WireGroup>("/v1/groups", input);
    return deserializeGroup(wire);
  }

  async get(id: GroupId): Promise<Group | null> {
    try {
      const wire = await this.http.get<WireGroup>(`/v1/groups/${encodeURIComponent(id)}`);
      return deserializeGroup(wire);
    } catch (err) {
      if (err instanceof JunjoError && err.code === "not_found") return null;
      throw err;
    }
  }

  async list(opts?: PageOptions & { gameId?: GameId }): Promise<Page<Group>> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts?.cursor !== undefined) params.set("cursor", opts.cursor);
    if (opts?.gameId !== undefined) params.set("gameId", opts.gameId);
    const qs = params.toString();
    const path = qs ? `/v1/groups?${qs}` : "/v1/groups";
    const wire = await this.http.get<{ items: WireGroup[]; nextCursor: string | null }>(path);
    return {
      items: wire.items.map(deserializeGroup),
      nextCursor: wire.nextCursor,
    };
  }

  async update(id: GroupId, input: UpdateGroupInput): Promise<Group> {
    const wire = await this.http.patch<WireGroup>(`/v1/groups/${encodeURIComponent(id)}`, input);
    return deserializeGroup(wire);
  }

  // Soft delete with a 7-day undo window. Pass `hard: true` to bypass.
  async delete(_id: GroupId, _opts?: { hard?: boolean }): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async restore(_id: GroupId): Promise<Group> {
    throw NOT_IMPLEMENTED;
  }

  // ------ Membership ------

  async inviteByUserId(
    _groupId: GroupId,
    _userId: UserId,
    _opts?: { roleId?: RoleId },
  ): Promise<Invitation> {
    throw NOT_IMPLEMENTED;
  }

  async inviteByCode(_groupId: GroupId, _input?: CreateInvitationInput): Promise<Invitation> {
    throw NOT_IMPLEMENTED;
  }

  async inviteByLink(
    _groupId: GroupId,
    _input?: CreateInvitationInput,
  ): Promise<{ invitation: Invitation; url: string }> {
    throw NOT_IMPLEMENTED;
  }

  async bulkInvite(
    _groupId: GroupId,
    _csv: string | ReadableStream<Uint8Array>,
    _opts?: { roleId?: RoleId },
  ): Promise<{ invited: number; skipped: number; errors: Array<{ row: number; reason: string }> }> {
    throw NOT_IMPLEMENTED;
  }

  async acceptInvitation(_code: string): Promise<Member> {
    throw NOT_IMPLEMENTED;
  }

  async declineInvitation(_code: string): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async leave(_groupId: GroupId): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async kick(_groupId: GroupId, _userId: UserId, _opts?: { reason?: string }): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  // ------ Real-time ------

  subscribe(_groupId: GroupId, _handler: (event: JunjoEvent) => void): { close: () => void } {
    throw NOT_IMPLEMENTED;
  }

  // ------ Group relationships ------

  async setRelationship(
    _groupAId: GroupId,
    _groupBId: GroupId,
    _type: GroupRelationshipType,
    _opts?: { mutual?: boolean },
  ): Promise<GroupRelationship> {
    throw NOT_IMPLEMENTED;
  }

  async clearRelationship(
    _groupAId: GroupId,
    _groupBId: GroupId,
    _opts?: { mutual?: boolean },
  ): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async getRelationship(_groupAId: GroupId, _groupBId: GroupId): Promise<GroupRelationship | null> {
    throw NOT_IMPLEMENTED;
  }

  async listRelationships(_groupId: GroupId): Promise<GroupRelationship[]> {
    throw NOT_IMPLEMENTED;
  }

  // ------ Sub-groups / alliances ------

  async setParent(_groupId: GroupId, _parentGroupId: GroupId | null): Promise<void> {
    throw NOT_IMPLEMENTED;
  }

  async listChildren(_groupId: GroupId): Promise<Group[]> {
    throw NOT_IMPLEMENTED;
  }
}
