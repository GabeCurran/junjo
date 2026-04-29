import type { GroupMember, MemberPermissionOverride, Prisma, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { listMembersForUserQuery } from "./members.schema.js";

type MembersClient = PrismaClient | Prisma.TransactionClient;

// V1 cap on `listForUser` since it returns a bare array (no pagination).
// A user with more than this many memberships in a single game would
// require a paginated rewrite; document and revisit if it ever surfaces.
export const LIST_FOR_USER_HARD_CAP = 1000;

// Loads the role ids for a single member. Centralized so the leave / kick
// / get-member paths emit the same wire shape; Phase 3.2 (role assignment)
// will add the writers that populate `MemberRole`. Until then this query
// returns an empty array.
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

// Batched counterpart to `loadMemberRoleIds`. Used by the list endpoints
// to avoid an N+1 query per page. Returns a `Map<groupMemberId, roleId[]>`;
// callers fall back to `[]` for members with no roles.
export async function batchLoadMemberRoleIds(
  client: MembersClient,
  groupMemberIds: string[],
): Promise<Map<string, string[]>> {
  if (groupMemberIds.length === 0) return new Map();
  const rows = await client.memberRole.findMany({
    where: { groupMemberId: { in: groupMemberIds } },
    select: { groupMemberId: true, roleId: true },
  });
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const list = map.get(row.groupMemberId);
    if (list) list.push(row.roleId);
    else map.set(row.groupMemberId, [row.roleId]);
  }
  return map;
}

// Batched lookup from `junjoUserId -> externalUserId` for a single game.
// The list endpoints use this to map a page of GroupMember rows back to
// the dev-supplied user ids without an N+1 ExternalIdentity query.
export async function batchLoadExternalUserIds(
  client: MembersClient,
  gameId: string,
  junjoUserIds: string[],
): Promise<Map<string, string>> {
  if (junjoUserIds.length === 0) return new Map();
  const rows = await client.externalIdentity.findMany({
    where: { gameId, junjoUserId: { in: junjoUserIds } },
    select: { junjoUserId: true, externalUserId: true },
  });
  return new Map(rows.map((r) => [r.junjoUserId, r.externalUserId]));
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
// request when the route already has it on hand).
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

export interface WireMemberPermissionOverride {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  setAt: string;
  setBy: string | null;
}

// Serializes a `MemberPermissionOverride` row to the wire format. The
// route is responsible for threading the dev's external `userId` and
// the owning `groupId` through; the row itself stores `groupMemberId`
// and `permissionKey` (foreign keys), which are not what the wire uses.
// `setByExternalUserId` is the dev's external id of whoever set the
// override, looked up via `ExternalIdentity`; it is null in V1 since no
// auth-adapter actor is wired yet (parallels `Invitation.createdBy` and
// `AuditEntry.actorUserId`).
export function serializeMemberPermissionOverride(
  override: MemberPermissionOverride,
  groupId: string,
  externalUserId: string,
  setByExternalUserId: string | null = null,
): WireMemberPermissionOverride {
  return {
    groupId,
    userId: externalUserId,
    permission: override.permissionKey,
    grant: override.grant,
    setAt: override.setAt.toISOString(),
    setBy: setByExternalUserId,
  };
}

// Authed route handler: fetch a member by their `GroupMember.id`. Scoped
// to the calling game (a member whose group belongs to a different game
// returns 404 to avoid leaking existence). A soft-deleted group also
// 404s. Defensively 404s when the member's `junjoUser` has no
// `ExternalIdentity` row in this game (a data-integrity case that
// shouldn't happen via Junjo's own flows).
export function getMemberByIdHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const id = c.req.param("id");
    if (!id) throw Errors.notFound("member");
    const gameId = c.var.gameId;

    const member = await prisma.groupMember.findUnique({
      where: { id },
      include: { group: { select: { gameId: true, softDeletedAt: true } } },
    });
    if (!member) throw Errors.notFound("member");
    if (member.group.gameId !== gameId) throw Errors.notFound("member");
    if (member.group.softDeletedAt) throw Errors.notFound("member");

    const identity = await prisma.externalIdentity.findFirst({
      where: { gameId, junjoUserId: member.junjoUserId },
      select: { externalUserId: true },
    });
    if (!identity) throw Errors.notFound("member");

    const roleIds = await loadMemberRoleIds(prisma, member.id);
    return c.json(serializeMember(member, identity.externalUserId, roleIds));
  };
}

// Authed route handler: list every group a user is a member of within
// the calling game. Returns a bare array (no pagination wrapper) capped
// at `LIST_FOR_USER_HARD_CAP`. A user with no `ExternalIdentity` row
// for this game returns `[]` rather than 404; that distinguishes "user
// known but not in any groups" from "user we have never seen", which is
// the same answer for the consumer (zero memberships) and avoids a
// route-level existence leak. Soft-deleted groups are excluded from the
// result.
export function listMembersForUserHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const externalUserId = c.req.param("userId");
    if (!externalUserId) return c.json([] as WireMember[]);
    const gameId = c.var.gameId;

    const parsed = listMembersForUserQuery.safeParse({
      gameId: c.req.query("gameId"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    if (parsed.data.gameId !== undefined && parsed.data.gameId !== gameId) {
      throw Errors.badRequest("gameId must match the calling game");
    }

    const junjoUserId = await findJunjoUserId(prisma, gameId, externalUserId);
    if (!junjoUserId) return c.json([] as WireMember[]);

    const members = await prisma.groupMember.findMany({
      where: {
        junjoUserId,
        group: { gameId, softDeletedAt: null },
      },
      orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      take: LIST_FOR_USER_HARD_CAP,
    });
    if (members.length === 0) return c.json([] as WireMember[]);

    const roleMap = await batchLoadMemberRoleIds(
      prisma,
      members.map((m) => m.id),
    );

    return c.json(members.map((m) => serializeMember(m, externalUserId, roleMap.get(m.id) ?? [])));
  };
}
