import type { GroupId, Member, MemberId, MemberStatus, RoleId, UserId } from "@junjo/shared";

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
