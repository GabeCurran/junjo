import type { Group, Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import { findJunjoUserId } from "../identity.js";
import { SOFT_DELETE_RETENTION_DAYS } from "../softDelete.js";
import {
  bulkInviteQuery,
  createGroupBody,
  kickMemberBody,
  leaveGroupBody,
  listGroupsQuery,
  updateGroupBody,
} from "./groups.schema.js";
import { generateInvitationCode, parseDurationMs, serializeInvitation } from "./invitations.js";
import { createInvitationBody, listInvitationsQuery } from "./invitations.schema.js";
import {
  batchLoadExternalUserIds,
  batchLoadMemberRoleIds,
  loadMemberRoleIds,
  serializeMember,
} from "./members.js";
import { listMembersQuery, updateMemberBody } from "./members.schema.js";

// `groups.bulkInvite` request limits. Each non-empty line in the body is
// one userId; lines beyond `BULK_INVITE_MAX_ROWS` (counting empty rows)
// trigger a 400. `BULK_INVITE_USERID_MAX_LENGTH` matches a comfortable
// upper bound for Clerk / Supabase / Roblox user-id-as-string formats.
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

// Parses the raw text body. One trimmed userId per line; empty lines are
// silently ignored. Lines whose trimmed userId exceeds the length cap are
// emitted as errors. Row numbers are 1-indexed (matching how a dev's
// spreadsheet view numbers them) and count every source line, including
// empties, so the dev can map errors back to the original input.
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
    memberCount,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    softDeletedAt: group.softDeletedAt ? group.softDeletedAt.toISOString() : null,
  };
}

export function groupsRouter(prisma: PrismaClient): Hono {
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
        return existing;
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

      return result;
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.id, status: "active" },
    });
    return c.json(serializeGroup(updated, memberCount));
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

  // List the members of a group (paginated). Returns rows in every
  // status; the caller filters client-side. Active-only is the common
  // case but historical rows (`left`, `kicked`) carry the audit story
  // and a future `?status=` filter can add it as an additive change.
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

  // Fetch a single member by the dev's external `userId`. Scoped to the
  // calling game; missing group / cross-game / soft-deleted-group / no
  // ExternalIdentity / no GroupMember all collapse to 404 (matches the
  // collapsed-existence pattern used by leave / kick).
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

  // The user identified by `userId` voluntarily leaves the group. Only
  // transitions an active member to "left"; non-active rows are returned
  // unchanged with no audit entry, so a leaver who is already-left or
  // already-kicked sees an idempotent 200 with their current state. A
  // user with no `ExternalIdentity` for this game collapses with the
  // "member row missing" case to 404 (existence is not leaked).
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
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // The dev's backend kicks a member out of the group. Only transitions
  // an active member to "kicked"; non-active rows are returned unchanged
  // with no audit entry. The optional `reason` lands on the audit
  // `payload`. `actorUserId` is null in V1 (no auth-adapter actor wired);
  // the kicker's identity is the dev's backend itself, which is the
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
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // Update member metadata and / or officer notes. Body is partial:
  // `{ metadata?, notesPublic?, notesPrivate? }`. An empty body returns
  // `400 bad_request`. Metadata replaces wholesale (no deep merge) and is
  // always treated as a change when supplied (jsonb storage may not
  // preserve key order, so a deep-equal check is unreliable; matches the
  // `groups.update` precedent). Notes fields are diffed per-field against
  // the stored row; a value equal to the stored one is a no-op for that
  // field. The route writes up to two audit entries in the same
  // transaction: `member.metadata.updated` when metadata is supplied, and
  // `member.notes.updated` when at least one notes field actually changed.
  // No audit entry is written for a fully no-op PATCH (notes-only PATCH
  // where every supplied notes field equals the stored value).
  // `actorUserId` is null in V1 (no auth-adapter actor wired); the dev's
  // backend is the trusted layer behind the API key.
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

  // Bulk-invite a list of users by external user id. The body is plain
  // text: one userId per trimmed, non-empty line. Empty lines are
  // ignored; lines with userIds longer than the cap are reported in
  // `errors`. Existence checks (already-active member, already-pending
  // invitation) run as batched lookups; the resulting invitation creates
  // and audit entries write inside one transaction so a partial-failure
  // case rolls back cleanly. The optional `roleId` query param is
  // forwarded to every created invitation.
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

    await prisma.$transaction(async (tx) => {
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
    });

    return c.json({ invited: toCreate.length, skipped, errors: errorList });
  });

  return r;
}
