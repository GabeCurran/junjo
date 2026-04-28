import { randomBytes } from "node:crypto";
import type { Invitation, PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";

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
