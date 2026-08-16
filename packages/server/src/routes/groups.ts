import type {
  GameId,
  GroupDeletedEvent,
  GroupId,
  GroupRelationshipChangedEvent,
  GroupUpdatedEvent,
  JunjoEvent,
  MemberBannedEvent,
  MemberInvitedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  MemberUnbannedEvent,
  RoleChangedEvent,
  RoleCreatedEvent,
  RoleId,
  UserId,
} from "@junjo.io/shared";
import type { Group, GroupRelationship, Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { hashSecret, verifySecret } from "../apiKey.js";
import { banErrorMessage, checkBanState } from "../bans.js";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import {
  publishStagedEvents,
  stageEvent,
  stageEventsBatch,
  toPublicGroup,
  toPublicGroupRelationship,
  toPublicInvitation,
  toPublicMember,
  toPublicRole,
} from "../events.js";
import { findJunjoUserId, findOrCreateJunjoUser } from "../identity.js";
import { RateLimiter } from "../middleware/rateLimit.js";
import { permissionCache } from "../permissionCache.js";
import { isUniqueViolation, retryOnUniqueViolation } from "../prismaErrors.js";
import { SOFT_DELETE_RETENTION_DAYS } from "../softDelete.js";
import { listAuditForGroup } from "./audit.js";
import { serializeBanHistoryEntry } from "./bans.js";
import { listGroupBanHistoryQuery } from "./bans.schema.js";
import {
  addMemberBody,
  banMemberBody,
  bulkInviteQuery,
  clearRelationshipQuery,
  createGroupBody,
  joinGroupBody,
  kickMemberBody,
  leaveGroupBody,
  listGroupsQuery,
  listRolesQuery,
  roleAssignBody,
  setParentBody,
  setRelationshipBody,
  unbanMemberBody,
  updateGroupBody,
  viewerQuery,
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
import { setGroupParentSafely } from "./parentCycle.js";
import { serializeGroupRelationship } from "./relationships.js";
import { batchLoadRolePermissionKeys, serializeRole } from "./roles.js";
import { PERMISSION_KEY_MAX_LENGTH, createRoleBody } from "./roles.schema.js";

// `BULK_INVITE_USERID_MAX_LENGTH` is sized to fit the external user id
// formats that common auth providers issue.
export const BULK_INVITE_MAX_ROWS = 1000;
export const BULK_INVITE_USERID_MAX_LENGTH = 255;

// Pre-split byte guard for the bulk-invite body. The row cap allows at
// most 1000 x 255-char userIds (~256 KB) plus newline separators; 512 KB
// leaves generous headroom while staying under the 1 MB global body cap.
// Checked BEFORE `parseBulkInviteBody` splits the text so a large body
// cannot be fully materialized into per-line arrays ahead of the
// 1000-row check.
export const BULK_INVITE_MAX_BODY_BYTES = 512 * 1024;

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
  hasPasscode: boolean;
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
    // Surface presence only; the hash itself never leaves the server.
    hasPasscode: group.passcodeHash !== null,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    softDeletedAt: group.softDeletedAt ? group.softDeletedAt.toISOString() : null,
  };
}

// Passcode attempt limiters. Tight per-(group, userId) bucket for
// fairness (alice can't try 50 passcodes in a minute) plus a per-group
// fanout cap (total attempts on this room across every userId capped,
// to bound scrypt CPU cost during a brute-force fan-out). Both fire
// BEFORE scrypt verify so a hostile caller cannot burn server CPU.
// In-memory + per-process by design (matches the existing API-key
// limiter); a multi-process deploy gets per-process limits, which is
// already enough headroom that a determined attacker would need to
// distribute across many processes to materially raise the ceiling.
const PASSCODE_ATTEMPTS_PER_GROUP_USER = { perMinute: 5, burst: 5 };
const PASSCODE_ATTEMPTS_PER_GROUP = { perMinute: 30, burst: 30 };

