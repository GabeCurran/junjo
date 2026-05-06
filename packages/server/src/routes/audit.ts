import type { AuditEntry, Prisma, PrismaClient } from "@prisma/client";
import type { Context } from "hono";
import { Errors } from "../errors.js";
import { listAuditQuery } from "./audit.schema.js";

export interface WireAuditEntry {
  id: string;
  groupId: string;
  actorUserId: string | null;
  action: string;
  targetId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function serializeAuditEntry(entry: AuditEntry): WireAuditEntry {
  return {
    id: entry.id,
    groupId: entry.groupId,
    actorUserId: entry.actorUserId,
    action: entry.action,
    targetId: entry.targetId,
    payload: (entry.payload ?? {}) as Record<string, unknown>,
    createdAt: entry.createdAt.toISOString(),
  };
}

// Caller pages by passing `nextCursor` (the ISO timestamp of the last
// item) back as `before` on the next call.
export async function listAuditForGroup(c: Context, prisma: PrismaClient, groupId: string) {
  const gameId = c.var.gameId as string;

  const group = await prisma.group.findFirst({
    where: { id: groupId, gameId, softDeletedAt: null },
    select: { id: true },
  });
  if (!group) throw Errors.notFound("group");

  const parsed = listAuditQuery.safeParse({
    limit: c.req.query("limit"),
    before: c.req.query("before"),
    actions: c.req.queries("actions"),
  });
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw Errors.badRequest(issues || "invalid query");
  }
  const { limit, before, actions } = parsed.data;

  const where: Prisma.AuditEntryWhereInput = {
    groupId: group.id,
    ...(before ? { createdAt: { lt: new Date(before) } } : {}),
    ...(actions && actions.length > 0 ? { action: { in: actions } } : {}),
  };

  const entries = await prisma.auditEntry.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });
  const hasMore = entries.length > limit;
  const sliced = hasMore ? entries.slice(0, limit) : entries;
  const lastItem = sliced[sliced.length - 1];
  const nextCursor = hasMore && lastItem ? lastItem.createdAt.toISOString() : null;

  return c.json({
    items: sliced.map(serializeAuditEntry),
    nextCursor,
  });
}
