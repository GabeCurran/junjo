import type { Prisma, PrismaClient } from "@prisma/client";

// Lazy-expiry helper: a `bannedUntil` / `expiresAt` in the past means
// the ban has lapsed. The server doesn't proactively flip rows; read
// paths just treat them as not-banned. Null = permanent.
function isActiveBan(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt > now;
}

export interface BanCheckResult {
  // True when *some* active ban (game-level or per-group) blocks the
  // user from joining the (optionally) specified group.
  banned: boolean;
  // "game" when a game-level ban applies; "group" when only a per-group
  // ban applies; null when not banned. Game wins on tie since it's
  // strictly broader.
  scope: "game" | "group" | null;
  // Reason text from the active ban, surfaced in the error message.
  reason: string | null;
  // Active expiry timestamp, when the active ban has one (null for a
  // permanent ban or when not banned).
  expiresAt: Date | null;
}

const NOT_BANNED: BanCheckResult = {
  banned: false,
  scope: null,
  reason: null,
  expiresAt: null,
};

// Centralized ban predicate used by every membership-creating route
// (public-join, invitation-accept, bulk-invite). Returns the banned
// state without throwing so callers can shape the response (HTTP 403,
// per-row error in bulk-invite, etc.).
//
// Order matters: a game-level ban is reported first because it's
// strictly broader and the message should reflect the wider exclusion.
//
// `groupId` is optional. When omitted, only the game-level check runs.
// Pass it to also check the per-group `GroupMember.status="banned"`
// row for this user.
export async function checkBanState(
  client: PrismaClient | Prisma.TransactionClient,
  gameId: string,
  junjoUserId: string,
  groupId?: string,
  now: Date = new Date(),
): Promise<BanCheckResult> {
  const gameBan = await client.gameBan.findUnique({
    where: { gameId_junjoUserId: { gameId, junjoUserId } },
    select: { reason: true, expiresAt: true },
  });
  if (gameBan && isActiveBan(gameBan.expiresAt, now)) {
    return {
      banned: true,
      scope: "game",
      reason: gameBan.reason,
      expiresAt: gameBan.expiresAt,
    };
  }

  if (groupId !== undefined) {
    const member = await client.groupMember.findUnique({
      where: { groupId_junjoUserId: { groupId, junjoUserId } },
      select: { status: true, bannedUntil: true },
    });
    if (member?.status === "banned" && isActiveBan(member.bannedUntil, now)) {
      return {
        banned: true,
        scope: "group",
        // Per-group bans don't store reason on the GroupMember row
        // today; the `reason` lives on the audit entry. Bulk-invite
        // and other callers can look it up if they care.
        reason: null,
        expiresAt: member.bannedUntil,
      };
    }
  }

  return NOT_BANNED;
}

// Convenience: format the user-facing error message for a positive
// ban hit. Routes typically wrap this in `Errors.banned(...)`.
export function banErrorMessage(result: BanCheckResult): string {
  if (!result.banned) return "user is banned";
  const scopeWord = result.scope === "game" ? "game" : "group";
  if (result.expiresAt) {
    return `user is banned from this ${scopeWord} until ${result.expiresAt.toISOString()}`;
  }
  return `user is banned from this ${scopeWord}`;
}
