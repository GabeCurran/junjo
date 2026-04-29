import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

type IdentityClient = PrismaClient | Prisma.TransactionClient;

// Resolves a dev's external user id (Clerk sub, Supabase uuid, Roblox UserId
// as string) to an internal JunjoUser id, creating both the user and the
// ExternalIdentity row on first sight. The returned junjoUserId is the
// stable cross-game identifier; downstream rows (GroupMember, AuditEntry)
// reference it.
//
// Race-safe: the unique index on `(gameId, externalUserId)` serializes
// concurrent first-time creates. The loser of the race catches Prisma's
// P2002 unique-constraint violation, lets its inner transaction roll back
// (so its candidate JunjoUser never lands), and re-selects the winner's
// mapping.
//
// Must be called with a top-level PrismaClient, not a Prisma.TransactionClient.
// Postgres marks a transaction as failed after a unique-constraint violation
// and refuses subsequent statements until rollback, so the helper can only
// recover when it owns the failing transaction. Callers that need atomicity
// with downstream writes (GroupMember + AuditEntry + Invitation update)
// should resolve the user first via this helper, then enter their main
// transaction with the resolved junjoUserId.
export async function findOrCreateJunjoUser(
  prisma: PrismaClient,
  gameId: string,
  externalUserId: string,
): Promise<string> {
  const existing = await prisma.externalIdentity.findUnique({
    where: { gameId_externalUserId: { gameId, externalUserId } },
    select: { junjoUserId: true },
  });
  if (existing) return existing.junjoUserId;

  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.junjoUser.create({ data: {} });
      await tx.externalIdentity.create({
        data: { gameId, junjoUserId: user.id, externalUserId },
      });
      return user.id;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.externalIdentity.findUnique({
        where: { gameId_externalUserId: { gameId, externalUserId } },
        select: { junjoUserId: true },
      });
      if (winner) return winner.junjoUserId;
      // Vanishingly rare: the winner's transaction also rolled back between
      // their commit and our re-select. Retry once; further conflicts are
      // legitimate persistent failures and surface as P2002 on the next pass.
      return findOrCreateJunjoUser(prisma, gameId, externalUserId);
    }
    throw err;
  }
}

// Read-only counterpart for routes that operate on an existing user
// (leave, kick, future member.get). Returns null when no ExternalIdentity
// row exists for the (gameId, externalUserId) pair, which the caller
// translates into a 404 on the consuming resource (e.g. "member" not
// "user", since the user might exist for other purposes).
export async function findJunjoUserId(
  client: IdentityClient,
  gameId: string,
  externalUserId: string,
): Promise<string | null> {
  const row = await client.externalIdentity.findUnique({
    where: { gameId_externalUserId: { gameId, externalUserId } },
    select: { junjoUserId: true },
  });
  return row?.junjoUserId ?? null;
}
