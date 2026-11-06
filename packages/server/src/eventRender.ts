import type { JunjoEvent, JunjoEventType } from "@junjo.io/shared";
import { Prisma } from "@prisma/client";
import type { Db } from "./db.js";
import { pickRenderedId } from "./identity.js";

// Paths inside each event type that hold an external user id naming a
// person. Delivery rewrites exactly these to the id the subscriber's
// namespace preference selects; everything else in the payload is sent
// as emitted. Fields holding internal JunjoUser ids, and ids recorded
// literally (invitation targets, the linked, unlinked and changed ids on
// identity events), are deliberately absent. The Record type forces
// every new event type to declare its paths.
const USER_ID_PATHS: Record<JunjoEventType, readonly (readonly string[])[]> = {
  "member.joined": [["userId"], ["member", "userId"]],
  "member.left": [["userId"], ["kickedBy"]],
  "member.invited": [],
  "member.updated": [["userId"]],
  "member.banned": [["userId"]],
  "member.unbanned": [["userId"]],
  "role.created": [],
  "role.changed": [["userId"], ["actorUserId"]],
  "role.updated": [],
  "role.deleted": [],
  "permission.granted": [],
  "permission.revoked": [],
  "group.updated": [],
  "group.deleted": [],
  "group.relationship.changed": [],
  "friend.request.sent": [["actorJunjoUserId"], ["targetJunjoUserId"]],
  "friend.request.accepted": [["actorJunjoUserId"], ["targetJunjoUserId"]],
  "friend.request.declined": [["actorJunjoUserId"], ["targetJunjoUserId"]],
  "friend.request.cancelled": [["actorJunjoUserId"], ["targetJunjoUserId"]],
  "friend.removed": [["removedByJunjoUserId"], ["otherJunjoUserId"]],
  "friend.blocked": [["byJunjoUserId"], ["otherJunjoUserId"]],
  "friend.unblocked": [["byJunjoUserId"], ["otherJunjoUserId"]],
  "game.user.banned": [["userId"]],
  "game.user.unbanned": [["userId"]],
  "game.user.sanctioned": [["userId"]],
  "game.user.unsanctioned": [["userId"]],
  "identity.linked": [["userId"]],
  "identity.unlinked": [["userId"]],
  "identity.updated": [["userId"]],
  "permissions.config.updated": [],
};

// Emitted id -> every id of the same person in the event's game,
// earliest-linked first. Ids that resolve to no one are absent and are
// delivered unchanged.
export type RenderTable = ReadonlyMap<string, readonly string[]>;

function readPath(event: JunjoEvent, path: readonly string[]): unknown {
  let cur: unknown = event;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function emittedUserIds(event: JunjoEvent): string[] {
  const out: string[] = [];
  for (const path of USER_ID_PATHS[event.type]) {
    const value = readPath(event, path);
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

// One query for every emitted id across `events`, which must share a
// game. Returns an empty table when no event names a user.
export async function loadRenderTable(
  client: Db,
  gameId: string,
  events: readonly JunjoEvent[],
): Promise<RenderTable> {
  const ids = [...new Set(events.flatMap(emittedUserIds))];
  if (ids.length === 0) return new Map();
  const rows = await client.$queryRaw<{ emitted: string; id: string }[]>(Prisma.sql`
    SELECT src."externalUserId" AS emitted, ei."externalUserId" AS id
    FROM "ExternalIdentity" src
    JOIN "ExternalIdentity" ei
      ON ei."junjoUserId" = src."junjoUserId" AND ei."gameId" = src."gameId"
    WHERE src."gameId" = ${gameId} AND src."externalUserId" IN (${Prisma.join(ids)})
    ORDER BY ei."linkedAt" ASC, ei."id" ASC
  `);
  const table = new Map<string, string[]>();
  for (const row of rows) {
    const list = table.get(row.emitted);
    if (list) list.push(row.id);
    else table.set(row.emitted, [row.id]);
  }
  return table;
}

// True when no subscriber could see a different id than emitted: every
// emitted id belongs to a person with that single id.
export function renderIsIdentity(table: RenderTable): boolean {
  for (const [emitted, ordered] of table) {
    if (ordered.length !== 1 || ordered[0] !== emitted) return false;
  }
  return true;
}

// The event as a subscriber with `preferred` sees it. Returns the input
// object when nothing changes, otherwise a copy; never mutates.
export function renderEvent(
  event: JunjoEvent,
  table: RenderTable,
  preferred: readonly string[],
): JunjoEvent {
  let copy: JunjoEvent | null = null;
  for (const path of USER_ID_PATHS[event.type]) {
    const value = readPath(event, path);
    if (typeof value !== "string") continue;
    const ordered = table.get(value);
    if (!ordered || ordered.length === 0) continue;
    const rendered = pickRenderedId(ordered, preferred);
    if (rendered === value) continue;
    copy ??= structuredClone(event);
    let parent = copy as unknown as Record<string, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[path[path.length - 1] as string] = rendered;
  }
  return copy ?? event;
}

// Stable key for grouping subscribers that see identical renderings.
export function preferenceKey(preferred: readonly string[]): string {
  return JSON.stringify(preferred);
}
