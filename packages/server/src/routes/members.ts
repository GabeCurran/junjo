import type { GroupMember, Prisma, PrismaClient } from "@prisma/client";

type MembersClient = PrismaClient | Prisma.TransactionClient;

// Loads the role ids for a member. Centralized so the leave / kick / get
// paths emit the same wire shape; Phase 3.2 (role assignment) will add
// the writers that populate `MemberRole`. Until then this query returns
// an empty array.
export async function loadMemberRoleIds(
  client: MembersClient,
  groupMemberId: string,
): Promise<string[]> {
  const rows = await client.memberRole.findMany({
    where: { groupMemberId },
    select: { roleId: true },
  });
  return rows.map((r) => r.roleId);
}

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

// Serializes a `GroupMember` row to the wire format. The `userId` on the
// wire is the dev's external user id (the same value the SDK passed in),
// not the internal `junjoUserId`; the route is responsible for supplying
// it (looked up via ExternalIdentity, or threaded through from the
// request when the route already has it on hand). Phase 2.6's list and
// get-member routes will batch-load externalUserIds; Phase 2.4's accept
// flow has the externalUserId directly from the request body.
export function serializeMember(
  member: GroupMember,
  externalUserId: string,
  roleIds: string[] = [],
): WireMember {
  return {
    id: member.id,
    groupId: member.groupId,
    userId: externalUserId,
    status: member.status,
    roles: roleIds,
    metadata: (member.metadata ?? {}) as Record<string, unknown>,
    notesPublic: member.notesPublic,
    notesPrivate: member.notesPrivate,
    joinedAt: member.joinedAt.toISOString(),
  };
}
