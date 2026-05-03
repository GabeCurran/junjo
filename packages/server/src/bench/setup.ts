import { PrismaClient } from "@prisma/client";

// Targets match VISION Phase 14.11. Bumping any value invalidates the
// committed baseline; bump `BENCH_MARKER_NAME` together so a stale seed
// is detected and rebuilt on the next run.
export const BENCH_TARGETS = {
  groups: 10000,
  members: 100000,
  audit: 50000,
} as const;

export const BENCH_MARKER_NAME = "__bench_marker_v1__";
export const BENCH_PERMISSION_KEY = "bench.action";
export const BENCH_INSERT_BATCH = 1000;

let cachedPrisma: PrismaClient | null = null;

export function getBenchDatabaseUrl(): string {
  const url = process.env.BENCH_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url || url.length === 0) {
    throw new Error(
      "BENCH_DATABASE_URL (or TEST_DATABASE_URL fallback) is not set. " +
        "See packages/server/README.md (Performance benchmarks) for setup.",
    );
  }
  return url;
}

export function isBenchDatabaseConfigured(): boolean {
  const url = process.env.BENCH_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  return Boolean(url && url.length > 0);
}

export function getBenchPrisma(): PrismaClient {
  if (!cachedPrisma) {
    cachedPrisma = new PrismaClient({
      datasources: { db: { url: getBenchDatabaseUrl() } },
      log: ["warn", "error"],
    });
  }
  return cachedPrisma;
}

export async function disconnectBenchPrisma(): Promise<void> {
  if (cachedPrisma) {
    await cachedPrisma.$disconnect();
    cachedPrisma = null;
  }
}

export interface BenchContext {
  prisma: PrismaClient;
  gameId: string;
  sampleGroupId: string;
  // Dev-supplied externalUserId of a member of `sampleGroupId`. The
  // member has one role granting `BENCH_PERMISSION_KEY`, so a permission
  // check returns `{ allowed: true, source: "role" }`.
  sampleExternalUserId: string;
  sampleJunjoUserId: string;
  // Cursor pointing roughly halfway into the group list, so a paginated
  // query exercises an index seek instead of the table head.
  midGroupId: string;
}

const TRUNCATE_SQL =
  'TRUNCATE TABLE "WebhookDelivery", "WebhookEndpoint", "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE';

export async function ensureBenchSeed(): Promise<BenchContext> {
  const prisma = getBenchPrisma();
  const marker = await prisma.game.findFirst({ where: { name: BENCH_MARKER_NAME } });
  if (marker) {
    return loadContext(prisma, marker.id);
  }
  await prisma.$executeRawUnsafe(TRUNCATE_SQL);
  const game = await prisma.game.create({ data: { name: BENCH_MARKER_NAME } });
  await seed(prisma, game.id);
  return loadContext(prisma, game.id);
}

