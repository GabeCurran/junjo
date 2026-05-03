import type { PrismaClient } from "@prisma/client";
import { logger } from "./logger.js";

export const SOFT_DELETE_RETENTION_DAYS = 7;
export const HARD_DELETE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export interface SweepOptions {
  retentionDays?: number;
  now?: Date;
}

// Cascades on the schema take care of related rows.
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
        logger.info({ removed }, "hard-deleted expired soft-deleted groups");
      }
    } catch (err) {
      logger.error({ err }, "hard-delete sweep failed");
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  if (typeof handle.unref === "function") handle.unref();
  return { stop: () => clearInterval(handle) };
}
