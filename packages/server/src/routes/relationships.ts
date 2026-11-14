import type { GroupRelationship } from "@prisma/client";
import type { Db } from "../db.js";
import { renderUserIds } from "../identity.js";

export interface WireGroupRelationship {
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setBy: string | null;
}

// `setByUserId` stores the actor's internal person id; the wire shows
// the external id the caller's namespace preference selects.
export async function serializeGroupRelationships(
  db: Db,
  gameId: string,
  rels: readonly GroupRelationship[],
): Promise<WireGroupRelationship[]> {
  const actors = rels.map((r) => r.setByUserId).filter((id): id is string => id !== null);
  const shown = await renderUserIds(db, gameId, actors);
  return rels.map((rel) => ({
    groupAId: rel.groupAId,
    groupBId: rel.groupBId,
    type: rel.type,
    since: rel.since.toISOString(),
    setBy: rel.setByUserId === null ? null : (shown.get(rel.setByUserId) ?? null),
  }));
}

export async function serializeGroupRelationship(
  db: Db,
  gameId: string,
  rel: GroupRelationship,
): Promise<WireGroupRelationship> {
  const [wire] = await serializeGroupRelationships(db, gameId, [rel]);
  return wire as WireGroupRelationship;
}
