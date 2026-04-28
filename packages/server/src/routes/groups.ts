import type { Group, Prisma, PrismaClient } from "@prisma/client";
import { Hono } from "hono";
import { Errors } from "../errors.js";
import { createGroupBody, listGroupsQuery, updateGroupBody } from "./groups.schema.js";

interface WireGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  memberCount: number;
  createdAt: string;
  updatedAt: string;
  softDeletedAt: string | null;
}

export function serializeGroup(group: Group, memberCount: number): WireGroup {
  return {
    id: group.id,
    gameId: group.gameId,
    kind: group.kind,
    name: group.name,
    visibility: group.visibility,
    metadata: (group.metadata ?? {}) as Record<string, unknown>,
    defaultRoleId: group.defaultRoleId,
    memberCount,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    softDeletedAt: group.softDeletedAt ? group.softDeletedAt.toISOString() : null,
  };
}

export function groupsRouter(prisma: PrismaClient): Hono {
  const r = new Hono();

  r.get("/", async (c) => {
    const gameId = c.var.gameId;
    const parsed = listGroupsQuery.safeParse({
      limit: c.req.query("limit"),
      cursor: c.req.query("cursor"),
      gameId: c.req.query("gameId"),
    });
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid query");
    }
    const { limit, cursor, gameId: filterGameId } = parsed.data;
    if (filterGameId !== undefined && filterGameId !== gameId) {
      throw Errors.badRequest("gameId must match the calling game");
    }

    let cursorRow: { id: string; createdAt: Date } | null = null;
    if (cursor) {
      const row = await prisma.group.findFirst({
        where: { id: cursor, gameId },
        select: { id: true, createdAt: true },
      });
      if (!row) throw Errors.badRequest("invalid cursor");
      cursorRow = row;
    }

    const where: Prisma.GroupWhereInput = {
      gameId,
      softDeletedAt: null,
      ...(cursorRow
        ? {
            OR: [
              { createdAt: { lt: cursorRow.createdAt } },
              { createdAt: cursorRow.createdAt, id: { lt: cursorRow.id } },
            ],
          }
        : {}),
    };

    const groups = await prisma.group.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const hasMore = groups.length > limit;
    const sliced = hasMore ? groups.slice(0, limit) : groups;

    const counts =
      sliced.length === 0
        ? []
        : await prisma.groupMember.groupBy({
            by: ["groupId"],
            where: { groupId: { in: sliced.map((g) => g.id) }, status: "active" },
            _count: { _all: true },
          });
    const countMap = new Map(counts.map((c) => [c.groupId, c._count._all]));

    const lastItem = sliced[sliced.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.id : null;

    return c.json({
      items: sliced.map((g) => serializeGroup(g, countMap.get(g.id) ?? 0)),
      nextCursor,
    });
  });

  r.get("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const group = await prisma.group.findFirst({
      where: { id, gameId, softDeletedAt: null },
    });
    if (!group) throw Errors.notFound("group");
    const memberCount = await prisma.groupMember.count({
      where: { groupId: group.id, status: "active" },
    });
    return c.json(serializeGroup(group, memberCount));
  });

  r.post("/", async (c) => {
    const json = await c.req.json().catch(() => null);
    const parsed = createGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;
    const gameId = c.var.gameId;

    const metadataInput = (body.metadata ?? {}) as Prisma.InputJsonValue;

    const group = await prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          gameId,
          kind: body.kind,
          name: body.name,
          visibility: body.visibility ?? "invite-only",
          metadata: metadataInput,
          defaultRoleId: body.defaultRoleId,
        },
      });
      await tx.auditEntry.create({
        data: {
          groupId: created.id,
          actorUserId: null,
          action: "group.created",
          targetId: created.id,
          payload: {
            kind: created.kind,
            name: created.name,
            visibility: created.visibility,
            metadata: metadataInput,
            defaultRoleId: created.defaultRoleId,
          } as Prisma.InputJsonValue,
        },
      });
      return created;
    });

    return c.json(serializeGroup(group, 0), 201);
  });

  r.patch("/:id", async (c) => {
    const id = c.req.param("id");
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const parsed = updateGroupBody.safeParse(json);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw Errors.badRequest(issues || "invalid request body");
    }
    const body = parsed.data;

    const updated = await prisma.$transaction(async (tx) => {
      const existing = await tx.group.findFirst({
        where: { id, gameId, softDeletedAt: null },
      });
      if (!existing) throw Errors.notFound("group");

      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const data: Prisma.GroupUpdateInput = {};

      if (body.name !== undefined && body.name !== existing.name) {
        before.name = existing.name;
        after.name = body.name;
        data.name = body.name;
      }
      if (body.visibility !== undefined && body.visibility !== existing.visibility) {
        before.visibility = existing.visibility;
        after.visibility = body.visibility;
        data.visibility = body.visibility;
      }
      if (body.metadata !== undefined) {
        before.metadata = (existing.metadata ?? {}) as Prisma.InputJsonValue;
        after.metadata = body.metadata;
        data.metadata = body.metadata as Prisma.InputJsonValue;
      }
      if (body.defaultRoleId !== undefined && body.defaultRoleId !== existing.defaultRoleId) {
        before.defaultRoleId = existing.defaultRoleId;
        after.defaultRoleId = body.defaultRoleId;
        data.defaultRoleId = body.defaultRoleId;
      }

      if (Object.keys(data).length === 0) {
        return existing;
      }

      const result = await tx.group.update({
        where: { id: existing.id },
        data,
      });

      await tx.auditEntry.create({
        data: {
          groupId: result.id,
          actorUserId: null,
          action: "group.updated",
          targetId: result.id,
          payload: { before, after } as Prisma.InputJsonValue,
        },
      });

      return result;
    });

    const memberCount = await prisma.groupMember.count({
      where: { groupId: updated.id, status: "active" },
    });
    return c.json(serializeGroup(updated, memberCount));
  });

  return r;
}
