import type { PrismaClient } from "@prisma/client";

// Test-only helpers shared by several suites.

// Polls `check` every few milliseconds; rejects when it still fails
// after `timeoutMs`.
export async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
}

// One person holding `first` and `second`, linked a minute apart in that
// order, and an active member of `groupId` when given. Returns the
// person's JunjoUser id.
export async function seedLinkedPerson(
  prisma: PrismaClient,
  gameId: string,
  first: string,
  second: string,
  groupId?: string,
): Promise<string> {
  const user = await prisma.junjoUser.create({ data: {} });
  const t0 = new Date("2026-11-01T00:00:00.000Z");
  await prisma.externalIdentity.create({
    data: { gameId, junjoUserId: user.id, externalUserId: first, linkedAt: t0 },
  });
  await prisma.externalIdentity.create({
    data: {
      gameId,
      junjoUserId: user.id,
      externalUserId: second,
      linkedAt: new Date(t0.getTime() + 60_000),
    },
  });
  if (groupId) {
    await prisma.groupMember.create({ data: { groupId, junjoUserId: user.id, status: "active" } });
  }
  return user.id;
}

// The game's logged event payloads in stream order, optionally of one
// type.
export async function loggedEvents(
  prisma: PrismaClient,
  gameId: string,
  type?: string,
): Promise<Record<string, unknown>[]> {
  const rows = await prisma.eventLog.findMany({
    where: { gameId, ...(type ? { type } : {}) },
    orderBy: { seq: "asc" },
  });
  return rows.map((r) => r.payload as Record<string, unknown>);
}
