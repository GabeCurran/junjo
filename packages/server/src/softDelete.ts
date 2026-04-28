import type { PrismaClient } from "@prisma/client";

export const SOFT_DELETE_RETENTION_DAYS = 7;
export const HARD_DELETE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SweepOptions {
  retentionDays?: number;
  now?: Date;
}

// Hard-deletes every Group whose softDeletedAt is older than the
// retention window. Cascade rules on the schema take care of related
// rows. Returns the number of groups removed so the caller can log it.
export async function sweepHardDeletes(
  prisma: PrismaClient,
  opts: SweepOptions = {},
): Promise<number> {
  const retentionDays = opts.retentionDays ?? SOFT_DELETE_RETENTION_DAYS;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const result = await prisma.group.deleteMany({
    where: { softDeletedAt: { lt: cutoff } },
  });
  return result.count;
}

export interface SweeperHandle {
  stop(): void;
}

// In-process scheduler. Production wires this from `index.ts` so the
// sweep runs hourly inside the same Node process as the API. Importing
// it does nothing on its own; call `startHardDeleteSweeper(prisma)` to
// schedule. Tests do not start the timer; they call `sweepHardDeletes`
// directly.
export function startHardDeleteSweeper(
  prisma: PrismaClient,
  opts: { intervalMs?: number; retentionDays?: number } = {},
): SweeperHandle {
  const intervalMs = opts.intervalMs ?? HARD_DELETE_SWEEP_INTERVAL_MS;
  const retentionDays = opts.retentionDays ?? SOFT_DELETE_RETENTION_DAYS;

  const tick = async () => {
    try {
      const removed = await sweepHardDeletes(prisma, { retentionDays });
      if (removed > 0) {
        console.log(`[junjo-server] hard-deleted ${removed} expired soft-deleted group(s)`);
      }
    } catch (err) {
      console.error("[junjo-server] hard-delete sweep failed", err);
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
