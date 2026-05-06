import type { GroupRelationship } from "@prisma/client";

export interface WireGroupRelationship {
  groupAId: string;
  groupBId: string;
  type: string;
  since: string;
  setBy: string | null;
}

export function serializeGroupRelationship(rel: GroupRelationship): WireGroupRelationship {
  return {
    groupAId: rel.groupAId,
    groupBId: rel.groupBId,
    type: rel.type,
    since: rel.since.toISOString(),
    setBy: rel.setByUserId,
  };
}
