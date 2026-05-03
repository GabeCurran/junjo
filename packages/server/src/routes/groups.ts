import type {
  GameId,
  GroupDeletedEvent,
  GroupId,
  GroupRelationshipChangedEvent,
  GroupUpdatedEvent,
  MemberInvitedEvent,
  MemberLeftEvent,
  RoleChangedEvent,
  RoleCreatedEvent,
  RoleId,
  UserId,
} from "@junjo/shared";
import type { Group, GroupRelationship, Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import {
  dispatchEvent,
  toPublicGroup,
  toPublicGroupRelationship,
  toPublicInvitation,
  toPublicMember,
  toPublicRole,
} from "../events.js";
import { findJunjoUserId } from "../identity.js";
import { permissionCache } from "../permissionCache.js";
import { SOFT_DELETE_RETENTION_DAYS } from "../softDelete.js";
import { listAuditForGroup } from "./audit.js";
import {
  MAX_PARENT_DEPTH,
  bulkInviteQuery,
  clearRelationshipQuery,
  createGroupBody,
  kickMemberBody,
  leaveGroupBody,
  listGroupsQuery,
  setParentBody,
  setRelationshipBody,
  updateGroupBody,
} from "./groups.schema.js";
import { generateInvitationCode, parseDurationMs, serializeInvitation } from "./invitations.js";
import { createInvitationBody, listInvitationsQuery } from "./invitations.schema.js";
import {
  batchLoadExternalUserIds,
  batchLoadMemberRoleIds,
  loadMemberRoleIds,
  serializeMember,
  serializeMemberPermissionOverride,
} from "./members.js";
import { listMembersQuery, overridePermissionBody, updateMemberBody } from "./members.schema.js";
import { serializeGroupRelationship } from "./relationships.js";
import { batchLoadRolePermissionKeys, serializeRole } from "./roles.js";
import { PERMISSION_KEY_MAX_LENGTH, createRoleBody } from "./roles.schema.js";

// `BULK_INVITE_USERID_MAX_LENGTH` is sized for Clerk / Supabase / Roblox
// user-id-as-string formats.
export const BULK_INVITE_MAX_ROWS = 1000;
export const BULK_INVITE_USERID_MAX_LENGTH = 255;

interface BulkInviteRow {
  row: number;
  userId: string;
}

interface BulkInviteError {
  row: number;
  reason: string;
}

interface ParsedBulkBody {
  rows: BulkInviteRow[];
  errors: BulkInviteError[];
}

// Row numbers count every source line (including empties) and are
// 1-indexed so the dev can map errors back to their original spreadsheet.
function parseBulkInviteBody(text: string): ParsedBulkBody {
  const rows: BulkInviteRow[] = [];
  const errors: BulkInviteError[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const lineRaw = lines[i] ?? "";
    const userId = lineRaw.trim();
    const rowNumber = i + 1;
    if (userId.length === 0) continue;
    if (userId.length > BULK_INVITE_USERID_MAX_LENGTH) {
      errors.push({
        row: rowNumber,
        reason: `userId exceeds ${BULK_INVITE_USERID_MAX_LENGTH} characters`,
      });
      continue;
    }
    rows.push({ row: rowNumber, userId });
  }
  return { rows, errors };
}

interface WireGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  softDeletedAt: string | null;
}

export function serializeGroup(group: Group, memberCount: number): WireGroup {
  return {
    id: group.id,
    gameId: group.gameId,
    kind: group.kind,
    name: group.name,
    visibility: group.visibility,
    metadata: (group.metadata ?? {}) as Record<string, unknown>,
    defaultRoleId: group.defaultRoleId,
    parentGroupId: group.parentGroupId,
    memberCount,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    softDeletedAt: group.softDeletedAt ? group.softDeletedAt.toISOString() : null,
  };
}

