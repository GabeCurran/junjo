import type { GameId, GroupId, GroupUpdatedEvent } from "@junjo.io/shared";
import { type Group, Prisma, type PrismaClient } from "@prisma/client";
import { Errors } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { publishStagedEvents, stageEvent, toPublicGroup } from "../events.js";
import { retryOnSerializationFailure } from "../prismaErrors.js";
import { MAX_PARENT_DEPTH } from "./groups.schema.js";

// Walks the candidate parent's ancestor chain and throws parent_cycle
// if `groupId` appears (or on self-parent). 404s when the candidate
// parent does not exist in the game or is soft-deleted.
async function assertNoParentCycle(
  tx: Prisma.TransactionClient,
  gameId: string,
  groupId: string,
  parentGroupId: string,
): Promise<void> {
  if (parentGroupId === groupId) throw Errors.parentCycle();

  const parent = await tx.group.findFirst({
    where: { id: parentGroupId, gameId, softDeletedAt: null },
    select: { id: true, parentGroupId: true },
  });
  if (!parent) throw Errors.notFound("group");

  let cursor: { id: string; parentGroupId: string | null } | null = parent;
  let depth = 0;
  while (cursor && cursor.parentGroupId !== null && depth < MAX_PARENT_DEPTH) {
    if (cursor.parentGroupId === groupId) throw Errors.parentCycle();
    cursor = await tx.group.findUnique({
      where: { id: cursor.parentGroupId },
      select: { id: true, parentGroupId: true },
    });
    depth++;
  }
}

// Sets or clears a group's parent pointer. The cycle walk runs INSIDE
// a SERIALIZABLE transaction together with the write: under plain READ
// COMMITTED two concurrent PUT /parent calls (A.parent=B, B.parent=A)
// each see an acyclic graph, both commit, and permanently close a
// 2-cycle in the hierarchy. Serializable isolation makes Postgres
// abort one of them (P2034), which is retried and then correctly
// rejected by the re-run walk. Shared by the per-game and admin
// routes; the caller serializes the returned row for its own wire
// shape.
export async function setGroupParentSafely(
  prisma: PrismaClient,
  hub: EventHub,
  args: { gameId: string; groupId: string; parentGroupId: string | null },
): Promise<{ row: Group; memberCount: number }> {
  const { gameId, groupId, parentGroupId } = args;
  const outcome = await retryOnSerializationFailure(() =>
    prisma.$transaction(
      async (tx) => {
        const group = await tx.group.findFirst({
          where: { id: groupId, gameId, softDeletedAt: null },
        });
        if (!group) throw Errors.notFound("group");

        if (parentGroupId !== null) {
          await assertNoParentCycle(tx, gameId, group.id, parentGroupId);
        }

        if (group.parentGroupId === parentGroupId) {
          const count = await tx.groupMember.count({
            where: { groupId: group.id, status: "active" },
          });
          return { row: group, memberCount: count, event: null };
        }

        const result = await tx.group.update({
          where: { id: group.id },
          data: { parentGroupId },
        });
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: group.id,
            actorUserId: null,
            action: parentGroupId === null ? "group.parent.cleared" : "group.parent.set",
            targetId: parentGroupId,
            payload: {
              before: group.parentGroupId,
              after: parentGroupId,
            } as Prisma.InputJsonValue,
          },
        });
        // Counted inside the transaction so the staged group.updated
        // payload reflects the committed row.
        const count = await tx.groupMember.count({
          where: { groupId: result.id, status: "active" },
        });
        const staged = await stageEvent<GroupUpdatedEvent>(tx, {
          type: "group.updated",
          gameId: gameId as GameId,
          groupId: result.id as GroupId,
          group: toPublicGroup(result, count),
        });
        return { row: result, memberCount: count, event: staged };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );

  if (outcome.event) publishStagedEvents(hub, outcome.event);
  return { row: outcome.row, memberCount: outcome.memberCount };
}
