import { EXPORT_RECORD_KINDS, type ExportRecordKind } from "@junjo.io/shared";
import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";
import { readStreamPosition } from "../eventLog.js";
import { renderUserIds } from "../identity.js";
import { logger } from "../logger.js";
import { rowContextField } from "../permissionContext.js";
import { userIdNamespace } from "../userIdFormat.js";

// Rows read per query. Every kind is read in keyset-ordered batches of
// this size, so memory is bounded by one batch whatever the game's size.
export const EXPORT_BATCH_SIZE = 1000;

type Row = Record<string, unknown>;

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

// One batch of records of one kind, plus the keyset cursor for the next
// batch (null after the last).
interface Batch {
  records: Row[];
  next: string | null;
}

type BatchReader = (prisma: PrismaClient, gameId: string, after: string | null) => Promise<Batch>;

async function page<T extends { id: string }>(
  rows: T[],
  toRecords: (rows: T[]) => Row[] | Promise<Row[]>,
): Promise<Batch> {
  const last = rows[rows.length - 1];
  const records = await toRecords(rows);
  return { records, next: rows.length === EXPORT_BATCH_SIZE && last ? last.id : null };
}

function idAfter(after: string | null): { id?: { gt: string } } {
  return after === null ? {} : { id: { gt: after } };
}

