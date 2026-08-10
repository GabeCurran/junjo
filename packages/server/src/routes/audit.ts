import type { AuditEntry, Prisma, PrismaClient } from "@prisma/client";
import type { Context } from "hono";
import { Errors } from "../errors.js";
import { listAuditQuery } from "./audit.schema.js";

export interface WireAuditEntry {
  id: string;
  // Null for game-scoped events (e.g. game.user.banned). Non-null for
  // every per-group action.
  groupId: string | null;
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

// Resolves the `before` query param into a Prisma filter. `before`
// accepts either an audit entry id (what `nextCursor` returns: exact
// keyset pagination on the `(createdAt, id)` sort, immune to rows
// sharing a millisecond) or a bare ISO timestamp (the original
// contract, kept working for stored cursors and hand-written calls;
// strictly-older-than semantics). The id lookup is scoped so a cursor
// from another game or group reads as invalid rather than leaking
// whether the row exists.
// Only strings that LOOK like ISO dates take the timestamp path;
// Date.parse alone is too lenient ("123" parses as year 123 and would
// silently return an empty page instead of the invalid-cursor 400).
const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

export async function auditBeforeFilter(
  prisma: PrismaClient,
  before: string | undefined,
  scope: Prisma.AuditEntryWhereInput,
): Promise<Prisma.AuditEntryWhereInput> {
  if (!before) return {};
  if (ISO_DATE_PREFIX.test(before)) {
    if (Number.isNaN(Date.parse(before))) throw Errors.badRequest("invalid cursor");
    return { createdAt: { lt: new Date(before) } };
  }
  const row = await prisma.auditEntry.findFirst({
    where: { id: before, ...scope },
    select: { id: true, createdAt: true },
  });
  if (!row) throw Errors.badRequest("invalid cursor");
  return {
    OR: [{ createdAt: { lt: row.createdAt } }, { createdAt: row.createdAt, id: { lt: row.id } }],
  };
}

// Caller pages by passing `nextCursor` (the id of the last item) back
// as `before` on the next call.
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
    AND: [await auditBeforeFilter(prisma, before, { groupId: group.id })],
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
  const nextCursor = hasMore && lastItem ? lastItem.id : null;

  return c.json({
    items: sliced.map(serializeAuditEntry),
    nextCursor,
  });
}
