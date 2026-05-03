import { randomBytes } from "node:crypto";
import type { GameId, GroupId, MemberJoinedEvent, UserId } from "@junjo/shared";
import type { Invitation, Prisma, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { dispatchEvent, toPublicMember } from "../events.js";
import { findOrCreateJunjoUser } from "../identity.js";
import { acceptInvitationBody, declineInvitationBody } from "./invitations.schema.js";
import { serializeMember } from "./members.js";

export interface WireInvitation {
  id: string;
  groupId: string;
  code: string;
  roleId: string | null;
  targetUserId: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedBy: string | null;
}

export function serializeInvitation(inv: Invitation): WireInvitation {
  return {
    id: inv.id,
    groupId: inv.groupId,
    code: inv.code,
    roleId: inv.roleId,
    targetUserId: inv.targetUserId,
    createdBy: inv.createdByUserId,
    createdAt: inv.createdAt.toISOString(),
    expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
    usedAt: inv.usedAt ? inv.usedAt.toISOString() : null,
    usedBy: inv.usedByUserId,
  };
}

// 16 hex chars (64 bits). URL-safe and unambiguous to read aloud.
export function generateInvitationCode(): string {
  return randomBytes(8).toString("hex");
}

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// Returns null on non-positive values (the Zod regex permits "0d").
export function parseDurationMs(value: string): number | null {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2] as keyof typeof DURATION_MULTIPLIERS;
  if (!Number.isFinite(n) || n <= 0) return null;
  const mult = DURATION_MULTIPLIERS[unit];
  if (mult === undefined) return null;
  return n * mult;
}

// Anyone with the code may fetch the preview; this handler is mounted
// before the apiKey middleware in `app.ts`.
export function getInvitationByCodeHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const code = c.req.param("code");
    const invitation = await prisma.invitation.findUnique({
      where: { code },
      include: { group: { select: { softDeletedAt: true } } },
    });
    if (!invitation) throw Errors.notFound("invitation");
    if (invitation.group.softDeletedAt) throw Errors.notFound("invitation");
    return c.json(serializeInvitation(invitation));
  };
}

// Already-used codes are left in place (so audit can still answer "who
// redeemed this?") and return 204; unused codes are hard-deleted, so a
// second revoke call returns 404.
export function deleteInvitationByCodeHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const code = c.req.param("code");
    const gameId = c.var.gameId;
    const invitation = await prisma.invitation.findUnique({
      where: { code },
      include: { group: { select: { gameId: true } } },
    });
    if (!invitation || invitation.group.gameId !== gameId) {
      throw Errors.notFound("invitation");
    }
    if (invitation.usedAt) {
      return c.body(null, 204);
    }
    await prisma.invitation.delete({ where: { id: invitation.id } });
    return c.body(null, 204);
  };
}

// Cross-game codes 404 so the existence of an invitation in another
// game stays hidden through the gameId scope.
async function loadRedemptionTarget(
  prisma: PrismaClient,
  code: string | undefined,
  gameId: string,
): Promise<Invitation> {
  if (!code) throw Errors.notFound("invitation");
  const invitation = await prisma.invitation.findUnique({
    where: { code },
    include: { group: { select: { gameId: true, softDeletedAt: true } } },
  });
  if (!invitation || invitation.group.gameId !== gameId) {
    throw Errors.notFound("invitation");
  }
  if (invitation.group.softDeletedAt) throw Errors.notFound("invitation");
  if (invitation.usedAt) throw Errors.invitationUsed();
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    throw Errors.invitationExpired();
  }
  return invitation;
}

// Direct invitations (with `targetUserId` set) require the body userId
// to match; mismatches 403 to keep direct invites pinned to their target.
export function acceptInvitationByCodeHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const code = c.req.param("code");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = acceptInvitationBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { userId } = parsed.data;

    const invitation = await loadRedemptionTarget(prisma, code, gameId);
    if (invitation.targetUserId && invitation.targetUserId !== userId) {
      throw Errors.permissionDenied("this invitation is for a different user");
    }

    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.groupMember.findUnique({
        where: { groupId_junjoUserId: { groupId: invitation.groupId, junjoUserId } },
      });
      if (existing) throw Errors.alreadyMember();

      const member = await tx.groupMember.create({
        data: {
          groupId: invitation.groupId,
          junjoUserId,
          status: "active",
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { usedAt: new Date(), usedByUserId: junjoUserId },
      });

      await tx.auditEntry.create({
        data: {
          groupId: invitation.groupId,
          actorUserId: junjoUserId,
          action: "member.joined",
          targetId: userId,
          payload: {
            memberId: member.id,
            invitationId: invitation.id,
            code: invitation.code,
          } as Prisma.InputJsonValue,
        },
      });

      return member;
    });

    await dispatchEvent<MemberJoinedEvent>(prisma, hub, {
      type: "member.joined",
      gameId: gameId as GameId,
      groupId: invitation.groupId as GroupId,
      userId: userId as UserId,
      member: toPublicMember(result, userId, []),
    });

    return c.json(serializeMember(result, userId), 201);
  };
}

// Body is optional; supplying `userId` records `usedByUserId` so audit
// can answer "who burned this code". Direct invitations only allow the
// target user to decline.
export function declineInvitationByCodeHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const code = c.req.param("code");
    const gameId = c.var.gameId;
    const raw = await c.req.json().catch(() => null);
    const parsed = declineInvitationBody.safeParse(raw ?? undefined);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const { userId } = parsed.data;

    const invitation = await loadRedemptionTarget(prisma, code, gameId);
    if (invitation.targetUserId && userId && invitation.targetUserId !== userId) {
      throw Errors.permissionDenied("this invitation is for a different user");
    }

    const junjoUserId = userId ? await findOrCreateJunjoUser(prisma, gameId, userId) : null;

    await prisma.$transaction(async (tx) => {
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { usedAt: new Date(), usedByUserId: junjoUserId },
      });
    });

    return c.body(null, 204);
  };
}
