import { Prisma } from "@prisma/client";

// True when `err` is Postgres' unique-constraint violation surfaced
// through Prisma (P2002). Write paths that check-then-insert catch this
// so the loser of a concurrent insert reports the same domain error a
// sequential second request would have hit, instead of a generic 500.
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

// Postgres aborted the transaction to preserve its isolation level
// (serialization failure / deadlock). The canonical response is to
// retry the whole transaction.
export function isSerializationFailure(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034";
}

// Retries `fn` on serialization failures up to `attempts` total runs.
// Used by transactions that run SERIALIZABLE to close read-then-write
// races (e.g. the parent-cycle walk); persistent contention beyond the
// budget propagates and surfaces as a 500, which is the honest answer
// for pathological interleaving.
export async function retryOnSerializationFailure<T>(
  fn: () => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!isSerializationFailure(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

// Reruns `fn` exactly once when the first attempt loses a unique-race.
// For upsert-shaped writes (find -> create-or-update inside a
// transaction) the second attempt sees the winner's row and takes the
// update branch, which matches what a sequential second request does.
// A second P2002 is a genuine integrity failure and propagates.
export async function retryOnUniqueViolation<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isUniqueViolation(err)) return await fn();
    throw err;
  }
}