const readers: Record<Exclude<ExportRecordKind, "game">, BatchReader> = {
  // People are keyed by their internal id; each record carries every id
  // the person holds in this game.
  person: async (prisma, gameId, after) => {
    const people = await prisma.externalIdentity.groupBy({
      by: ["junjoUserId"],
      where: { gameId, ...(after === null ? {} : { junjoUserId: { gt: after } }) },
      orderBy: { junjoUserId: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    const ids = people.map((p) => p.junjoUserId);
    const rows = await prisma.externalIdentity.findMany({
      where: { gameId, junjoUserId: { in: ids } },
      orderBy: [{ junjoUserId: "asc" }, { linkedAt: "asc" }, { id: "asc" }],
    });
    const byPerson = new Map<string, Row[]>();
    for (const r of rows) {
      const list = byPerson.get(r.junjoUserId) ?? [];
      list.push({
        userId: r.externalUserId,
        namespace: userIdNamespace(r.externalUserId),
        linkedAt: r.linkedAt.toISOString(),
        displayName: r.displayName,
        displayNameUpdatedAt: iso(r.displayNameUpdatedAt),
      });
      byPerson.set(r.junjoUserId, list);
    }
    const last = ids[ids.length - 1];
    return {
      records: ids.map((id) => ({ kind: "person", id, identities: byPerson.get(id) ?? [] })),
      next: ids.length === EXPORT_BATCH_SIZE && last ? last : null,
    };
  },

  // The passcode hash is a credential and stays out; `hasPasscode` says
  // whether one was set.
  group: async (prisma, gameId, after) => {
    const rows = await prisma.group.findMany({
      where: { gameId, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, (list) =>
      list.map((g) => ({
        kind: "group",
        id: g.id,
        groupKind: g.kind,
        name: g.name,
        visibility: g.visibility,
        metadata: g.metadata,
        defaultRoleId: g.defaultRoleId,
        parentGroupId: g.parentGroupId,
        hasPasscode: g.passcodeHash !== null,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
        softDeletedAt: iso(g.softDeletedAt),
        memberActivityAt: g.memberActivityAt.toISOString(),
      })),
    );
  },

  role: async (prisma, gameId, after) => {
    const rows = await prisma.role.findMany({
      where: { group: { gameId }, ...idAfter(after) },
      include: {
        rolePermissions: { orderBy: [{ permissionKey: "asc" }, { contextKey: "asc" }] },
        parentLinks: { orderBy: { parentRoleId: "asc" } },
      },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, (list) =>
      list.map((r) => ({
        kind: "role",
        id: r.id,
        groupId: r.groupId,
        name: r.name,
        priority: r.priority,
        color: r.color,
        isDefault: r.isDefault,
        metadata: r.metadata,
        entries: r.rolePermissions.map((p) => ({
          permission: p.permissionKey,
          value: p.value,
          ...rowContextField(p),
        })),
        parents: r.parentLinks.map((l) => l.parentRoleId),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
    );
  },

  member: async (prisma, gameId, after) => {
    const rows = await prisma.groupMember.findMany({
      where: { group: { gameId }, ...idAfter(after) },
      include: {
        memberRoles: { orderBy: { roleId: "asc" } },
        permissionOverrides: { orderBy: [{ permissionKey: "asc" }, { contextKey: "asc" }] },
      },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, async (list) => {
      const shown = await renderUserIds(
        prisma,
        gameId,
        list.map((m) => m.junjoUserId),
      );
      return list.map((m) => ({
        kind: "member",
        id: m.id,
        groupId: m.groupId,
        personId: m.junjoUserId,
        userId: shown.get(m.junjoUserId) ?? null,
        status: m.status,
        roles: m.memberRoles.map((r) => r.roleId),
        overrides: m.permissionOverrides.map((o) => ({
          permission: o.permissionKey,
          value: o.grant,
          ...rowContextField(o),
          setAt: o.setAt.toISOString(),
          setByPersonId: o.setByUserId,
        })),
        metadata: m.metadata,
        notesPublic: m.notesPublic,
        notesPrivate: m.notesPrivate,
        version: m.version,
        joinedAt: m.joinedAt.toISOString(),
        leftAt: iso(m.leftAt),
        bannedUntil: iso(m.bannedUntil),
      }));
    });
  },

  invitation: async (prisma, gameId, after) => {
    const rows = await prisma.invitation.findMany({
      where: { group: { gameId }, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, (list) =>
      list.map((i) => ({
        kind: "invitation",
        id: i.id,
        groupId: i.groupId,
        code: i.code,
        roleId: i.roleId,
        targetUserId: i.targetUserId,
        createdByPersonId: i.createdByUserId,
        createdAt: i.createdAt.toISOString(),
        expiresAt: iso(i.expiresAt),
        usedAt: iso(i.usedAt),
        usedByPersonId: i.usedByUserId,
      })),
    );
  },

  // Directed group relationships; both ends belong to the game.
  relationship: async (prisma, gameId, after) => {
    const [afterA = "", afterB = ""] = after === null ? [] : after.split("\u0000");
    const rows = await prisma.groupRelationship.findMany({
      where: {
        groupA: { gameId },
        ...(after === null
          ? {}
          : {
              OR: [{ groupAId: { gt: afterA } }, { groupAId: afterA, groupBId: { gt: afterB } }],
            }),
      },
      orderBy: [{ groupAId: "asc" }, { groupBId: "asc" }],
      take: EXPORT_BATCH_SIZE,
    });
    const last = rows[rows.length - 1];
    return {
      records: rows.map((r) => ({
        kind: "relationship",
        groupAId: r.groupAId,
        groupBId: r.groupBId,
        type: r.type,
        since: r.since.toISOString(),
        setByPersonId: r.setByUserId,
      })),
      next:
        rows.length === EXPORT_BATCH_SIZE && last ? `${last.groupAId}\u0000${last.groupBId}` : null,
    };
  },

  ban: async (prisma, gameId, after) => {
    const rows = await prisma.gameBan.findMany({
      where: { gameId, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, async (list) => {
      const shown = await renderUserIds(
        prisma,
        gameId,
        list.map((b) => b.junjoUserId),
      );
      return list.map((b) => ({
        kind: "ban",
        id: b.id,
        personId: b.junjoUserId,
        userId: shown.get(b.junjoUserId) ?? null,
        bannedAt: b.bannedAt.toISOString(),
        expiresAt: iso(b.expiresAt),
        reason: b.reason,
        bannedByPersonId: b.bannedByUserId,
        issuer: b.issuer,
      }));
    });
  },

  banHistory: async (prisma, gameId, after) => {
    const rows = await prisma.banHistory.findMany({
      where: { gameId, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, async (list) => {
      const shown = await renderUserIds(
        prisma,
        gameId,
        list.map((b) => b.junjoUserId),
      );
      return list.map((b) => ({
        kind: "banHistory",
        id: b.id,
        personId: b.junjoUserId,
        userId: shown.get(b.junjoUserId) ?? null,
        scope: b.scope,
        groupId: b.groupId,
        historyKind: b.kind,
        reason: b.reason,
        expiresAt: iso(b.expiresAt),
        eventAt: b.eventAt.toISOString(),
        actorPersonId: b.actorJunjoUserId,
        issuer: b.issuer,
      }));
    });
  },

  sanction: async (prisma, gameId, after) => {
    const rows = await prisma.sanction.findMany({
      where: { gameId, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, async (list) => {
      const shown = await renderUserIds(
        prisma,
        gameId,
        list.map((s) => s.junjoUserId),
      );
      return list.map((s) => ({
        kind: "sanction",
        id: s.id,
        personId: s.junjoUserId,
        userId: shown.get(s.junjoUserId) ?? null,
        type: s.type,
        reason: s.reason,
        issuer: s.issuer,
        issuedByPersonId: s.issuedByUserId,
        startedAt: s.startedAt.toISOString(),
        expiresAt: iso(s.expiresAt),
      }));
    });
  },

  sanctionHistory: async (prisma, gameId, after) => {
    const rows = await prisma.sanctionHistory.findMany({
      where: { gameId, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, async (list) => {
      const shown = await renderUserIds(
        prisma,
        gameId,
        list.map((s) => s.junjoUserId),
      );
      return list.map((s) => ({
        kind: "sanctionHistory",
        id: s.id,
        personId: s.junjoUserId,
        userId: shown.get(s.junjoUserId) ?? null,
        type: s.type,
        historyKind: s.kind,
        reason: s.reason,
        expiresAt: iso(s.expiresAt),
        eventAt: s.eventAt.toISOString(),
        actorPersonId: s.actorJunjoUserId,
        issuer: s.issuer,
      }));
    });
  },

  friendship: relationshipReader("friend", "friendship"),
  friendRequest: relationshipReader("request", "friendRequest"),
  block: relationshipReader("blocked", "block"),

  // Tags with the friend rows they are applied to.
  friendTag: async (prisma, gameId, after) => {
    const rows = await prisma.friendTag.findMany({
      where: { gameId, ...idAfter(after) },
      include: { relationshipTags: { orderBy: { userRelationshipId: "asc" } } },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, (list) =>
      list.map((t) => ({
        kind: "friendTag",
        id: t.id,
        personId: t.junjoUserId,
        name: t.name,
        color: t.color,
        createdAt: t.createdAt.toISOString(),
        relationshipIds: t.relationshipTags.map((rt) => rt.userRelationshipId),
      })),
    );
  },

  // Oldest first by id; ids are not time-ordered, `createdAt` is given.
  audit: async (prisma, gameId, after) => {
    const rows = await prisma.auditEntry.findMany({
      where: { gameId, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, (list) =>
      list.map((a) => ({
        kind: "audit",
        id: a.id,
        groupId: a.groupId,
        actorPersonId: a.actorUserId,
        action: a.action,
        targetId: a.targetId,
        payload: a.payload,
        apiKeyId: a.apiKeyId,
        createdAt: a.createdAt.toISOString(),
      })),
    );
  },
};

// Friend, request and block rows originating in this game, directed
// (actor to target) as stored; a friendship is two rows.
function relationshipReader(type: string, kind: ExportRecordKind): BatchReader {
  return async (prisma, gameId, after) => {
    const rows = await prisma.userRelationship.findMany({
      where: { gameId, type, ...idAfter(after) },
      orderBy: { id: "asc" },
      take: EXPORT_BATCH_SIZE,
    });
    return page(rows, async (list) => {
      const shown = await renderUserIds(
        prisma,
        gameId,
        list.flatMap((r) => [r.actorJunjoUserId, r.targetJunjoUserId]),
      );
      return list.map((r) => ({
        kind,
        id: r.id,
        actorPersonId: r.actorJunjoUserId,
        actorUserId: shown.get(r.actorJunjoUserId) ?? null,
        targetPersonId: r.targetJunjoUserId,
        targetUserId: shown.get(r.targetJunjoUserId) ?? null,
        createdAt: r.createdAt.toISOString(),
        respondedAt: iso(r.respondedAt),
        metadata: r.metadata,
      }));
    });
  };
}

// The whole export as text chunks, one batch per chunk. Pulled lazily,
// so a slow reader holds at most one batch in memory.
async function* exportChunks(prisma: PrismaClient, gameId: string): AsyncGenerator<string> {
  const position = await readStreamPosition(prisma, gameId);
  const counts = Object.fromEntries(EXPORT_RECORD_KINDS.map((k) => [k, 0])) as Record<
    ExportRecordKind,
    number
  >;
  yield `${JSON.stringify({
    kind: "header",
    format: "junjo-export",
    version: 1,
    gameId,
    exportedAt: new Date().toISOString(),
    position: position.toString(),
  })}\n`;

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) throw Errors.notFound("game");
  counts.game = 1;
  yield `${JSON.stringify({
    kind: "game",
    id: game.id,
    name: game.name,
    config: game.config,
    networkId: game.networkId,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString(),
  })}\n`;

  for (const kind of EXPORT_RECORD_KINDS) {
    if (kind === "game") continue;
    const read = readers[kind];
    let after: string | null = null;
    do {
      const batch: Batch = await read(prisma, gameId, after);
      counts[kind] += batch.records.length;
      if (batch.records.length > 0) {
        yield batch.records.map((r) => `${JSON.stringify(r)}\n`).join("");
      }
      after = batch.next;
    } while (after !== null);
  }

  yield `${JSON.stringify({ kind: "end", counts })}\n`;
}

// GET /v1/export
// Streams the calling game as NDJSON: a header, then every record kind in
// `EXPORT_RECORD_KINDS` order, then an end line with per-kind counts. A
// reader that does not see the end line got a truncated file. The key
// must have `canExport`. API keys, webhook endpoints and deliveries, link
// codes, idempotency records and the event log are never exported.
// Records are read without one snapshot across kinds; the header's
// position is read first, so replaying the game stream from it covers
// every change made while the export ran.
export function exportHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.var.gameId;
    const key = await prisma.apiKey.findUnique({
      where: { prefix: c.var.apiKeyPrefix },
      select: { canExport: true },
    });
    if (!key?.canExport) throw Errors.permissionDenied("this API key may not export the game");

    const chunks = exportChunks(prisma, gameId);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        } catch (err) {
          // Headers are already sent; ending without the end line is how
          // the reader learns the file is incomplete.
          logger.error({ err, gameId }, "game export failed");
          controller.error(err);
        }
      },
      async cancel() {
        await chunks.return(undefined);
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  };
}
