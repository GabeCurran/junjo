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

// 16-char hex (64 bits of entropy). URL-safe and unambiguous to read aloud.
export function generateInvitationCode(): string {
  return randomBytes(8).toString("hex");
}

const DURATION_MULTIPLIERS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// Parses "7d", "1h", "30m", "45s" into milliseconds. Caller has already
// run the format-regex via Zod; this function only handles arithmetic.
// Returns `null` if the value is non-positive (the regex permits "0d").
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

// Public route handler: anyone with the code may fetch the invitation.
// Soft-deleted groups collapse to 404 (the group is gone from the dev's
// world and the preview UI has nothing to show).
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

// Authed route handler: revoke (delete) an invitation by code. Idempotent
// on already-used invitations (the row is left in place, 204 returned)
// so the audit story of "this code was redeemed by user X" survives.
// Unused invitations are hard-deleted; a second revoke call against the
// same code returns 404 because the row is gone.
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

// Loads an invitation by code and runs the precondition checks shared by
// accept and decline: invitation exists, the group hasn't been
// soft-deleted, the row isn't already used, the row hasn't expired. The
// loader is parameterized over the gameId enforcement (404 on cross-game
// codes) so the existence of an invitation in another game stays hidden.
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

// Authed route handler: accept an invitation by code. Creates a
// `GroupMember` for the supplied external user id (find-or-creating the
// underlying JunjoUser via ExternalIdentity), marks the invitation used,
// and writes a `member.joined` audit entry. All four writes happen inside
// one transaction. For direct invitations (`targetUserId` set), the body
// userId must match; mismatches return 403 to keep direct invites pinned
// to their target.
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

// Authed route handler: decline an invitation by code. Marks the
// invitation used (so it can never be redeemed) and writes nothing else;
// no member is created, no audit entry is written. Body is optional;
// when present, the supplied userId is recorded as `usedByUserId` (after
// resolving to a JunjoUser) so audits answer "who burned this code".
// Direct invitations only allow the target user to decline.
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
