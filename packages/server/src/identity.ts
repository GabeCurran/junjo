import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

type IdentityClient = PrismaClient | Prisma.TransactionClient;

// Race-safe via the `(gameId, externalUserId)` unique index. The loser of
// a concurrent first-time create catches Prisma's P2002, lets its inner
// transaction roll back (so its candidate JunjoUser never lands), and
// re-selects the winner's mapping.
//
// MUST receive a top-level PrismaClient, not a TransactionClient: Postgres
// marks a transaction as failed after a unique-constraint violation and
// refuses subsequent statements until rollback, so the helper can only
// recover when it owns the failing transaction. Callers that need
// atomicity with downstream writes resolve the user first, then enter
// their main transaction with the resolved junjoUserId.
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

// Returns null when no ExternalIdentity row exists. Callers translate
// that into a 404 on the consuming resource (e.g. "member" not "user",
// since the user might exist for other purposes).
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