export function groupsRouter(prisma: PrismaClient, hub: EventHub): Hono {
  const passcodeUserLimiter = new RateLimiter(PASSCODE_ATTEMPTS_PER_GROUP_USER);
  const passcodeGroupLimiter = new RateLimiter(PASSCODE_ATTEMPTS_PER_GROUP);

  const r = new Hono();

  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    const parsed = listGroupsQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      gameId: c.req.query("gameId"),
      viewer: c.req.query("viewer"),
      kind: c.req.query("kind"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, gameId: filterGameId, viewer, kind } = parsed.data;
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

    // Visibility filter: omit secret groups unless the supplied viewer
    // is an active member. Calls without a viewer are treated as
    // server-to-server (admin) and see every non-deleted group.
    const viewerJunjoUserId = viewer ? await findJunjoUserId(prisma, gameId, viewer) : null;
    const conditions: Prisma.GroupWhereInput[] = [];
    if (viewer) {
      conditions.push(
        viewerJunjoUserId
          ? {
              OR: [
                { visibility: { not: "secret" } },
                {
                  members: {
                    some: { junjoUserId: viewerJunjoUserId, status: "active" },
                  },
                },
              ],
            }
          : { visibility: { not: "secret" } },
      );
    }
    if (cursorRow) {
      conditions.push({
        OR: [
          { createdAt: { lt: cursorRow.createdAt } },
          { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
        ],
      });
    }

    const where: Prisma.GroupWhereInput = {
      gameId,
      softDeletedAt: null,
      ...(kind !== undefined ? { kind } : {}),
      ...(conditions.length > 0 ? { AND: conditions } : {}),
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
    const parsedQ = viewerQuery.safeParse({ viewer: c.req.query("viewer") });
    if (!parsedQ.success) throw Errors.badRequest("invalid query");
    const { viewer } = parsedQ.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    // Secret groups 404 for non-members so existence stays invisible.
    // No viewer = admin/server caller, sees everything.
    if (viewer && group.visibility === "secret") {
      const viewerJunjoUserId = await findJunjoUserId(prisma, gameId, viewer);
      const isMember = viewerJunjoUserId
        ? await prisma.groupMember.findUnique({
            where: {
              groupId_junjoUserId: { groupId: group.id, junjoUserId: viewerJunjoUserId },
            },
            select: { status: true },
          })
        : null;
      if (!isMember || isMember.status !== "active") {
        throw Errors.notFound("group");
      }
    }

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

    // Resolve the creator's JunjoUser outside the main transaction (the
    // helper opens its own short-lived tx for the upsert and must own
    // its failing connection on P2002 retries; see identity.ts notes).
    const creatorJunjoUserId = body.creatorUserId
      ? await findOrCreateJunjoUser(prisma, gameId, body.creatorUserId)
      : null;

    // Hash the passcode outside the transaction (scrypt is intentionally
    // slow; holding it open across the hash would tie up a DB connection).
    const passcodeHash = body.passcode ? await hashSecret(body.passcode) : null;
    const passcodeSetAt = passcodeHash ? new Date() : null;

    const result = await prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          gameId,
          kind: body.kind,
          name: body.name,
          visibility: body.visibility ?? "invite-only",
          metadata: metadataInput,
          defaultRoleId: body.defaultRoleId,
          passcodeHash,
          passcodeSetAt,
        },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
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
            // Don't log the plaintext passcode; presence-only.
            hasPasscode: passcodeHash !== null,
          } as Prisma.InputJsonValue,
        },
      });

      if (!creatorJunjoUserId || !body.creatorUserId) {
        return { group: created, member: null, event: null };
      }

      const member = await tx.groupMember.create({
        data: {
          groupId: created.id,
          junjoUserId: creatorJunjoUserId,
          status: "active",
        },
      });

      // defaultRoleId is a free-form string with no FK; assign only
      // when a Role row matching this group actually exists. Roles are
      // normally created after the group, so on a fresh create this
      // path almost always no-ops, but the check keeps the door open
      // for callers who pre-seed Role rows for canned templates.
      let assignedRoleId: string | null = null;
      if (created.defaultRoleId) {
        const role = await tx.role.findFirst({
          where: { id: created.defaultRoleId, groupId: created.id },
          select: { id: true },
        });
        if (role) {
          await tx.memberRole.create({
            data: { groupMemberId: member.id, roleId: role.id },
          });
          assignedRoleId = role.id;
        }
      }

      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: created.id,
          actorUserId: creatorJunjoUserId,
          action: "member.joined",
          targetId: body.creatorUserId,
          payload: {
            memberId: member.id,
            via: "creator",
            ...(assignedRoleId ? { roleId: assignedRoleId } : {}),
          } as Prisma.InputJsonValue,
        },
      });

      const event = await stageEvent<MemberJoinedEvent>(tx, {
        type: "member.joined",
        gameId: gameId as GameId,
        groupId: created.id as GroupId,
        userId: body.creatorUserId as UserId,
        member: toPublicMember(member, body.creatorUserId, assignedRoleId ? [assignedRoleId] : []),
      });

      return { group: created, member, event };
    });

    if (result.event) {
      publishStagedEvents(hub, result.event);
    }

    return c.json(serializeGroup(result.group, result.member ? 1 : 0), 201);
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

    // Hash outside the transaction (scrypt is intentionally slow).
    // We hash even when the new passcode equals the existing one in
    // plaintext since we can't compare plaintexts; the verify path
    // handles it. Skip hashing when the field was omitted entirely.
    const newPasscodeHash =
      body.passcode === undefined
        ? undefined
        : body.passcode === null
          ? null
          : await hashSecret(body.passcode);

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.group.findFirst({
        where: { id, gameId, softDeletedAt: null },
      });
      if (!existing) throw Errors.notFound("group");

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.GroupUpdateInput = {};
      // Track passcode transitions separately so we can write a
      // dedicated audit row (the standard group.updated row only logs
      // presence as a boolean, never the value).
      let passcodeTransition: "set" | "cleared" | "rotated" | null = null;

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
      if (newPasscodeHash !== undefined) {
        const hadPasscode = existing.passcodeHash !== null;
        const willHavePasscode = newPasscodeHash !== null;
        if (hadPasscode || willHavePasscode) {
          before.hasPasscode = hadPasscode;
          after.hasPasscode = willHavePasscode;
          data.passcodeHash = newPasscodeHash;
          data.passcodeSetAt = willHavePasscode ? new Date() : null;
          passcodeTransition = willHavePasscode ? (hadPasscode ? "rotated" : "set") : "cleared";
        }
      }

      if (Object.keys(data).length === 0) {
        return { row: existing, event: null, memberCount: null };
      }

      const result = await tx.group.update({
        where: { id: existing.id },
        data,
      });

      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: result.id,
          actorUserId: null,
          action: "group.updated",
          targetId: result.id,
          payload: { before, after } as Prisma.InputJsonValue,
        },
      });

      // Dedicated passcode audit row: keeps "show me every passcode
      // change" filterable via `?actions=group.passcode.set` without
      // scanning every group.updated payload.
      if (passcodeTransition) {
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: result.id,
            actorUserId: null,
            action:
              passcodeTransition === "cleared" ? "group.passcode.cleared" : "group.passcode.set",
            targetId: result.id,
            payload: {
              transition: passcodeTransition,
            } as Prisma.InputJsonValue,
          },
        });
      }

      // Counted inside the transaction so the staged group.updated
      // payload reflects the committed row.
      const memberCount = await tx.groupMember.count({
        where: { groupId: result.id, status: "active" },
      });
      const event = await stageEvent<GroupUpdatedEvent>(tx, {
        type: "group.updated",
        gameId: gameId as GameId,
        groupId: result.id as GroupId,
        group: toPublicGroup(result, memberCount),
      });

      return { row: result, event, memberCount };
    });

    const memberCount =
      updated.memberCount ??
      (await prisma.groupMember.count({
        where: { groupId: updated.row.id, status: "active" },
      }));
    if (updated.event) {
      publishStagedEvents(hub, updated.event);
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
      const event = await prisma.$transaction(async (tx) => {
        await tx.group.delete({ where: { id: existing.id } });
        return stageEvent<GroupDeletedEvent>(tx, {
          type: "group.deleted",
          gameId: existing.gameId as GameId,
          groupId: existing.id as GroupId,
        });
      });
      publishStagedEvents(hub, event);
      return c.body(null, 204);
    }

    if (existing.softDeletedAt) {
      const memberCount = await prisma.groupMember.count({
        where: { groupId: existing.id, status: "active" },
      });
      return c.json(serializeGroup(existing, memberCount));
    }

    const { row: updated, event } = await prisma.$transaction(async (tx) => {
      const now = new Date();
      const result = await tx.group.update({
        where: { id: existing.id },
        data: { softDeletedAt: now },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
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
      const staged = await stageEvent<GroupDeletedEvent>(tx, {
        type: "group.deleted",
        gameId: result.gameId as GameId,
        groupId: result.id as GroupId,
      });
      return { row: result, event: staged };
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.id, status: "active" },
    });
    publishStagedEvents(hub, event);
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
    const {
      row: updated,
      event,
      memberCount,
    } = await prisma.$transaction(async (tx) => {
      const result = await tx.group.update({
        where: { id: existing.id },
        data: { softDeletedAt: null },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: result.id,
          actorUserId: null,
          action: "group.restored",
          targetId: result.id,
          payload: { previousSoftDeletedAt } as Prisma.InputJsonValue,
        },
      });
      // Counted inside the transaction so the staged group.updated
      // payload reflects the committed row.
      const count = await tx.groupMember.count({
        where: { groupId: result.id, status: "active" },
      });
      const staged = await stageEvent<GroupUpdatedEvent>(tx, {
        type: "group.updated",
        gameId: result.gameId as GameId,
        groupId: result.id as GroupId,
        group: toPublicGroup(result, count),
      });
      return { row: result, event: staged, memberCount: count };
    });

    publishStagedEvents(hub, event);
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

    const { invitation, event } = await prisma.$transaction(async (tx) => {
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
          gameId,
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
      const staged = await stageEvent<MemberInvitedEvent>(tx, {
        type: "member.invited",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        invitation: toPublicInvitation(created),
      });
      return { invitation: created, event: staged };
    });

    publishStagedEvents(hub, event);
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

  // Accepts an optional `?status=` filter (comma-separated statuses),
  // applied server-side so the cursor and nextCursor describe the
  // filtered stream; the React roster hooks rely on that. Omitting it
  // returns rows in every status.
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
      status: c.req.query("status"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, status } = parsed.data;

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
      ...(status && status.length > 0 ? { status: { in: status } } : {}),
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
  // Open join for `visibility = "public"` groups. Invite-only and secret
  // groups still require an `Invitation`; secret groups 404 (existence is
  // invisible), invite-only returns 403 with a clear message.
  // Server-to-server member creation, the provisioning counterpart to
  // `join`. Ignores `visibility` (the API key is already admin-class,
  // so gating this on discoverability only forces provisioners to make
  // internal groups public) but still honors bans.
  //
  // Idempotent: `201` when the call made the member active, `200` when
  // they already were, so a re-run of a provisioning script is a no-op
  // that reports whether it changed anything. Events fire only on an
  // actual transition.
  r.post("/:id/members", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = addMemberBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { userId, roleId, actorUserId } = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    // Resolved before any write so a bad roleId fails the call rather
    // than leaving a role-less member behind.
    const role = roleId
      ? await prisma.role.findUnique({
          where: { id: roleId },
          select: { id: true, groupId: true },
        })
      : null;
    if (roleId) {
      if (!role) throw Errors.notFound("role");
      if (role.groupId !== group.id) throw Errors.roleGroupMismatch();
    }

    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);

    const banState = await checkBanState(prisma, gameId, junjoUserId, group.id);
    if (banState.banned) throw Errors.banned(banErrorMessage(banState));

    const actorJunjoUserId = actorUserId
      ? await findOrCreateJunjoUser(prisma, gameId, actorUserId)
      : null;

    // Retried rather than surfaced as a conflict: a concurrent add of
    // the same user (or the same role) rolls this transaction back, and
    // the second attempt takes the idempotent already-active path. The
    // rollback drops the staged events and audit rows with it, so the
    // retry cannot double-emit.
    const outcome = await retryOnUniqueViolation(() =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.groupMember.findUnique({
          where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
        });
        const wasActive = existing?.status === "active";

        let member = existing;
        if (!existing) {
          member = await tx.groupMember.create({
            data: { groupId: group.id, junjoUserId, status: "active" },
          });
        } else if (!wasActive) {
          // Reactivate from left / kicked, keeping the original
          // joinedAt. Matches the public join path.
          member = await tx.groupMember.update({
            where: { id: existing.id },
            data: { status: "active", leftAt: null, bannedUntil: null },
          });
        }
        if (!member) throw new Error("member row missing after upsert");

        // Roles held before this call. The member.joined event carries
        // these, and any role added below is reported separately as
        // role.changed, so the event stream reads the same as the
        // join-then-assign sequence this route replaces.
        const priorRoleIds = existing ? await loadMemberRoleIds(tx, member.id) : [];
        const roleAdded = role !== null && !priorRoleIds.includes(role.id);

        const staged: JunjoEvent[] = [];
        if (!wasActive) {
          await tx.auditEntry.create({
            data: {
              gameId,
              groupId: group.id,
              actorUserId: actorJunjoUserId,
              action: "member.joined",
              targetId: userId,
              payload: {
                memberId: member.id,
                via: "admin-add",
              } as Prisma.InputJsonValue,
            },
          });
          staged.push(
            await stageEvent<MemberJoinedEvent>(tx, {
              type: "member.joined",
              gameId: gameId as GameId,
              groupId: group.id as GroupId,
              userId: userId as UserId,
              member: toPublicMember(member, userId, priorRoleIds),
            }),
          );
        }

        if (role && roleAdded) {
          await tx.memberRole.create({
            data: { groupMemberId: member.id, roleId: role.id },
          });
          await tx.auditEntry.create({
            data: {
              gameId,
              groupId: group.id,
              actorUserId: actorJunjoUserId,
              action: "role.assigned",
              targetId: userId,
              payload: {
                memberId: member.id,
                roleId: role.id,
              } as Prisma.InputJsonValue,
            },
          });
          staged.push(
            await stageEvent<RoleChangedEvent>(tx, {
              type: "role.changed",
              gameId: gameId as GameId,
              groupId: group.id as GroupId,
              userId: userId as UserId,
              added: [role.id as RoleId],
              removed: [],
              actorUserId: (actorUserId as UserId | undefined) ?? null,
            }),
          );
        }

        const roleIds = roleAdded && role ? [...priorRoleIds, role.id] : priorRoleIds;
        return { member, roleIds, wasActive, roleAdded, staged };
      }),
    );

    if (outcome.roleAdded) permissionCache.invalidateGroup(group.id);
    publishStagedEvents(hub, ...outcome.staged);
    return c.json(
      serializeMember(outcome.member, userId, outcome.roleIds),
      outcome.wasActive ? 200 : 201,
    );
  });

  r.post("/:id/join", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = joinGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { userId, passcode } = parsed.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");
    if (group.visibility === "secret") throw Errors.notFound("group");
    if (group.visibility !== "public") {
      throw Errors.permissionDenied("this group requires an invitation to join");
    }

    // Passcode gate: orthogonal to visibility. Only enforced on public
    // join; invitation accept treats the invitation itself as the
    // credential. Verify before resolving the JunjoUser to avoid
    // leaking "user exists" information through identity creation.
    if (group.passcodeHash) {
      if (!passcode) throw Errors.passcodeRequired();
      // Two-bucket rate limit BEFORE scrypt verify. The per-(group,
      // userId) bucket bounds a single user's attempt rate; the
      // per-group bucket bounds total fanout across rotating userIds.
      // Buckets consume regardless of result, so successful joins
      // still count -- fine because the cap is generous enough that a
      // legitimate join (one attempt) is well below it.
      const userKey = `${group.id}:${userId}`;
      const groupKey = group.id;
      const userResult = passcodeUserLimiter.consume(userKey);
      const groupResult = passcodeGroupLimiter.consume(groupKey);
      if (!userResult.allowed || !groupResult.allowed) {
        const retryAfter = Math.max(
          userResult.retryAfterSeconds ?? 0,
          groupResult.retryAfterSeconds ?? 0,
          1,
        );
        c.header("Retry-After", String(retryAfter));
        throw Errors.rateLimitExceeded(`too many passcode attempts; retry after ${retryAfter}s`);
      }
      const ok = await verifySecret(passcode, group.passcodeHash);
      if (!ok) throw Errors.passcodeInvalid();
    }

    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);

    // Game-level + per-group ban check before any state mutation. Both
    // bans return 403 banned with a clear message; the user is not
    // told which scope blocked them beyond what the message says.
    const banState = await checkBanState(prisma, gameId, junjoUserId, group.id);
    if (banState.banned) throw Errors.banned(banErrorMessage(banState));

    const { member, event } = await prisma
      .$transaction(async (tx) => {
        const existing = await tx.groupMember.findUnique({
          where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
        });
        if (existing && existing.status === "active") throw Errors.alreadyMember();

        const result = existing
          ? await tx.groupMember.update({
              where: { id: existing.id },
              // Reactivate from left/kicked. bannedUntil is cleared
              // defensively even though the ban check above already
              // rejects banned rows (state hygiene).
              data: { status: "active", leftAt: null, bannedUntil: null },
            })
          : await tx.groupMember.create({
              data: { groupId: group.id, junjoUserId, status: "active" },
            });

        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: group.id,
            actorUserId: junjoUserId,
            action: "member.joined",
            targetId: userId,
            payload: {
              memberId: result.id,
              via: "public-join",
            } as Prisma.InputJsonValue,
          },
        });
        const staged = await stageEvent<MemberJoinedEvent>(tx, {
          type: "member.joined",
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          userId: userId as UserId,
          member: toPublicMember(result, userId, []),
        });
        return { member: result, event: staged };
      })
      .catch((err) => {
        // Loser of a concurrent first-time join: the winner's row landed
        // between our findUnique and create. Same outcome as arriving
        // sequentially second. The rollback also drops the staged
        // webhook deliveries.
        if (isUniqueViolation(err)) throw Errors.alreadyMember();
        throw err;
      });

    publishStagedEvents(hub, event);
    return c.json(serializeMember(member, userId, []), 201);
  });

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

    const { row: updated, event } = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "left", leftAt: new Date() },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
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
      const staged = await stageEvent<MemberLeftEvent>(tx, {
        type: "member.left",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        userId: userId as UserId,
        reason: "left",
      });
      return { row: result, event: staged };
    });

    const roleIds = await loadMemberRoleIds(prisma, updated.id);
    publishStagedEvents(hub, event);
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

    const { row: updated, event } = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "kicked", leftAt: new Date() },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
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
      const staged = await stageEvent<MemberLeftEvent>(tx, {
        type: "member.left",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        userId: userId as UserId,
        reason: "kicked",
      });
      return { row: result, event: staged };
    });

    const roleIds = await loadMemberRoleIds(prisma, updated.id);
    publishStagedEvents(hub, event);
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // Per-group ban. Distinct from kick: kicked members can rejoin via
  // public-join / invitation accept (with the codex change in ba473eb),
  // banned members cannot. The /join and /invitations/:code/accept
  // routes consult `checkBanState` and 403 with `code: "banned"`.
  // Optional `expiresAt` enables timeouts; null = permanent.
  r.post("/:id/members/:userId/ban", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = banMemberBody.safeParse(json ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const reasonValue = parsed.data.reason ?? null;
    const expiresAtValue = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    const actorExternalId = parsed.data.actorUserId ?? null;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    // Auto-create the JunjoUser + ExternalIdentity if the dev hasn't
    // seen this user before. Mirrors the kick semantics in spirit but
    // takes the upsert path so a moderator can preemptively ban a user
    // who hasn't joined yet.
    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);
    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    // retryOnUniqueViolation: a concurrent first-time ban (or a ban
    // racing a join) can land a GroupMember row between the findUnique
    // and the create; the rerun takes the update branch.
    const result = await retryOnUniqueViolation(() =>
      prisma.$transaction(async (tx) => {
        const existing = await tx.groupMember.findUnique({
          where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
        });
        const member = existing
          ? await tx.groupMember.update({
              where: { id: existing.id },
              data: {
                status: "banned",
                bannedUntil: expiresAtValue,
                leftAt: existing.leftAt ?? new Date(),
              },
            })
          : await tx.groupMember.create({
              data: {
                groupId: group.id,
                junjoUserId,
                status: "banned",
                bannedUntil: expiresAtValue,
                leftAt: new Date(),
              },
            });
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: group.id,
            actorUserId: actorJunjoUserId,
            action: "member.banned",
            targetId: userId,
            payload: {
              memberId: member.id,
              reason: reasonValue,
              bannedUntil: expiresAtValue ? expiresAtValue.toISOString() : null,
            } as Prisma.InputJsonValue,
          },
        });
        // BanHistory append: structured ban-only timeline, distinct
        // from the audit row above and from GroupMember (current state).
        await tx.banHistory.create({
          data: {
            gameId,
            junjoUserId,
            scope: "group",
            groupId: group.id,
            kind: "set",
            reason: reasonValue,
            expiresAt: expiresAtValue,
            actorJunjoUserId,
          },
        });
        const event = await stageEvent<MemberBannedEvent>(tx, {
          type: "member.banned",
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          userId: userId as UserId,
          reason: reasonValue,
          bannedUntil: expiresAtValue,
        });
        return { member, event };
      }),
    );

    const roleIds = await loadMemberRoleIds(prisma, result.member.id);
    publishStagedEvents(hub, result.event);
    return c.json(serializeMember(result.member, userId, roleIds));
  });

  // Reverse a per-group ban. Flips the row to `status="left"` so the
  // membership history stays intact (matches the kick / leave audit
  // shape; the user can be re-invited normally afterward). 404s when
  // the row doesn't exist or isn't currently banned -- callers needing
  // idempotency should check first.
  r.delete("/:id/members/:userId/ban", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const gameId = c.var.gameId;

    const json = await c.req.json().catch(() => null);
    const parsed = unbanMemberBody.safeParse(json ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const actorExternalId = parsed.data.actorUserId ?? null;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("ban");
    const member = await prisma.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId: group.id, junjoUserId } },
    });
    if (!member || member.status !== "banned") throw Errors.notFound("ban");

    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    const { row: updated, event } = await prisma.$transaction(async (tx) => {
      const result = await tx.groupMember.update({
        where: { id: member.id },
        data: { status: "left", bannedUntil: null },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: group.id,
          actorUserId: actorJunjoUserId,
          action: "member.unbanned",
          targetId: userId,
          payload: { memberId: result.id } as Prisma.InputJsonValue,
        },
      });
      await tx.banHistory.create({
        data: {
          gameId,
          junjoUserId,
          scope: "group",
          groupId: group.id,
          kind: "lifted",
          reason: null,
          expiresAt: null,
          actorJunjoUserId,
        },
      });
      const staged = await stageEvent<MemberUnbannedEvent>(tx, {
        type: "member.unbanned",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        userId: userId as UserId,
      });
      return { row: result, event: staged };
    });

    const roleIds = await loadMemberRoleIds(prisma, updated.id);
    publishStagedEvents(hub, event);
    return c.json(serializeMember(updated, userId, roleIds));
  });

  // GET /v1/groups/:id/bans/history
  // Group-scoped ban-event timeline. Returns every set/lift on this
  // group across all users, newest-first. Excludes game-scope rows;
  // consumers wanting "this user's full ban story across game + group"
  // should use /v1/bans/:userId/history. Cursor pagination on
  // (eventAt DESC, id DESC).
  r.get("/:id/bans/history", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("group");

    const parsed = listGroupBanHistoryQuery.safeParse({
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

    let cursorRow: { id: string; eventAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.banHistory.findFirst({
        where: { id: cursor, gameId, groupId: group.id, scope: "group" },
        select: { id: true, eventAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const where: Prisma.BanHistoryWhereInput = {
      gameId,
      groupId: group.id,
      scope: "group",
      ...(cursorRow
        ? {
            OR: [
              { eventAt: { lt: cursorRow.eventAt } },
              { eventAt: cursorRow.eventAt, id: { lt: cursorRow.id } },
            ],
          }
        : {}),
    };

    const rows = await prisma.banHistory.findMany({
      where,
      orderBy: [{ eventAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    // Batch-resolve every junjoUserId we'll surface (targets + actors).
    const junjoUserIds = new Set<string>();
    for (const row of sliced) {
      junjoUserIds.add(row.junjoUserId);
      if (row.actorJunjoUserId) junjoUserIds.add(row.actorJunjoUserId);
    }
    const externalMap =
      junjoUserIds.size > 0
        ? await batchLoadExternalUserIds(prisma, gameId, [...junjoUserIds])
        : new Map<string, string>();

    return c.json({
      items: sliced.map((row) => {
        const targetExt = externalMap.get(row.junjoUserId) ?? row.junjoUserId;
        const actorExt = row.actorJunjoUserId
          ? (externalMap.get(row.actorJunjoUserId) ?? null)
          : null;
        return serializeBanHistoryEntry(row, targetExt, actorExt);
      }),
      nextCursor,
    });
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
            gameId,
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
            gameId,
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
    // Reject an oversized body before splitting it into lines.
    if (Buffer.byteLength(text, "utf8") > BULK_INVITE_MAX_BODY_BYTES) {
      throw Errors.badRequest(`bulk-invite body exceeds ${BULK_INVITE_MAX_BODY_BYTES} bytes`);
    }
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

    // Batch-load both ban surfaces for the unique users in this batch.
    // Lazy expiry: any row whose expiry is in the past is ignored.
    const gameBans =
      junjoUserIds.length === 0
        ? []
        : await prisma.gameBan.findMany({
            where: {
              gameId,
              junjoUserId: { in: junjoUserIds },
              OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { junjoUserId: true },
          });
    const gameBannedJunjoUserIds = new Set(gameBans.map((b) => b.junjoUserId));
    const groupBans =
      junjoUserIds.length === 0
        ? []
        : await prisma.groupMember.findMany({
            where: {
              groupId: group.id,
              junjoUserId: { in: junjoUserIds },
              status: "banned",
              OR: [{ bannedUntil: null }, { bannedUntil: { gt: now } }],
            },
            select: { junjoUserId: true },
          });
    const groupBannedJunjoUserIds = new Set(groupBans.map((b) => b.junjoUserId));

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
      // Banned users surface as per-row errors (loud, not silent
      // skips) so the operator knows the invite was rejected for a
      // real moderation reason rather than dropped quietly.
      if (junjoUserId && gameBannedJunjoUserIds.has(junjoUserId)) {
        errorList.push({ row: row.row, reason: "user is banned from this game" });
        continue;
      }
      if (junjoUserId && groupBannedJunjoUserIds.has(junjoUserId)) {
        errorList.push({ row: row.row, reason: "user is banned from this group" });
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

    // Three batched statements regardless of row count: the previous
    // per-row create/audit/stage loop put up to ~4N round-trips inside
    // one interactive transaction and hit Prisma's transaction timeout
    // at the documented row cap.
    const stagedEvents = await prisma.$transaction(async (tx) => {
      const invitations = await tx.invitation.createManyAndReturn({
        data: toCreate.map((row) => ({
          groupId: group.id,
          code: generateInvitationCode(),
          roleId,
          targetUserId: row.userId,
          createdByUserId: null,
          expiresAt: null,
        })),
      });
      await tx.auditEntry.createMany({
        data: invitations.map((created) => ({
          gameId,
          groupId: group.id,
          actorUserId: null,
          action: "member.invited",
          targetId: created.targetUserId,
          payload: {
            invitationId: created.id,
            code: created.code,
            targetUserId: created.targetUserId,
            roleId,
            expiresAt: null,
            source: "bulk-invite",
          } as Prisma.InputJsonValue,
        })),
      });
      return stageEventsBatch<MemberInvitedEvent>(
        tx,
        invitations.map((created) => ({
          type: "member.invited" as const,
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          invitation: toPublicInvitation(created),
        })),
      );
    });

    publishStagedEvents(hub, ...stagedEvents);

    return c.json({ invited: toCreate.length, skipped, errors: errorList });
  });

  // Idempotent on already-assigned. Cross-group assignment returns 400
  // `role_group_mismatch`; missing role returns 404.
  r.post("/:id/members/:userId/roles/:roleId", async (c) => {
    const id = c.req.param("id");
    const userId = c.req.param("userId");
    const roleId = c.req.param("roleId");
    const gameId = c.var.gameId;

    const json = await c.req.json().catch(() => null);
    const parsed = roleAssignBody.safeParse(json ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const actorExternalId = parsed.data.actorUserId ?? null;

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

    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    const event = await prisma
      .$transaction(async (tx) => {
        await tx.memberRole.create({
          data: { groupMemberId: member.id, roleId: role.id },
        });
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: group.id,
            actorUserId: actorJunjoUserId,
            action: "role.assigned",
            targetId: userId,
            payload: {
              memberId: member.id,
              roleId: role.id,
            } as Prisma.InputJsonValue,
          },
        });
        return stageEvent<RoleChangedEvent>(tx, {
          type: "role.changed",
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          userId: userId as UserId,
          added: [role.id as RoleId],
          removed: [],
          actorUserId: (actorExternalId as UserId | null) ?? null,
        });
      })
      .catch((err) => {
        // Loser of a concurrent duplicate assign: the winner's row
        // landed after the idempotency check above. Same answer the
        // sequential second caller gets (current member snapshot, no
        // event); the rollback drops the staged delivery and audit row.
        if (isUniqueViolation(err)) return null;
        throw err;
      });
    if (event) {
      permissionCache.invalidateGroup(group.id);
      publishStagedEvents(hub, event);
    }

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

    const json = await c.req.json().catch(() => null);
    const parsed = roleAssignBody.safeParse(json ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const actorExternalId = parsed.data.actorUserId ?? null;

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

    const actorJunjoUserId = actorExternalId
      ? await findOrCreateJunjoUser(prisma, gameId, actorExternalId)
      : null;

    const event = await prisma.$transaction(async (tx) => {
      await tx.memberRole.delete({
        where: { groupMemberId_roleId: { groupMemberId: member.id, roleId } },
      });
      await tx.auditEntry.create({
        data: {
          gameId,
          groupId: group.id,
          actorUserId: actorJunjoUserId,
          action: "role.unassigned",
          targetId: userId,
          payload: {
            memberId: member.id,
            roleId,
          } as Prisma.InputJsonValue,
        },
      });
      return stageEvent<RoleChangedEvent>(tx, {
        type: "role.changed",
        gameId: gameId as GameId,
        groupId: group.id as GroupId,
        userId: userId as UserId,
        added: [],
        removed: [roleId as RoleId],
        actorUserId: (actorExternalId as UserId | null) ?? null,
      });
    });
    permissionCache.invalidateGroup(group.id);

    publishStagedEvents(hub, event);

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
          gameId,
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
          gameId,
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

    const { role, event } = await prisma
      .$transaction(async (tx) => {
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
            gameId,
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
        const staged = await stageEvent<RoleCreatedEvent>(tx, {
          type: "role.created",
          gameId: gameId as GameId,
          groupId: group.id as GroupId,
          role: toPublicRole(created, []),
        });
        return { role: created, event: staged };
      })
      .catch((err) => {
        // Loser of a concurrent same-name create: the winner's row
        // landed after the duplicate check above. Same answer the
        // sequential second caller gets. The rollback also drops the
        // staged webhook deliveries.
        if (isUniqueViolation(err)) throw Errors.roleNameTaken();
        throw err;
      });

    publishStagedEvents(hub, event);
    return c.json(serializeRole(role, []), 201);
  });

  r.get("/:id/roles", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const parsedQ = listRolesQuery.safeParse({ paged: c.req.query("paged") });
    if (!parsedQ.success) throw Errors.badRequest("invalid query");
    const { paged } = parsedQ.data;

    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");

    const roles = await prisma.role.findMany({
      where: { groupId: group.id },
      orderBy: [{ priority: "desc" }, { id: "desc" }],
    });
    if (roles.length === 0) {
      return c.json(paged ? { items: [], nextCursor: null } : []);
    }

    const permissionMap = await batchLoadRolePermissionKeys(
      prisma,
      roles.map((r2) => r2.id),
    );
    const items = roles.map((role) => serializeRole(role, permissionMap.get(role.id) ?? []));
    return c.json(paged ? { items, nextCursor: null } : items);
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
      const events: GroupRelationshipChangedEvent[] = [];
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

        const auditPayload: Record<string, unknown> = {
          groupAId: dir.aId,
          groupBId: dir.bId,
          type,
          mutual: mutual === true,
        };
        if (existing) auditPayload.before = { type: existing.type };
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: dir.aId,
            actorUserId: null,
            action: "group.relationship.set",
            targetId: dir.bId,
            payload: auditPayload as Prisma.InputJsonValue,
          },
        });
        events.push(
          await stageEvent<GroupRelationshipChangedEvent>(tx, {
            type: "group.relationship.changed",
            gameId: gameId as GameId,
            groupId: upserted.groupAId as GroupId,
            otherGroupId: upserted.groupBId as GroupId,
            relationship: toPublicGroupRelationship(upserted),
          }),
        );
      }
      if (!primary) {
        // Both directions no-op'd; reload the existing A->B row.
        const reloaded = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: a, groupBId: b } },
        });
        if (!reloaded) throw new Error("relationship row missing after no-op upsert");
        primary = reloaded;
      }
      return { primary, events };
    });

    publishStagedEvents(hub, ...result.events);

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

    const stagedEvents = await prisma.$transaction(async (tx) => {
      const events: GroupRelationshipChangedEvent[] = [];
      for (const dir of directions) {
        const existing = await tx.groupRelationship.findUnique({
          where: { groupAId_groupBId: { groupAId: dir.aId, groupBId: dir.bId } },
        });
        if (!existing) continue;

        // Guarded delete: a racing clear removes the row between the
        // findUnique and the delete; the loser matches zero rows and
        // skips the audit/event for this direction, same as a
        // sequential second caller (idempotent 204).
        const deleted = await tx.groupRelationship.deleteMany({
          where: { groupAId: dir.aId, groupBId: dir.bId },
        });
        if (deleted.count === 0) continue;
        await tx.auditEntry.create({
          data: {
            gameId,
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
        events.push(
          await stageEvent<GroupRelationshipChangedEvent>(tx, {
            type: "group.relationship.changed",
            gameId: gameId as GameId,
            groupId: dir.aId as GroupId,
            otherGroupId: dir.bId as GroupId,
            relationship: null,
          }),
        );
      }
      return events;
    });

    publishStagedEvents(hub, ...stagedEvents);

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

  // Cycle detection runs inside a SERIALIZABLE transaction with the
  // write (see parentCycle.ts); self-parent and any cycle 400
  // `parent_cycle`.
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

    const { row, memberCount } = await setGroupParentSafely(prisma, hub, {
      gameId,
      groupId: id,
      parentGroupId,
    });
    // Reparenting changes what an inherited check resolves against.
    // Invalidating this group alone is sufficient: a descendant's
    // cached inherited answer can only be affected if its walk reached
    // this group, and any walk that reached it recorded it as a
    // dependency.
    permissionCache.invalidateGroup(row.id);
    return c.json(serializeGroup(row, memberCount));
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
