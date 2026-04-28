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
