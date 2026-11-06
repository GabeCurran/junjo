import type { PermissionMode } from "@junjo.io/shared";
import { Prisma } from "@prisma/client";
import { Errors } from "./errors.js";
import { normalizePermissionKey, validatePermissionKey } from "./permissionResolve.js";

type Tx = Prisma.TransactionClient;

// Changing a game's permission mode must not change what any stored
// key means. Run inside the transaction that writes the new config,
// with the Game row locked FOR UPDATE: key writes read the mode under a
// share lock on the same row, so none can interleave.
//
// exact -> nodes: refused when a stored entry or override key contains
// `*` (it would start matching as a wildcard), breaks the nodes key
// rules, or collides with another key on the same role or member in
// the same context once lowercased; also refused when two role names in
// one group differ only by case. Otherwise every stored key is lowercased so it keeps
// matching the checks it matched before. Catalog keys that collide
// after lowercasing are merged, since the catalog only lists keys.
//
// nodes -> exact: refused when a stored entry or override key contains
// `*`, since it would stop matching as a wildcard. Keys are already
// lowercase, so nothing is rewritten.
//
// Context values are folded on write in every mode, so a switch never
// rewrites them.
//
// Returns how many entry and override keys were rewritten.

const MAX_REPORTED = 5;
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";

interface KeyRow {
  owner: string;
  key: string;
  contextKey: string;
}

function entryKeys(tx: Tx, gameId: string): Promise<KeyRow[]> {
  return tx.$queryRaw<KeyRow[]>(Prisma.sql`
    SELECT rp."roleId" AS owner, rp."permissionKey" AS key, rp."contextKey" AS "contextKey"
    FROM "RolePermission" rp
    JOIN "Role" r ON r.id = rp."roleId"
    JOIN "Group" g ON g.id = r."groupId"
    WHERE g."gameId" = ${gameId}
  `);
}

function overrideKeys(tx: Tx, gameId: string): Promise<KeyRow[]> {
  return tx.$queryRaw<KeyRow[]>(Prisma.sql`
    SELECT o."groupMemberId" AS owner, o."permissionKey" AS key, o."contextKey" AS "contextKey"
    FROM "MemberPermissionOverride" o
    JOIN "GroupMember" m ON m.id = o."groupMemberId"
    JOIN "Group" g ON g.id = m."groupId"
    WHERE g."gameId" = ${gameId}
  `);
}

function keyProblems(rows: KeyRow[], kind: string, to: PermissionMode): string[] {
  const problems: string[] = [];
  const folded = new Map<string, string>();
  for (const row of rows) {
    if (row.key.includes("*")) {
      problems.push(
        to === "nodes"
          ? `${kind} ${row.owner} key ${JSON.stringify(row.key)} would become a wildcard`
          : `${kind} ${row.owner} key ${JSON.stringify(row.key)} would stop matching as a wildcard`,
      );
      continue;
    }
    if (to !== "nodes") continue;
    const reason = validatePermissionKey("nodes", row.key);
    if (reason) {
      problems.push(`${kind} ${row.owner} key ${JSON.stringify(row.key)} ${reason}`);
      continue;
    }
    const slot = `${row.owner}\u0000${row.contextKey}\u0000${normalizePermissionKey("nodes", row.key)}`;
    const clash = folded.get(slot);
    if (clash !== undefined) {
      problems.push(
        `${kind} ${row.owner} keys ${JSON.stringify(clash)} and ${JSON.stringify(row.key)} collide ignoring case`,
      );
    } else {
      folded.set(slot, row.key);
    }
  }
  return problems;
}

export async function applyPermissionModeSwitch(
  tx: Tx,
  gameId: string,
  from: PermissionMode,
  to: PermissionMode,
): Promise<number> {
  if (from === to) return 0;

  const [entries, overrides] = await Promise.all([entryKeys(tx, gameId), overrideKeys(tx, gameId)]);
  const problems = [...keyProblems(entries, "role", to), ...keyProblems(overrides, "member", to)];
  if (to === "nodes") {
    const names = await tx.$queryRaw<{ groupId: string; names: string[] }[]>(Prisma.sql`
      SELECT r."groupId", array_agg(r.name ORDER BY r.name) AS names
      FROM "Role" r
      JOIN "Group" g ON g.id = r."groupId"
      WHERE g."gameId" = ${gameId}
      GROUP BY r."groupId", lower(r.name)
      HAVING count(*) > 1
    `);
    for (const n of names) {
      problems.push(
        `group ${n.groupId} role names ${JSON.stringify(n.names)} collide ignoring case`,
      );
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_REPORTED).join("; ");
    const more =
      problems.length > MAX_REPORTED ? ` (and ${problems.length - MAX_REPORTED} more)` : "";
    throw Errors.permissionModeConflict(
      `cannot switch permissions.mode from ${from} to ${to}: ${shown}${more}`,
    );
  }
  if (to !== "nodes") return 0;

  const rewrittenEntries = await tx.$executeRaw(Prisma.sql`
    UPDATE "RolePermission" rp
    SET "permissionKey" = translate(rp."permissionKey", ${UPPER}, ${LOWER})
    FROM "Role" r JOIN "Group" g ON g.id = r."groupId"
    WHERE r.id = rp."roleId" AND g."gameId" = ${gameId}
      AND rp."permissionKey" <> translate(rp."permissionKey", ${UPPER}, ${LOWER})
  `);
  const rewrittenOverrides = await tx.$executeRaw(Prisma.sql`
    UPDATE "MemberPermissionOverride" o
    SET "permissionKey" = translate(o."permissionKey", ${UPPER}, ${LOWER})
    FROM "GroupMember" m JOIN "Group" g ON g.id = m."groupId"
    WHERE m.id = o."groupMemberId" AND g."gameId" = ${gameId}
      AND o."permissionKey" <> translate(o."permissionKey", ${UPPER}, ${LOWER})
  `);

  // Catalog: keep one def per folded key (one with a description first,
  // then the oldest), drop the rest, then lowercase what remains.
  const defs = await tx.permissionDef.findMany({
    where: { gameId },
    select: { id: true, key: true, description: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const keep = new Map<string, (typeof defs)[number]>();
  const drop: string[] = [];
  for (const def of defs) {
    const folded = normalizePermissionKey("nodes", def.key);
    const kept = keep.get(folded);
    if (!kept) {
      keep.set(folded, def);
    } else if (kept.description === null && def.description !== null) {
      drop.push(kept.id);
      keep.set(folded, def);
    } else {
      drop.push(def.id);
    }
  }
  if (drop.length > 0) await tx.permissionDef.deleteMany({ where: { id: { in: drop } } });
  await tx.$executeRaw(Prisma.sql`
    UPDATE "PermissionDef"
    SET key = translate(key, ${UPPER}, ${LOWER})
    WHERE "gameId" = ${gameId} AND key <> translate(key, ${UPPER}, ${LOWER})
  `);

  return rewrittenEntries + rewrittenOverrides;
}
