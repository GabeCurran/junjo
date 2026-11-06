import { Prisma } from "@prisma/client";

// Transaction-scoped advisory lock on the key made of `parts`, released
// at commit or rollback. JSON keeps the parts unambiguous; callers lead
// with a scope name so unrelated keys cannot meet.
export async function lockKey(
  tx: Prisma.TransactionClient,
  parts: readonly string[],
): Promise<void> {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(parts)}, 0))`,
  );
}
