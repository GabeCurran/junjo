import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAST_ACTIVITY_OVERLAP_MS,
  catchUpLastActivity,
  catchUpLastActivityBatch,
  startLastActivityJob,
} from "./lastActivity.js";
import { createGame } from "./seed.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const TRUNCATE =
  'TRUNCATE TABLE "AuditEntry", "ExternalIdentity", "JunjoUser", "Game" RESTART IDENTITY CASCADE';
const RESET_CURSOR = `INSERT INTO "LastActivityCursor" (id, "createdAt", "auditId")
  VALUES ('lastActivity', '1970-01-01', '')
  ON CONFLICT (id) DO UPDATE SET "createdAt" = '1970-01-01', "auditId" = ''`;

const T0 = new Date("2026-10-01T00:00:00.000Z");
const SECOND_MS = 1000;

function at(seconds: number): Date {
  return new Date(T0.getTime() + seconds * SECOND_MS);
}

describe("startLastActivityJob", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeClient() {
    const transaction = vi.fn(async () => [
      0,
      0,
      [{ claimed: 0, applied: 0, reread: 0, raised: 0 }],
    ]);
    const client = {
      $transaction: transaction,
      $executeRaw: vi.fn(async () => 0),
      $executeRawUnsafe: vi.fn(async () => 0),
      $queryRaw: vi.fn(async () => []),
    };
    return { client: client as unknown as PrismaClient, transaction };
  }

  it("never runs when the interval is 0", async () => {
    vi.useFakeTimers();
    const { client, transaction } = fakeClient();
    const job = startLastActivityJob(client, { intervalMs: 0 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(transaction).not.toHaveBeenCalled();
    job.stop();
  });

  it("runs on every interval until stopped", async () => {
    vi.useFakeTimers();
    const { client, transaction } = fakeClient();
    const job = startLastActivityJob(client, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3500);
    expect(transaction).toHaveBeenCalledTimes(3);
    job.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("last activity catch-up", () => {
  let prisma: PrismaClient;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(TRUNCATE);
    await prisma.$executeRawUnsafe(RESET_CURSOR);
    gameId = (await createGame("Activity", prisma)).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedId(externalUserId: string, junjoUserId?: string): Promise<string> {
    const personId = junjoUserId ?? (await prisma.junjoUser.create({ data: {} })).id;
    await prisma.externalIdentity.create({
      data: { gameId, junjoUserId: personId, externalUserId },
    });
    return personId;
  }

  async function audit(seconds: number, fields: { targetId?: string; actorUserId?: string }) {
    return prisma.auditEntry.create({
      data: {
        gameId,
        action: "member.joined",
        targetId: fields.targetId ?? null,
        actorUserId: fields.actorUserId ?? null,
        createdAt: at(seconds),
      },
    });
  }

  async function stored(externalUserId: string): Promise<string | null> {
    const row = await prisma.externalIdentity.findUniqueOrThrow({
      where: { gameId_externalUserId: { gameId, externalUserId } },
      select: { lastActivityAt: true },
    });
    return row.lastActivityAt ? row.lastActivityAt.toISOString() : null;
  }

  async function cursor() {
    return prisma.lastActivityCursor.findUniqueOrThrow({ where: { id: "lastActivity" } });
  }

  it("applies entries after the cursor once, a batch at a time, and advances it", async () => {
    await seedId("p:a");
    const b = await seedId("p:b");
    const entries = [];
    for (let n = 1; n <= 5; n++) {
      entries.push(await audit(n * 600, { targetId: "p:a", actorUserId: n === 3 ? b : undefined }));
    }

    const first = await catchUpLastActivityBatch(prisma, { batchSize: 2 });
    expect(first).toMatchObject({ claimed: true, applied: 2, raised: 1 });
    expect(await stored("p:a")).toBe(at(1200).toISOString());
    expect(await cursor()).toMatchObject({ createdAt: at(1200), auditId: entries[1]?.id });

    const rest = await catchUpLastActivity(prisma, { batchSize: 2 });
    expect(rest).toEqual({ batches: 2, applied: 3, raised: 3 });
    expect(await stored("p:a")).toBe(at(3000).toISOString());
    expect(await stored("p:b")).toBe(at(1800).toISOString());
    expect(await cursor()).toMatchObject({ createdAt: at(3000), auditId: entries[4]?.id });

    // Nothing new: no entry is applied again and nothing is written.
    expect(await catchUpLastActivity(prisma, { batchSize: 2 })).toEqual({
      batches: 1,
      applied: 0,
      raised: 0,
    });
    expect(await cursor()).toMatchObject({ createdAt: at(3000), auditId: entries[4]?.id });
  });

  it("orders entries written in the same millisecond by id", async () => {
    await seedId("p:a");
    await seedId("p:b");
    await prisma.auditEntry.createMany({
      data: ["p:a", "p:b", "p:a"].map((targetId, n) => ({
        id: `same-${n}`,
        gameId,
        action: "member.joined",
        targetId,
        createdAt: at(60),
      })),
    });
    expect(await catchUpLastActivityBatch(prisma, { batchSize: 2 })).toMatchObject({ applied: 2 });
    expect(await cursor()).toMatchObject({ createdAt: at(60), auditId: "same-1" });
    expect(await catchUpLastActivityBatch(prisma, { batchSize: 2 })).toMatchObject({ applied: 1 });
    expect(await cursor()).toMatchObject({ createdAt: at(60), auditId: "same-2" });
    expect(await stored("p:a")).toBe(at(60).toISOString());
    expect(await stored("p:b")).toBe(at(60).toISOString());
  });

  it("applies an entry that commits after the cursor passed its time", async () => {
    await seedId("p:late");
    await seedId("p:early");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let written!: () => void;
    const inserted = new Promise<void>((resolve) => {
      written = resolve;
    });
    const slow = prisma.$transaction(
      async (tx) => {
        await tx.auditEntry.create({
          data: { gameId, action: "member.joined", targetId: "p:late", createdAt: at(10) },
        });
        written();
        await gate;
      },
      { timeout: 20_000 },
    );
    await inserted;
    await audit(20, { targetId: "p:early" });

    await catchUpLastActivity(prisma);
    expect((await cursor()).createdAt).toEqual(at(20));
    expect(await stored("p:late")).toBeNull();

    release();
    await slow;
    const next = await catchUpLastActivity(prisma);
    expect(next).toMatchObject({ applied: 0, raised: 1 });
    expect(await stored("p:late")).toBe(at(10).toISOString());
  });

  it("rereads only the overlap window behind the cursor", async () => {
    await seedId("p:inside");
    await seedId("p:outside");
    await audit(3600, {});
    await catchUpLastActivity(prisma);

    const windowSeconds = LAST_ACTIVITY_OVERLAP_MS / SECOND_MS;
    await audit(3600 - windowSeconds + 1, { targetId: "p:inside" });
    await audit(3600 - windowSeconds - 1, { targetId: "p:outside" });
    const batch = await catchUpLastActivityBatch(prisma);
    expect(batch).toMatchObject({ applied: 0, reread: 2, raised: 1 });
    expect(await stored("p:inside")).toBe(at(3600 - windowSeconds + 1).toISOString());
    expect(await stored("p:outside")).toBeNull();
  });

  it("lets one runner hold the cursor while another skips without waiting", async () => {
    await seedId("p:a");
    await audit(5, { targetId: "p:a" });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let claimed!: () => void;
    const holding = new Promise<void>((resolve) => {
      claimed = resolve;
    });
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "LastActivityCursor" WHERE id = 'lastActivity' FOR UPDATE`;
        claimed();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holding;
    const started = Date.now();
    expect(await catchUpLastActivityBatch(prisma)).toMatchObject({ claimed: false, applied: 0 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await stored("p:a")).toBeNull();
    release();
    await holder;

    expect(await catchUpLastActivityBatch(prisma)).toMatchObject({ claimed: true, applied: 1 });
    expect(await stored("p:a")).toBe(at(5).toISOString());
  });

  it("applies every entry exactly once across concurrent runners", async () => {
    const ids = Array.from({ length: 5 }, (_, n) => `p:${n}`);
    for (const id of ids) await seedId(id);
    await prisma.auditEntry.createMany({
      data: Array.from({ length: 40 }, (_, n) => ({
        gameId,
        action: "member.joined",
        targetId: ids[n % ids.length] as string,
        createdAt: at(n * 600),
      })),
    });

    const runs = await Promise.all(
      Array.from({ length: 3 }, () => catchUpLastActivity(prisma, { batchSize: 4 })),
    );
    let applied = runs.reduce((sum, r) => sum + r.applied, 0);
    // A runner that found the cursor held stops; finish whatever is left.
    applied += (await catchUpLastActivity(prisma, { batchSize: 4 })).applied;
    expect(applied).toBe(40);
    for (const [n, id] of ids.entries()) {
      expect(await stored(id)).toBe(at((35 + n) * 600).toISOString());
    }
  });

  it("starts a new identity from entries the job already applied", async () => {
    const person = await seedId("p:first");
    await audit(30, { targetId: "p:new" });
    await audit(40, { actorUserId: person });
    await catchUpLastActivity(prisma);

    await seedId("p:new");
    expect(await stored("p:new")).toBe(at(30).toISOString());
    await seedId("p:second", person);
    expect(await stored("p:second")).toBe(at(40).toISOString());
  });

  it("recreates a missing cursor and starts before every entry", async () => {
    await seedId("p:a");
    await audit(5, { targetId: "p:a" });
    await prisma.lastActivityCursor.deleteMany();

    expect(await catchUpLastActivityBatch(prisma)).toMatchObject({ claimed: false });
    expect(await cursor()).toMatchObject({ auditId: "" });
    expect(await catchUpLastActivityBatch(prisma)).toMatchObject({ claimed: true, applied: 1 });
    expect(await stored("p:a")).toBe(at(5).toISOString());
  });
});
