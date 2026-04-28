import type { Prisma, PrismaClient } from "@prisma/client";

type IdentityClient = PrismaClient | Prisma.TransactionClient;

// Resolves a dev's external user id (Clerk sub, Supabase uuid, Roblox UserId
// as string) to an internal JunjoUser id, creating both the user and the
// ExternalIdentity row on first sight. Phase 10 will extend this with the
// cross-game cloud-only resolution; the V1 self-host pathway needs the same
// find-or-create at minimum to seat a `GroupMember` row.
//
// Pass a transaction client when this is part of a multi-write flow so the
// user-create and the consuming write commit atomically. The unique index
// on `(gameId, externalUserId)` keeps double-writes safe under contention:
// a racing transaction can lose the create but its retry path will read the
// winner via findUnique.
export async function findOrCreateJunjoUser(
  client: IdentityClient,
  gameId: string,
  externalUserId: string,
): Promise<string> {
  const existing = await client.externalIdentity.findUnique({
    where: { gameId_externalUserId: { gameId, externalUserId } },
    select: { junjoUserId: true },
  });
  if (existing) return existing.junjoUserId;

  const user = await client.junjoUser.create({ data: {} });
  await client.externalIdentity.create({
    data: { gameId, junjoUserId: user.id, externalUserId },
  });
  return user.id;
}
