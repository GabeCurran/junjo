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
// retry the whole transaction. Prisma reports it as P2034 from model
// queries and as P2010 carrying SQLSTATE 40001 or 40P01 from raw ones.
export function isSerializationFailure(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code === "P2034") return true;
  const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
  return err.code === "P2010" && (sqlState === "40001" || sqlState === "40P01");
}

// SQLSTATEs Postgres raises when a value holds U+0000, which neither
// `text` (22021) nor `jsonb` (22P05) can store.
const NUL_SQLSTATES = ["22021", "22P05"];

// True when Postgres refused a value because it contains U+0000. Model
// queries surface this as an unknown request error whose message names
// the SQLSTATE; raw queries surface it as P2010 with the SQLSTATE in
// `meta.code`.
export function isNulCharacterError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2010") {
    const sqlState = (err.meta as { code?: unknown } | undefined)?.code;
    return typeof sqlState === "string" && NUL_SQLSTATES.includes(sqlState);
  }
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return NUL_SQLSTATES.some((state) => err.message.includes(`code: "${state}"`));
  }
  return false;
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
