import { afterAll, beforeAll, bench, describe } from "vitest";
import { PermissionCache } from "../permissionCache.js";
import { resolvePermission } from "../routes/permissions.js";
import {
  BENCH_PERMISSION_KEY,
  type BenchContext,
  disconnectBenchPrisma,
  ensureBenchSeed,
  isBenchDatabaseConfigured,
} from "./setup.js";

const ENABLED = isBenchDatabaseConfigured();

let ctx: BenchContext | null = null;
let warmCache: PermissionCache | null = null;

beforeAll(async () => {
  if (!ENABLED) return;
  ctx = await ensureBenchSeed();
  warmCache = new PermissionCache();
  const result = await resolvePermission(
    ctx.prisma,
    ctx.gameId,
    ctx.sampleGroupId,
    ctx.sampleExternalUserId,
    BENCH_PERMISSION_KEY,
  );
  warmCache.set(
    ctx.gameId,
    ctx.sampleGroupId,
    ctx.sampleExternalUserId,
    BENCH_PERMISSION_KEY,
    result,
  );
}, 600_000);

afterAll(async () => {
  if (!ENABLED) return;
  await disconnectBenchPrisma();
});

describe.skipIf(!ENABLED)("permission resolution (role-derived grant)", () => {
  bench("can() cold cache (resolvePermission, full DB walk)", async () => {
    if (!ctx) return;
    await resolvePermission(
      ctx.prisma,
      ctx.gameId,
      ctx.sampleGroupId,
      ctx.sampleExternalUserId,
      BENCH_PERMISSION_KEY,
    );
  });

  bench("can() warm cache (in-memory hit)", () => {
    if (!ctx || !warmCache) return;
    const hit = warmCache.get(
      ctx.gameId,
      ctx.sampleGroupId,
      ctx.sampleExternalUserId,
      BENCH_PERMISSION_KEY,
    );
    if (!hit) throw new Error("bench: warm cache missed");
  });
});
