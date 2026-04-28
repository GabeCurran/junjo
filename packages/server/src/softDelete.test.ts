import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGame } from "./seed.js";
import { sweepHardDeletes } from "./softDelete.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("sweepHardDeletes", () => {
  let prisma: PrismaClient;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "GroupMember", "JunjoUser", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Sweep Game", prisma);
    gameId = game.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seed(name: string, softDeletedAt: Date | null) {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        metadata: {},
        softDeletedAt,
      },
    });
  }

  it("removes groups soft-deleted past the retention window", async () => {
    const now = new Date("2026-04-28T12:00:00Z");
    const expired = await seed("expired", new Date("2026-04-20T00:00:00Z"));
    const recent = await seed("recent", new Date("2026-04-27T00:00:00Z"));
    const live = await seed("live", null);

    const removed = await sweepHardDeletes(prisma, { now });
    expect(removed).toBe(1);

    expect(await prisma.group.findUnique({ where: { id: expired.id } })).toBeNull();
    expect(await prisma.group.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await prisma.group.findUnique({ where: { id: live.id } })).not.toBeNull();
  });

  it("returns 0 when nothing matches the cutoff", async () => {
    const now = new Date("2026-04-28T12:00:00Z");
    await seed("recent", new Date("2026-04-27T00:00:00Z"));
    await seed("live", null);

    const removed = await sweepHardDeletes(prisma, { now });
    expect(removed).toBe(0);
  });

  it("respects a custom retentionDays override", async () => {
    const now = new Date("2026-04-28T12:00:00Z");
    const old = await seed("old", new Date("2026-04-26T00:00:00Z"));
    await seed("live", null);

    const removed = await sweepHardDeletes(prisma, { now, retentionDays: 1 });
    expect(removed).toBe(1);
    expect(await prisma.group.findUnique({ where: { id: old.id } })).toBeNull();
  });
});