async function seed(prisma: PrismaClient, gameId: string): Promise<void> {
  // Spread createdAt across a 10-day window so cursor pagination over
  // distinct timestamps exercises the composite index, not a tie-break.
  const baseTime = Date.now() - 10 * 24 * 60 * 60 * 1000;

  for (let i = 0; i < BENCH_TARGETS.groups; i += BENCH_INSERT_BATCH) {
    const data: {
      gameId: string;
      kind: string;
      name: string;
      visibility: string;
      createdAt: Date;
    }[] = [];
    const end = Math.min(i + BENCH_INSERT_BATCH, BENCH_TARGETS.groups);
    for (let idx = i; idx < end; idx++) {
      data.push({
        gameId,
        kind:
          idx % 4 === 0 ? "guild" : idx % 4 === 1 ? "clan" : idx % 4 === 2 ? "faction" : "party",
        name: `Bench Group ${idx}`,
        visibility: idx % 3 === 0 ? "public" : "invite-only",
        createdAt: new Date(baseTime + idx * 1000),
      });
    }
    await prisma.group.createMany({ data });
  }

  const groupRows = await prisma.group.findMany({
    where: { gameId },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  const groupIds = groupRows.map((r) => r.id);
  if (groupIds.length === 0) throw new Error("bench seed: group insert returned no rows");

  for (let i = 0; i < BENCH_TARGETS.members; i += BENCH_INSERT_BATCH) {
    const data: object[] = [];
    const end = Math.min(i + BENCH_INSERT_BATCH, BENCH_TARGETS.members);
    for (let idx = i; idx < end; idx++) data.push({});
    await prisma.junjoUser.createMany({ data });
  }

  const userRows = await prisma.junjoUser.findMany({
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (userRows.length < BENCH_TARGETS.members) {
    throw new Error(`bench seed: expected ${BENCH_TARGETS.members} users, got ${userRows.length}`);
  }

  for (let i = 0; i < userRows.length; i += BENCH_INSERT_BATCH) {
    const data: { gameId: string; junjoUserId: string; externalUserId: string }[] = [];
    const end = Math.min(i + BENCH_INSERT_BATCH, userRows.length);
    for (let idx = i; idx < end; idx++) {
      const row = userRows[idx];
      if (!row) continue;
      data.push({
        gameId,
        junjoUserId: row.id,
        externalUserId: `bench_user_${idx}`,
      });
    }
    await prisma.externalIdentity.createMany({ data });
  }

  for (let i = 0; i < userRows.length; i += BENCH_INSERT_BATCH) {
    const data: { groupId: string; junjoUserId: string; status: string; joinedAt: Date }[] = [];
    const end = Math.min(i + BENCH_INSERT_BATCH, userRows.length);
    for (let idx = i; idx < end; idx++) {
      const row = userRows[idx];
      if (!row) continue;
      const targetGroupId = groupIds[idx % groupIds.length];
      if (!targetGroupId) continue;
      data.push({
        groupId: targetGroupId,
        junjoUserId: row.id,
        status: "active",
        joinedAt: new Date(baseTime + idx * 100),
      });
    }
    await prisma.groupMember.createMany({ data });
  }

  for (let i = 0; i < BENCH_TARGETS.audit; i += BENCH_INSERT_BATCH) {
    const data: { groupId: string; action: string; createdAt: Date }[] = [];
    const end = Math.min(i + BENCH_INSERT_BATCH, BENCH_TARGETS.audit);
    for (let idx = i; idx < end; idx++) {
      const targetGroupId = groupIds[idx % groupIds.length];
      if (!targetGroupId) continue;
      data.push({
        groupId: targetGroupId,
        action: idx % 3 === 0 ? "member.joined" : idx % 3 === 1 ? "member.left" : "role.assigned",
        createdAt: new Date(baseTime + idx * 500),
      });
    }
    await prisma.auditEntry.createMany({ data });
  }

  const sampleGroupId = groupIds[0];
  const firstUser = userRows[0];
  if (!sampleGroupId || !firstUser) throw new Error("bench seed: missing sample anchors");
  const sampleMember = await prisma.groupMember.findUnique({
    where: { groupId_junjoUserId: { groupId: sampleGroupId, junjoUserId: firstUser.id } },
  });
  if (!sampleMember) throw new Error("bench seed: sample member missing");

  const role = await prisma.role.create({
    data: { groupId: sampleGroupId, name: "Bench Role", priority: 100 },
  });
  await prisma.rolePermission.create({
    data: { roleId: role.id, permissionKey: BENCH_PERMISSION_KEY },
  });
  await prisma.permissionDef.create({
    data: { gameId, key: BENCH_PERMISSION_KEY },
  });
  await prisma.memberRole.create({
    data: { groupMemberId: sampleMember.id, roleId: role.id },
  });
}

async function loadContext(prisma: PrismaClient, gameId: string): Promise<BenchContext> {
  const sampleGroup = await prisma.group.findFirst({
    where: { gameId },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!sampleGroup) throw new Error("bench context: no sample group");

  const sampleIdentity = await prisma.externalIdentity.findFirst({
    where: { gameId, externalUserId: "bench_user_0" },
    select: { externalUserId: true, junjoUserId: true },
  });
  if (!sampleIdentity) throw new Error("bench context: sample identity missing");

  const midOffset = Math.floor(BENCH_TARGETS.groups / 2);
  const midGroup = await prisma.group.findFirst({
    where: { gameId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: midOffset,
  });
  if (!midGroup) throw new Error("bench context: mid group missing");

  return {
    prisma,
    gameId,
    sampleGroupId: sampleGroup.id,
    sampleExternalUserId: sampleIdentity.externalUserId,
    sampleJunjoUserId: sampleIdentity.junjoUserId,
    midGroupId: midGroup.id,
  };
}