export function groupsRouter(prisma: PrismaClient, hub: EventHub): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    const parsed = listGroupsQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      gameId: c.req.query("gameId"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, gameId: filterGameId } = parsed.data;
    if (filterGameId !== undefined && filterGameId !== gameId) {
      throw Errors.badRequest("gameId must match the calling game");
    }

    let cursorRow: { id: string; createdAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.group.findFirst({
        where: { id: cursor, gameId },
        select: { id: true, createdAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const where: Prisma.GroupWhereInput = {
      gameId,
      softDeletedAt: null,
      ...(cursorRow
        ? {
            OR: [
              { createdAt: { lt: cursorRow.createdAt } },
              { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
            ],
          }
        : {}),
    };

    const groups = await prisma.group.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = groups.length > limit;
    const sliced = hasMore ? groups.slice(0, limit) : groups;

    const counts =
      sliced.length === 0
        ? []
        : await prisma.groupMember.groupBy({
            by: ["groupId"],
            where: { groupId: { in: sliced.map((g) => g.id) }, status: "active" },
            _count: { _all: true },
          });
    const countMap = new Map(counts.map((c) => [c.groupId, c._count._all]));

    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return c.json({
      items: sliced.map((g) => serializeGroup(g, countMap.get(g.id) ?? 0)),
      nextCursor,
    });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");
    const memberCount = await prisma.groupMember.count({
      where: { groupId: group.id, status: "active" },
    });
    return c.json(serializeGroup(group, memberCount));
  });

  r.post("/", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = createGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;
    const gameId = c.var.gameId;

    const metadataInput = (body.metadata ?? {}) as Prisma.InputJsonValue;

    const group = await prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          gameId,
          kind: body.kind,
          name: body.name,
          visibility: body.visibility ?? "invite-only",
          metadata: metadataInput,
          defaultRoleId: body.defaultRoleId,
        },
      });
      await tx.auditEntry.create({
        data: {
          groupId: created.id,
          actorUserId: null,
          action: "group.created",
          targetId: created.id,
          payload: {
            kind: created.kind,
            name: created.name,
            visibility: created.visibility,
            metadata: metadataInput,
            defaultRoleId: created.defaultRoleId,
          } as Prisma.InputJsonValue,
        },
      });
      return created;
    });

    return c.json(serializeGroup(group, 0), 201);
  });

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = updateGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.group.findFirst({
        where: { id, gameId, softDeletedAt: null },
      });
      if (!existing) throw Errors.notFound("group");

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.GroupUpdateInput = {};

      if (body.name !== undefined && body.name !== existing.name) {
        before.name = existing.name;
        after.name = body.name;
        data.name = body.name;
      }
      if (body.visibility !== undefined && body.visibility !== existing.visibility) {
        before.visibility = existing.visibility;
        after.visibility = body.visibility;
        data.visibility = body.visibility;
      }
      if (body.metadata !== undefined) {
        before.metadata = (existing.metadata ?? {}) as Prisma.InputJsonValue;
        after.metadata = body.metadata;
        data.metadata = body.metadata as Prisma.InputJsonValue;
      }
      if (body.defaultRoleId !== undefined && body.defaultRoleId !== existing.defaultRoleId) {
        before.defaultRoleId = existing.defaultRoleId;
        after.defaultRoleId = body.defaultRoleId;
        data.defaultRoleId = body.defaultRoleId;
      }

      if (Object.keys(data).length === 0) {
        return { row: existing, changed: false };
      }

      const result = await tx.group.update({
        where: { id: existing.id },
        data,
      });

      await tx.auditEntry.create({
        data: {
          groupId: result.id,
          actorUserId: null,
          action: "group.updated",
          targetId: result.id,
          payload: { before, after } as Prisma.InputJsonValue,
        },
      });

      return { row: result, changed: true };
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.row.id, status: "active" },
    });
    if (updated.changed) {
      await dispatchEvent<GroupUpdatedEvent>(prisma, hub, {
        type: "group.updated",
        gameId: gameId as GameId,
        groupId: updated.row.id as GroupId,
        group: toPublicGroup(updated.row, memberCount),
      });
    }
    return c.json(serializeGroup(updated.row, memberCount));
  });

  r.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const hard = c.req.query("hard") === "true";

    const existing = await prisma.group.findFirst({
      where: { id, gameId },
    });
    if (!existing) throw Errors.notFound("group");

    if (hard) {
      await prisma.group.delete({ where: { id: existing.id } });
      await dispatchEvent<GroupDeletedEvent>(prisma, hub, {
        type: "group.deleted",
        gameId: existing.gameId as GameId,
        groupId: existing.id as GroupId,
      });
      return c.body(null, 204);
    }

    if (existing.softDeletedAt) {
      const memberCount = await prisma.groupMember.count({
        where: { groupId: existing.id, status: "active" },
      });
      return c.json(serializeGroup(existing, memberCount));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.group.update({
        where: { id: existing.id },
        data: { softDeletedAt: now },
      });
      await tx.auditEntry.create({
        data: {
          groupId: result.id,
          actorUserId: null,
          action: "group.deleted",
          targetId: result.id,
          payload: {
            kind: "soft",
            softDeletedAt: now.toISOString(),
            retentionDays: SOFT_DELETE_RETENTION_DAYS,
          } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.id, status: "active" },
    });
    await dispatchEvent<GroupDeletedEvent>(prisma, hub, {
      type: "group.deleted",
      gameId: updated.gameId as GameId,
      groupId: updated.id as GroupId,
    });
    return c.json(serializeGroup(updated, memberCount));
  });

  r.post("/:id/restore", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const existing = await prisma.group.findFirst({
      where: { id, gameId },
    });
    if (!existing) throw Errors.notFound("group");

    if (!existing.softDeletedAt) {
      const memberCount = await prisma.groupMember.count({
        where: { groupId: existing.id, status: "active" },
      });
      return c.json(serializeGroup(existing, memberCount));
    }

    const cutoff = new Date(Date.now() - SOFT_DELETE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    if (existing.softDeletedAt < cutoff) {
      throw Errors.restoreWindowExpired(
        `restore window of ${SOFT_DELETE_RETENTION_DAYS} days has expired`,
      );
    }

    const previousSoftDeletedAt = existing.softDeletedAt.toISOString();
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.group.update({
        where: { id: existing.id },
        data: { softDeletedAt: null },
      });
      await tx.auditEntry.create({
        data: {
          groupId: result.id,
          actorUserId: null,
          action: "group.restored",
          targetId: result.id,
          payload: { previousSoftDeletedAt } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.id, status: "active" },
    });
    await dispatchEvent<GroupUpdatedEvent>(prisma, hub, {
      type: "group.updated",
      gameId: updated.gameId as GameId,
      groupId: updated.id as GroupId,
      group: toPublicGroup(updated, memberCount),
    });
    return c.json(serializeGroup(updated, memberCount));
  });

  r.post("/:id/invitations", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = createInvitationBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    let expiresAt: Date | null = null;
    if (body.expiresIn !== undefined) {
      const ms = parseDurationMs(body.expiresIn);
      if (ms === null) throw Errors.badRequest("expiresIn must be a positive duration");
      expiresAt = new Date(Date.now() + ms);
    }

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const targetUserId = body.targetUserId ?? null;
    const roleId = body.roleId ?? null;

    const invitation = await prisma.$transaction(async (tx) => {
      const created = await tx.invitation.create({
        data: {
          groupId: group.id,
          code: generateInvitationCode(),
          roleId,
          targetUserId,
          createdByUserId: null,
          expiresAt,
        },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "member.invited",
          targetId: targetUserId,
          payload: {
            invitationId: created.id,
            code: created.code,
            targetUserId,
            roleId,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
          } as Prisma.InputJsonValue,
        },
      });
      return created;
    });

    await dispatchEvent<MemberInvitedEvent>(prisma, hub, {
      type: "member.invited",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      invitation: toPublicInvitation(invitation),
    });
    return c.json(serializeInvitation(invitation), 201);
  });

  r.get("/:id/invitations", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const parsed = listInvitationsQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      includeExpired: c.req.query("includeExpired"),
      includeUsed: c.req.query("includeUsed"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, includeExpired, includeUsed } = parsed.data;

    let cursorRow: { id: string; createdAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.invitation.findFirst({
        where: { id: cursor, groupId: group.id },
        select: { id: true, createdAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const now = new Date();
    const conditions: Prisma.InvitationWhereInput[] = [];
    if (!includeUsed) conditions.push({ usedAt: null });
    if (!includeExpired) {
      conditions.push({ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] });
    }
    if (cursorRow) {
      conditions.push({
        OR: [
          { createdAt: { lt: cursorRow.createdAt } },
          { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
        ],
      });
    }

    const where: Prisma.InvitationWhereInput = {
      groupId: group.id,
      ...(conditions.length > 0 ? { AND: conditions } : {}),
    };

    const invitations = await prisma.invitation.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = invitations.length > limit;
    const sliced = hasMore ? invitations.slice(0, limit) : invitations;
    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return c.json({
      items: sliced.map(serializeInvitation),
      nextCursor,
    });
  });

  // Returns rows in every status; the caller filters client-side. A
  // future `?status=` filter is additive.
  r.get("/:id/members", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const parsed = listMembersQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor } = parsed.data;

    let cursorRow: { id: string; joinedAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.groupMember.findFirst({
        where: { id: cursor, groupId: group.id },
        select: { id: true, joinedAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const where: Prisma.GroupMemberWhereInput = {
      groupId: group.id,
      ...(cursorRow
        ? {
            OR: [
              { joinedAt: { lt: cursorRow.joinedAt } },
              { joinedAt: cursorRow.joinedAt, id: { lt: cursorRow.id } },
            ],
          }
        : {}),
    };

    const members = await prisma.groupMember.findMany({
      where,
      orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = members.length > limit;
    const sliced = hasMore ? members.slice(0, limit) : members;

    const idMap = await batchLoadExternalUserIds(
      prisma,
      gameId,
      sliced.map((m) => m.junjoUserId),
    );
    const roleMap = await batchLoadMemberRoleIds(
      prisma,
      sliced.map((m) => m.id),
    );

    const items = [];
    for (const m of sliced) {
      const externalUserId = idMap.get(m.junjoUserId);
      if (!externalUserId) continue;
      items.push(serializeMember(m, externalUserId, roleMap.get(m.id) ?? []));
    }

    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return c.json({ items, nextCursor });
  });

  // Cross-game / soft-deleted / missing-identity / missing-member all
  // collapse to 404 to avoid existence leak.
  r.get("/:id/members/:userId", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");

    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const roleIds = await loadMemberRoleIds(prisma, member.id);
    return c.json(serializeMember(member, userId, roleIds));
  });

  // Idempotent on already-left / already-kicked (no audit, no event).
  r.post("/:id/leave", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = leaveGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { userId } = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    if (member.status !== "active") {
      const roleIds = await loadMemberRoleIds(prisma, member.id);
      return c.json(serializeMember(member, userId, roleIds));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "left", leftAt: new Date() },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: junjoUserId,
          action: "member.left",
          targetId: userId,
          payload: {
            memberId: result.id,
            reason: "left",
          } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const roleIds = await loadMemberRoleIds(prisma, updated.id);
    await dispatchEvent<MemberLeftEvent>(prisma, hub, {
      type: "member.left",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      userId: userId as UserId,
      reason: "left",
    });
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // Idempotent on already-kicked / already-left. `actorUserId` is null
  // in V1 (no auth-adapter actor wired); the dev's backend is the
  // trusted layer behind the API key.
  r.post("/:id/members/:userId/kick", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = kickMemberBody.safeParse(json ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const reasonValue = parsed.data.reason ?? null;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    if (member.status !== "active") {
      const roleIds = await loadMemberRoleIds(prisma, member.id);
      return c.json(serializeMember(member, userId, roleIds));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "kicked", leftAt: new Date() },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "member.kicked",
          targetId: userId,
          payload: {
            memberId: result.id,
            reason: reasonValue,
          } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const roleIds = await loadMemberRoleIds(prisma, updated.id);
    await dispatchEvent<MemberLeftEvent>(prisma, hub, {
      type: "member.left",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      userId: userId as UserId,
      reason: "kicked",
    });
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // Metadata replaces wholesale and is treated as a change whenever
  // supplied (jsonb may not preserve key order, so a deep-equal check
  // would be unreliable). Notes are diffed per-field; a notes-only PATCH
  // that matches stored values writes no audit entries.
  r.patch("/:id/members/:userId", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = updateMemberBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const data: Prisma.GroupMemberUpdateInput = {};
    const metadataChanged = body.metadata !== undefined;
    if (metadataChanged) {
      data.metadata = body.metadata as Prisma.InputJsonValue;
    }

    const notesBefore: Record<string, string | null> = {};
    const notesAfter: Record<string, string | null> = {};
    if (body.notesPublic !== undefined && body.notesPublic !== member.notesPublic) {
      notesBefore.notesPublic = member.notesPublic;
      notesAfter.notesPublic = body.notesPublic;
      data.notesPublic = body.notesPublic;
    }
    if (body.notesPrivate !== undefined && body.notesPrivate !== member.notesPrivate) {
      notesBefore.notesPrivate = member.notesPrivate;
      notesAfter.notesPrivate = body.notesPrivate;
      data.notesPrivate = body.notesPrivate;
    }
    const notesChanged = Object.keys(notesAfter).length > 0;

    if (Object.keys(data).length === 0) {
      const roleIds = await loadMemberRoleIds(prisma, member.id);
      return c.json(serializeMember(member, userId, roleIds));
    }

    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data,
      });
      if (metadataChanged) {
        await tx.auditEntry.create({
          data: {
            groupId: group.id,
            actorUserId: null,
            action: "member.metadata.updated",
            targetId: userId,
            payload: {
              before: { metadata: (member.metadata ?? {}) as Prisma.InputJsonValue },
              after: { metadata: body.metadata as Prisma.InputJsonValue },
            } as Prisma.InputJsonValue,
          },
        });
      }
      if (notesChanged) {
        await tx.auditEntry.create({
          data: {
            groupId: group.id,
            actorUserId: null,
            action: "member.notes.updated",
            targetId: userId,
            payload: {
              before: notesBefore,
              after: notesAfter,
            } as Prisma.InputJsonValue,
          },
        });
      }
      return result;
    });

    const roleIds = await loadMemberRoleIds(prisma, updated.id);
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // Existence checks (already-active, already-pending) batch in one
  // pass; invitation creates and audit entries write inside one
  // transaction so a partial-failure case rolls back cleanly.
  r.post("/:id/bulk-invite", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const parsedQuery = bulkInviteQuery.safeParse({ roleId: c.req.query("roleId") });
    if (!parsedQuery.success) {
      const issues = parsedQuery.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const roleId = parsedQuery.data.roleId ?? null;

    const text = await c.req.text().catch(() => "");
    const { rows, errors } = parseBulkInviteBody(text);

    if (rows.length + errors.length > BULK_INVITE_MAX_ROWS) {
      throw Errors.badRequest(`bulk-invite is limited to ${BULK_INVITE_MAX_ROWS} rows per request`);
    }

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const errorList: BulkInviteError[] = [...errors];

    if (rows.length === 0) {
      return c.json({ invited: 0, skipped: 0, errors: errorList });
    }

    const uniqueUserIds = Array.from(new Set(rows.map((r) => r.userId)));

    const identities = await prisma.externalIdentity.findMany({
      where: { gameId, externalUserId: { in: uniqueUserIds } },
      select: { junjoUserId: true, externalUserId: true },
    });
    const externalToJunjo = new Map(identities.map((x) => [x.externalUserId, x.junjoUserId]));

    const junjoUserIds = identities.map((x) => x.junjoUserId);
    const activeMembers =
      junjoUserIds.length === 0
        ? []
        : await prisma.groupMember.findMany({
            where: { groupId: group.id, junjoUserId: { in: junjoUserIds }, status: "active" },
            select: { junjoUserId: true },
          });
    const activeJunjoUserIds = new Set(activeMembers.map((m) => m.junjoUserId));

    const now = new Date();
    const pendingInvites = await prisma.invitation.findMany({
      where: {
        groupId: group.id,
        targetUserId: { in: uniqueUserIds },
        usedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { targetUserId: true },
    });
    const pendingTargets = new Set(
      pendingInvites.map((p) => p.targetUserId).filter((x): x is string => x !== null),
    );

    const seenInBatch = new Set<string>();
    const toCreate: BulkInviteRow[] = [];
    let skipped = 0;
    for (const row of rows) {
      if (seenInBatch.has(row.userId)) {
        skipped++;
        continue;
      }
      seenInBatch.add(row.userId);
      const junjoUserId = externalToJunjo.get(row.userId);
      if (junjoUserId && activeJunjoUserIds.has(junjoUserId)) {
        skipped++;
        continue;
      }
      if (pendingTargets.has(row.userId)) {
        skipped++;
        continue;
      }
      toCreate.push(row);
    }

    if (toCreate.length === 0) {
      return c.json({ invited: 0, skipped, errors: errorList });
    }

    const createdInvitations = await prisma.$transaction(async (tx) => {
      const all: Awaited<ReturnType<typeof tx.invitation.create>>[] = [];
      for (const row of toCreate) {
        const created = await tx.invitation.create({
          data: {
            groupId: group.id,
            code: generateInvitationCode(),
            roleId,
            targetUserId: row.userId,
            createdByUserId: null,
            expiresAt: null,
          },
        });
        all.push(created);
        await tx.auditEntry.create({
          data: {
            groupId: group.id,
            actorUserId: null,
            action: "member.invited",
            targetId: row.userId,
            payload: {
              invitationId: created.id,
              code: created.code,
              targetUserId: row.userId,
              roleId,
              expiresAt: null,
              source: "bulk-invite",
            } as Prisma.InputJsonValue,
          },
        });
      }
      return all;
    });

    for (const inv of createdInvitations) {
      await dispatchEvent<MemberInvitedEvent>(prisma, hub, {
        type: "member.invited",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        invitation: toPublicInvitation(inv),
      });
    }

    return c.json({ invited: toCreate.length, skipped, errors: errorList });
  });

  // Idempotent on already-assigned. Cross-group assignment returns 400
  // `role_group_mismatch`; missing role returns 404.
  r.post("/:id/members/:userId/roles/:roleId", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const roleId = c.req.param("roleId");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const role = await prisma.role.findUnique({
      where: { id: roleId },
      select: { id: true, groupId: true },
    });
    if (!role) throw Errors.notFound("role");
    if (role.groupId !== group.id) throw Errors.roleGroupMismatch();

    const existing = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId: role.id } },
    });
    if (existing) {
      const roleIds = await loadMemberRoleIds(prisma, member.id);
      return c.json(serializeMember(member, userId, roleIds));
    }

    await prisma.$transaction(async (tx) => {
      await tx.memberRole.create({
        data: { groupMemberId: member.id, roleId: role.id },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "role.assigned",
          targetId: userId,
          payload: {
            memberId: member.id,
            roleId: role.id,
          } as Prisma.InputJsonValue,
        },
      });
    });
    permissionCache.invalidateGroup(group.id);

    await dispatchEvent<RoleChangedEvent>(prisma, hub, {
      type: "role.changed",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      userId: userId as UserId,
      added: [role.id as RoleId],
      removed: [],
    });

    const roleIds = await loadMemberRoleIds(prisma, member.id);
    return c.json(serializeMember(member, userId, roleIds));
  });

  // Idempotent on not-assigned, regardless of whether the role exists
  // in another group, is unassigned, or does not exist at all.
  r.delete("/:id/members/:userId/roles/:roleId", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const roleId = c.req.param("roleId");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const existing = await prisma.memberRole.findUnique({
      where: { groupMemberId_roleId: { groupMemberId: member.id, roleId } },
    });
    if (!existing) {
      const roleIds = await loadMemberRoleIds(prisma, member.id);
      return c.json(serializeMember(member, userId, roleIds));
    }

    await prisma.$transaction(async (tx) => {
      await tx.memberRole.delete({
        where: { groupMemberId_roleId: { groupMemberId: member.id, roleId } },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "role.unassigned",
          targetId: userId,
          payload: {
            memberId: member.id,
            roleId,
          } as Prisma.InputJsonValue,
        },
      });
    });
    permissionCache.invalidateGroup(group.id);

    await dispatchEvent<RoleChangedEvent>(prisma, hub, {
      type: "role.changed",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      userId: userId as UserId,
      added: [],
      removed: [roleId as RoleId],
    });

    const roleIds = await loadMemberRoleIds(prisma, member.id);
    return c.json(serializeMember(member, userId, roleIds));
  });

  // An override (in either direction) wins over any role-derived grant.
  // Idempotent on matching `grant`. First sight of a key auto-registers
  // `PermissionDef`.
  r.post("/:id/members/:userId/permissions/:permission", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const permission = c.req.param("permission");
    const gameId = c.var.gameId;

    if (!permission) throw Errors.badRequest("permission must not be empty");
    if (permission.length > PERMISSION_KEY_MAX_LENGTH) {
      throw Errors.badRequest(`permission must be at most ${PERMISSION_KEY_MAX_LENGTH} characters`);
    }

    const json = await c.req.json().catch(() => null);
    const parsed = overridePermissionBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { grant } = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("member");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const existing = await prisma.memberPermissionOverride.findUnique({
      where: {
        groupMemberId_permissionKey: {
          groupMemberId: member.id,
          permissionKey: permission,
        },
      },
    });
    if (existing && existing.grant === grant) {
      return c.json(serializeMemberPermissionOverride(existing, group.id, userId));
    }

    const result = await prisma.$transaction(async (tx) => {
      await tx.permissionDef.upsert({
        where: { gameId_key: { gameId, key: permission } },
        create: { gameId, key: permission },
        update: {},
      });
      const upserted = await tx.memberPermissionOverride.upsert({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: permission,
          },
        },
        create: {
          groupMemberId: member.id,
          permissionKey: permission,
          grant,
          setByUserId: null,
        },
        update: { grant, setAt: new Date() },
      });
      const auditPayload: Record<string, unknown> = {
        memberId: member.id,
        permission,
        grant,
      };
      if (existing) auditPayload.before = { grant: existing.grant };
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "permission.override.set",
          targetId: userId,
          payload: auditPayload as Prisma.InputJsonValue,
        },
      });
      return upserted;
    });
    permissionCache.invalidateGroup(group.id);

    return c.json(serializeMemberPermissionOverride(result, group.id, userId));
  });

  // Idempotent on missing override. PermissionDef is preserved (catalog
  // is monotonic per game).
  r.delete("/:id/members/:userId/permissions/:permission", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const permission = c.req.param("permission");
    const gameId = c.var.gameId;

    if (!permission) throw Errors.badRequest("permission must not be empty");

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("member");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const existing = await prisma.memberPermissionOverride.findUnique({
      where: {
        groupMemberId_permissionKey: {
          groupMemberId: member.id,
          permissionKey: permission,
        },
      },
    });
    if (!existing) return c.body(null, 204);

    await prisma.$transaction(async (tx) => {
      await tx.memberPermissionOverride.delete({
        where: {
          groupMemberId_permissionKey: {
            groupMemberId: member.id,
            permissionKey: permission,
          },
        },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "permission.override.cleared",
          targetId: userId,
          payload: {
            memberId: member.id,
            permission,
            grant: existing.grant,
          } as Prisma.InputJsonValue,
        },
      });
    });
    permissionCache.invalidateGroup(group.id);

    return c.body(null, 204);
  });

  r.get("/:id/members/:userId/permissions", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("member");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("member");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member) throw Errors.notFound("member");

    const overrides = await prisma.memberPermissionOverride.findMany({
      where: { groupMemberId: member.id },
      orderBy: { permissionKey: "asc" },
    });

    return c.json(overrides.map((o) => serializeMemberPermissionOverride(o, group.id, userId)));
  });

  // `isDefault` is a per-role tag; multiple roles can carry it. The
  // canonical default for a group lives on `Group.defaultRoleId`, set
  // via `groups.update`.
  r.post("/:id/roles", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = createRoleBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const duplicate = await prisma.role.findUnique({
      where: { groupId_name: { groupId: group.id, name: body.name } },
      select: { id: true },
    });
    if (duplicate) throw Errors.roleNameTaken();

    const role = await prisma.$transaction(async (tx) => {
      const created = await tx.role.create({
        data: {
          groupId: group.id,
          name: body.name,
          priority: body.priority,
          color: body.color ?? null,
          isDefault: body.isDefault ?? false,
        },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: "role.created",
          targetId: created.id,
          payload: {
            name: created.name,
            priority: created.priority,
            color: created.color,
            isDefault: created.isDefault,
          } as Prisma.InputJsonValue,
        },
      });
      return created;
    });

    await dispatchEvent<RoleCreatedEvent>(prisma, hub, {
      type: "role.created",
      gameId: gameId as GameId,
      groupId: group.id as GroupId,
      role: toPublicRole(role, []),
    });
    return c.json(serializeRole(role, []), 201);
  });

  r.get("/:id/roles", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const roles = await prisma.role.findMany({
      where: { groupId: group.id },
      orderBy: [{ priority: "desc" }, { id: "desc" }],
    });
    if (roles.length === 0) return c.json([]);

    const permissionMap = await batchLoadRolePermissionKeys(
      prisma,
      roles.map((r2) => r2.id),
    );
    return c.json(roles.map((role) => serializeRole(role, permissionMap.get(role.id) ?? [])));
  });

  // `mutual: true` writes both directions in one transaction; the
  // response is always the A->B row (canonical "this group's stance").
  // Idempotent per direction. Audit entries land on the *origin* group's
  // log (so mutual writes can produce up to two entries).
  r.put("/:a/relationships/:b", async (c) => {
    const a = c.req.param("a");
    const b = c.req.param("b");
    const gameId = c.var.gameId;

    if (a === b) throw Errors.badRequest("groupAId and groupBId must differ");

    const json = await c.req.json().catch(() => null);
    const parsed = setRelationshipBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { type, mutual } = parsed.data;

    const groups = await prisma.group.findMany({
      where: { id: { in: [a, b] }, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (groups.length !== 2) throw Errors.notFound("group");

    const directions: Array<{ aId: string; bId: string }> = [{ aId: a, bId: b }];
    if (mutual) directions.push({ aId: b, bId: a });

    const result = await prisma.$transaction(async (tx) => {
      let primary: GroupRelationship | null = null;
      const changed: GroupRelationship[] = [];
      for (const dir of directions) {
        const existing = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
        });
        if (existing && existing.type === type) {
          if (dir.aId === a) primary = existing;
          continue;
        }

        const upserted = await tx.groupRelationship.upsert({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
          create: { groupAId: dir.aId, groupBId: dir.bId, type, setByUserId: null },
          update: { type, since: new Date() },
        });
        if (dir.aId === a) primary = upserted;
        changed.push(upserted);

        const auditPayload: Record<string, unknown> = {
          groupAId: dir.aId,
          groupBId: dir.bId,
          type,
          mutual: mutual === true,
        };
        if (existing) auditPayload.before = { type: existing.type };
        await tx.auditEntry.create({
          data: {
            groupId: dir.aId,
            actorUserId: null,
            action: "group.relationship.set",
            targetId: dir.bId,
            payload: auditPayload as Prisma.InputJsonValue,
          },
        });
      }
      if (!primary) {
        // Both directions no-op'd; reload the existing A->B row.
        const reloaded = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: a, groupBId: b } },
        });
        if (!reloaded) throw new Error("relationship row missing after no-op upsert");
        primary = reloaded;
      }
      return { primary, changed };
    });

    for (const rel of result.changed) {
      await dispatchEvent<GroupRelationshipChangedEvent>(prisma, hub, {
        type: "group.relationship.changed",
        gameId: gameId as GameId,
        groupId: rel.groupAId as GroupId,
        otherGroupId: rel.groupBId as GroupId,
        relationship: toPublicGroupRelationship(rel),
      });
    }

    return c.json(serializeGroupRelationship(result.primary));
  });

  // Idempotent on missing row. Returns 204 in every case so callers
  // need not branch on whether something was actually deleted.
  r.delete("/:a/relationships/:b", async (c) => {
    const a = c.req.param("a");
    const b = c.req.param("b");
    const gameId = c.var.gameId;

    const parsedQuery = clearRelationshipQuery.safeParse({ mutual: c.req.query("mutual") });
    if (!parsedQuery.success) {
      const issues = parsedQuery.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const mutual = parsedQuery.data.mutual === "true";

    if (a === b) throw Errors.badRequest("groupAId and groupBId must differ");

    const groups = await prisma.group.findMany({
      where: { id: { in: [a, b] }, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (groups.length !== 2) throw Errors.notFound("group");

    const directions: Array<{ aId: string; bId: string }> = [{ aId: a, bId: b }];
    if (mutual) directions.push({ aId: b, bId: a });

    const cleared = await prisma.$transaction(async (tx) => {
      const removed: Array<{ aId: string; bId: string }> = [];
      for (const dir of directions) {
        const existing = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
        });
        if (!existing) continue;

        await tx.groupRelationship.delete({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
        });
        await tx.auditEntry.create({
          data: {
            groupId: dir.aId,
            actorUserId: null,
            action: "group.relationship.cleared",
            targetId: dir.bId,
            payload: {
              groupAId: dir.aId,
              groupBId: dir.bId,
              type: existing.type,
              mutual,
            } as Prisma.InputJsonValue,
          },
        });
        removed.push({ aId: dir.aId, bId: dir.bId });
      }
      return removed;
    });

    for (const dir of cleared) {
      await dispatchEvent<GroupRelationshipChangedEvent>(prisma, hub, {
        type: "group.relationship.changed",
        gameId: gameId as GameId,
        groupId: dir.aId as GroupId,
        otherGroupId: dir.bId as GroupId,
        relationship: null,
      });
    }

    return c.body(null, 204);
  });

  // Cross-game lookups collapse to 404 to avoid existence leak.
  r.get("/:a/relationships/:b", async (c) => {
    const a = c.req.param("a");
    const b = c.req.param("b");
    const gameId = c.var.gameId;

    if (a === b) throw Errors.notFound("relationship");

    const groups = await prisma.group.findMany({
      where: { id: { in: [a, b] }, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (groups.length !== 2) throw Errors.notFound("relationship");

    const rel = await prisma.groupRelationship.findUnique({
      where: { groupAId_groupBId: { groupAId: a, groupBId: b } },
    });
    if (!rel) throw Errors.notFound("relationship");

    return c.json(serializeGroupRelationship(rel));
  });

  // Returns the A-side ("outgoing stance") only. The B-side ("incoming")
  // would be a future `?direction=incoming` additive filter.
  r.get("/:a/relationships", async (c) => {
    const a = c.req.param("a");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id: a, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const rels = await prisma.groupRelationship.findMany({
      where: { groupAId: group.id },
      orderBy: { groupBId: "asc" },
    });

    return c.json(rels.map(serializeGroupRelationship));
  });

  // Cycle detection walks the candidate parent's ancestor chain bounded
  // at `MAX_PARENT_DEPTH`; self-parent and any cycle 400 `parent_cycle`.
  r.put("/:id/parent", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = setParentBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { parentGroupId } = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    if (parentGroupId !== null) {
      if (parentGroupId === group.id) throw Errors.parentCycle();

      const parent = await prisma.group.findFirst({
        where: { id: parentGroupId, gameId, softDeletedAt: null },
        select: { id: true, parentGroupId: true },
      });
      if (!parent) throw Errors.notFound("group");

      let cursor: { id: string; parentGroupId: string | null } | null = parent;
      let depth = 0;
      while (cursor && cursor.parentGroupId !== null && depth < MAX_PARENT_DEPTH) {
        if (cursor.parentGroupId === group.id) throw Errors.parentCycle();
        cursor = await prisma.group.findUnique({
          where: { id: cursor.parentGroupId },
          select: { id: true, parentGroupId: true },
        });
        depth++;
      }
    }

    if (group.parentGroupId === parentGroupId) {
      const memberCount = await prisma.groupMember.count({
        where: { groupId: group.id, status: "active" },
      });
      return c.json(serializeGroup(group, memberCount));
    }

    const previous = group.parentGroupId;
    const updated = await prisma.$transaction(async (tx) => {
      const result = await tx.group.update({
        where: { id: group.id },
        data: { parentGroupId },
      });
      await tx.auditEntry.create({
        data: {
          groupId: group.id,
          actorUserId: null,
          action: parentGroupId === null ? "group.parent.cleared" : "group.parent.set",
          targetId: parentGroupId,
          payload: {
            before: previous,
            after: parentGroupId,
          } as Prisma.InputJsonValue,
        },
      });
      return result;
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.id, status: "active" },
    });
    await dispatchEvent<GroupUpdatedEvent>(prisma, hub, {
      type: "group.updated",
      gameId: gameId as GameId,
      groupId: updated.id as GroupId,
      group: toPublicGroup(updated, memberCount),
    });
    return c.json(serializeGroup(updated, memberCount));
  });

  // Direct children only; grandchildren are NOT recursed.
  r.get("/:id/children", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const children = await prisma.group.findMany({
      where: { parentGroupId: group.id, gameId, softDeletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (children.length === 0) return c.json([]);

    const counts = await prisma.groupMember.groupBy({
      by: ["groupId"],
      where: { groupId: { in: children.map((g) => g.id) }, status: "active" },
      _count: { _all: true },
    });
    const countMap = new Map(counts.map((row) => [row.groupId, row._count._all]));

    return c.json(children.map((g) => serializeGroup(g, countMap.get(g.id) ?? 0)));
  });

  r.get("/:id/audit", async (c) => {
    const id = c.req.param("id");
    return listAuditForGroup(c, prisma, id);
  });

  return r;
}
