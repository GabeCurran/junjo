import { afterAll, beforeAll, bench, describe } from "vitest";
import {
  type BenchContext,
  disconnectBenchPrisma,
  ensureBenchSeed,
  isBenchDatabaseConfigured,
} from "./setup.js";

const ENABLED = isBenchDatabaseConfigured();

let ctx: BenchContext | null = null;

beforeAll(async () => {
  if (!ENABLED) return;
  ctx = await ensureBenchSeed();
}, 600_000);

afterAll(async () => {
  if (!ENABLED) return;
  await disconnectBenchPrisma();
});

describe.skipIf(!ENABLED)("groups.list (10K rows, gameId-scoped)", () => {
  bench("first page (limit=50, no cursor)", async () => {
    if (!ctx) return;
    const groups = await ctx.prisma.group.findMany({
      where: { gameId: ctx.gameId, softDeletedAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    if (groups.length === 0) throw new Error("bench: empty page");
    await ctx.prisma.groupMember.groupBy({
      by: ["groupId"],
      where: { groupId: { in: groups.slice(0, 50).map((g) => g.id) }, status: "active" },
      _count: { _all: true },
    });
  });

  bench("mid-list page (limit=50, cursor at ~5000)", async () => {
    if (!ctx) return;
    const cursorRow = await ctx.prisma.group.findFirst({
      where: { id: ctx.midGroupId, gameId: ctx.gameId },
      select: { id: true, createdAt: true },
    });
    if (!cursorRow) throw new Error("bench: cursor row missing");
    const groups = await ctx.prisma.group.findMany({
      where: {
        gameId: ctx.gameId,
        softDeletedAt: null,
        OR: [
          { createdAt: { lt: cursorRow.createdAt } },
          { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    await ctx.prisma.groupMember.groupBy({
      by: ["groupId"],
      where: { groupId: { in: groups.slice(0, 50).map((g) => g.id) }, status: "active" },
      _count: { _all: true },
    });
  });
});

describe.skipIf(!ENABLED)("members.list (10 active per group, paginated)", () => {
  bench("first page (limit=50, no cursor)", async () => {
    if (!ctx) return;
    const members = await ctx.prisma.groupMember.findMany({
      where: { groupId: ctx.sampleGroupId },
      orderBy: [{ joinedAt: "desc" }, { id: "desc" }],
      take: 51,
    });
    if (members.length === 0) throw new Error("bench: empty members page");
    const memberIds = members.slice(0, 50).map((m) => m.id);
    const junjoIds = members.slice(0, 50).map((m) => m.junjoUserId);
    await ctx.prisma.memberRole.findMany({
      where: { groupMemberId: { in: memberIds } },
      select: { groupMemberId: true, roleId: true },
    });
    await ctx.prisma.externalIdentity.findMany({
      where: { gameId: ctx.gameId, junjoUserId: { in: junjoIds } },
      select: { junjoUserId: true, externalUserId: true },
    });
  });
});

describe.skipIf(!ENABLED)("audit.list (50K rows total)", () => {
  bench("group-scoped, no filter (limit=50)", async () => {
    if (!ctx) return;
    await ctx.prisma.auditEntry.findMany({
      where: { groupId: ctx.sampleGroupId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
  });

  bench("group-scoped, single-action filter (limit=50)", async () => {
    if (!ctx) return;
    await ctx.prisma.auditEntry.findMany({
      where: { groupId: ctx.sampleGroupId, action: { in: ["member.joined"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
  });

  bench("group-scoped, before-cursor walk (limit=50)", async () => {
    if (!ctx) return;
    const head = await ctx.prisma.auditEntry.findFirst({
      where: { groupId: ctx.sampleGroupId },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!head) return;
    await ctx.prisma.auditEntry.findMany({
      where: { groupId: ctx.sampleGroupId, createdAt: { lt: head.createdAt } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 51,
    });
  });
});
