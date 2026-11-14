import type { Group } from "@prisma/client";

export interface WireGroup {
  id: string;
  gameId: string;
  kind: string;
  name: string;
  visibility: string;
  metadata: Record<string, unknown>;
  defaultRoleId: string | null;
  parentGroupId: string | null;
  memberCount: number;
  hasPasscode: boolean;
  createdAt: string;
  updatedAt: string;
  softDeletedAt: string | null;
  version?: string;
}

// `version` is given on single-group responses, where the route knows
// the version that goes with the row (also sent as the ETag); lists and
// event payloads leave it out.
export function serializeGroup(
  group: Group,
  memberCount: number,
  version?: bigint | null,
): WireGroup {
  return {
    id: group.id,
    gameId: group.gameId,
    kind: group.kind,
    name: group.name,
    visibility: group.visibility,
    metadata: (group.metadata ?? {}) as Record<string, unknown>,
    defaultRoleId: group.defaultRoleId,
    parentGroupId: group.parentGroupId,
    memberCount,
    // Surface presence only; the hash itself never leaves the server.
    hasPasscode: group.passcodeHash !== null,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
    softDeletedAt: group.softDeletedAt ? group.softDeletedAt.toISOString() : null,
    ...(version === undefined ? {} : { version: (version ?? 0n).toString() }),
  };
}
