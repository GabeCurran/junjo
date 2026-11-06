import type { PermissionContext } from "@junjo.io/shared";
import type { GroupMember, MemberPermissionOverride, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import type { Db } from "../db.js";
import { Errors } from "../errors.js";
import { findJunjoUserId, renderPeople } from "../identity.js";
import { rowContextField } from "../permissionContext.js";
import { setEtag } from "../versions.js";
import { listMembersForUserQuery } from "./members.schema.js";

// `listForUser` has no pagination wrapper; this caps the bare-array
// response. A user with more memberships in a single game would need a
// paginated rewrite.
export const LIST_FOR_USER_HARD_CAP = 1000;

export async function loadMemberRoleIds(client: Db, groupMemberId: string): Promise<string[]> {
  const rows = await client.memberRole.findMany({
    where: { groupMemberId },
    select: { roleId: true },
  });
  return rows.map((r) => r.roleId);
}

// Avoids an N+1 query per page. Returns `Map<groupMemberId, roleId[]>`;
// callers fall back to `[]` for members with no roles.
export async function batchLoadMemberRoleIds(
  client: Db,
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
  displayName: string | null;
}

// Wire `userId` is the rendered external id (see `renderUserIds`), never
// the id the request happened to name the person by; `displayName` is
// the person-level name (see `renderPeople`).
export function serializeMember(
  member: GroupMember,
  externalUserId: string,
  roleIds: string[] = [],
  displayName: string | null = null,
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
    version: member.version,
    displayName,
  };
}

// `serializeMember` for a member the caller resolved from `requestedId`,
// rendering the id and display name for the current request.
export async function serializeMemberFor(
  client: Db,
  gameId: string,
  member: GroupMember,
  requestedId: string,
  roleIds: string[] = [],
): Promise<WireMember> {
  const who = (await renderPeople(client, gameId, [member.junjoUserId])).get(member.junjoUserId);
  return serializeMember(member, who?.userId ?? requestedId, roleIds, who?.displayName ?? null);
}

export interface WireMemberPermissionOverride {
  groupId: string;
  userId: string;
  permission: string;
  grant: boolean;
  // Absent for a global override.
  context?: PermissionContext;
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
    ...rowContextField(override),
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

    const who = (await renderPeople(prisma, gameId, [member.junjoUserId])).get(member.junjoUserId);
    if (!who) throw Errors.notFound("member");

    const roleIds = await loadMemberRoleIds(prisma, member.id);
    setEtag(c, member.version);
    return c.json(serializeMember(member, who.userId, roleIds, who.displayName));
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

    const who = (await renderPeople(prisma, gameId, [junjoUserId])).get(junjoUserId);
    const shownId = who?.userId ?? externalUserId;
    const displayName = who?.displayName ?? null;
    return c.json(
      members.map((m) => serializeMember(m, shownId, roleMap.get(m.id) ?? [], displayName)),
    );
  };
}
