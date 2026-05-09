import type { GroupMember, MemberPermissionOverride, Prisma, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { listMembersForUserQuery } from "./members.schema.js";

type MembersClient = PrismaClient | Prisma.TransactionClient;

// `listForUser` has no pagination wrapper; this caps the bare-array
// response. A user with more memberships in a single game would need a
// paginated rewrite.
export const LIST_FOR_USER_HARD_CAP = 1000;

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

// Avoids an N+1 query per page. Returns `Map<groupMemberId, roleId[]>`;
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

// Maps a page of GroupMember rows back to dev-supplied user ids without
// an N+1 ExternalIdentity query.
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
  bannedUntil: string | null;
}

// Wire `userId` is the dev's external id; the caller looks it up via
// ExternalIdentity (or threads it through from the request when on hand).
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
    bannedUntil: member.bannedUntil ? member.bannedUntil.toISOString() : null,
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

// `setByExternalUserId` is null in V1 (no auth-adapter actor wired);
// parallels `Invitation.createdBy` and `AuditEntry.actorUserId`.
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

// Cross-game / soft-deleted-group / missing-ExternalIdentity all collapse
// to 404 to avoid leaking existence across the gameId scope.
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

// Returns `[]` rather than 404 for a user with no ExternalIdentity row;
// "user known but in no groups" and "user never seen" both answer
// "zero memberships" without leaking existence.
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
