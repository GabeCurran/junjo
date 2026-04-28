import { randomBytes } from "node:crypto";
import type { Invitation } from "@prisma/client";

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
