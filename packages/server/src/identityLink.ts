import { createHash, randomBytes } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { Errors } from "./errors.js";
import { isActiveUntil } from "./expiry.js";
import { mergedPerUserOverflow } from "./groupKinds.js";
import { IDENTITY_ORDER } from "./identity.js";

type Tx = Prisma.TransactionClient;

// =====================================================================
// Link codes
// =====================================================================

// Crockford base32: no I, L, O or U, so a code read aloud or typed from
// a screen has no look-alike characters. 32 symbols, so one random byte
// masked to 5 bits picks a symbol without bias.
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const LINK_CODE_LENGTH = 8;
export const LINK_CODE_TTL_MS = 5 * 60 * 1000;

// Shown as two groups of four for readability; redeem accepts either form.
export function generateLinkCode(): string {
  const bytes = randomBytes(LINK_CODE_LENGTH);
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte & 31];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

// Canonical form of a code as typed: case, hyphens and whitespace are
// ignored, and the look-alikes Crockford excludes map to the digits
// they resemble. Null when the result cannot be a code.
export function normalizeLinkCode(input: string): string | null {
  const cleaned = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (cleaned.length !== LINK_CODE_LENGTH) return null;
  for (const ch of cleaned) if (!CODE_ALPHABET.includes(ch)) return null;
  return cleaned;
}

// Codes carry 40 bits, live five minutes and are looked up by hash, so a
// plain digest is sufficient; a slow hash would only slow the lookup.
export function hashLinkCode(normalized: string): string {
  return createHash("sha256").update(normalized).digest("hex");
}

// =====================================================================
// Footprint: what a person holds, for the link refusal rules
// =====================================================================

export interface Footprint {
  // Holds anything beyond plain default-role membership in this game.
  holdsSomething: boolean;
  // Under an active game ban, or an active ban in any group of the game.
  banned: boolean;
}

// An active game ban, or an active ban in any group of the game. The
// same test link, unlink and code requests apply.
export async function isBannedInGame(
  client: Tx | PrismaClient,
  gameId: string,
  junjoUserId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const [gameBan, groupBans] = await Promise.all([
    client.gameBan.findUnique({
      where: { gameId_junjoUserId: { gameId, junjoUserId } },
      select: { expiresAt: true },
    }),
    client.groupMember.findMany({
      where: { junjoUserId, status: "banned", group: { gameId } },
      select: { bannedUntil: true },
    }),
  ]);
  return (
    (gameBan !== null && isActiveUntil(gameBan.expiresAt, now)) ||
    groupBans.some((m) => isActiveUntil(m.bannedUntil, now))
  );
}

function isEmptyObject(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0)
  );
}

// "Holds something" is everything except: active memberships carrying
// at most the group's default role with no overrides, metadata or notes;
// left, kicked and invited rows; and audit entries the person acted on.
// Ids and rows in other games count, so a person spanning games is
// never attached to another.
export async function loadFootprint(
  tx: Tx,
  gameId: string,
  junjoUserId: string,
  now: Date = new Date(),
): Promise<Footprint> {
  const [
    identities,
    memberships,
    relationships,
    tags,
    visibility,
    gameBans,
    history,
    sanctions,
    sanctionHistory,
    moderated,
  ] = await Promise.all([
    tx.externalIdentity.findMany({ where: { junjoUserId }, select: { gameId: true } }),
    tx.groupMember.findMany({
      where: { junjoUserId },
      select: {
        status: true,
        bannedUntil: true,
        metadata: true,
        notesPublic: true,
        notesPrivate: true,
        group: { select: { gameId: true, defaultRoleId: true } },
        memberRoles: { select: { roleId: true, role: { select: { isDefault: true } } } },
        _count: { select: { permissionOverrides: true } },
      },
    }),
    tx.userRelationship.count({
      where: { OR: [{ actorJunjoUserId: junjoUserId }, { targetJunjoUserId: junjoUserId }] },
    }),
    tx.friendTag.count({ where: { junjoUserId } }),
    tx.userVisibility.count({ where: { junjoUserId } }),
    tx.gameBan.findMany({ where: { junjoUserId }, select: { gameId: true, expiresAt: true } }),
    tx.banHistory.count({ where: { junjoUserId } }),
    tx.sanction.count({ where: { junjoUserId } }),
    tx.sanctionHistory.count({ where: { junjoUserId } }),
    tx.moderationState.count({ where: { junjoUserId, version: { gt: 0 } } }),
  ]);

  const banned =
    gameBans.some((b) => b.gameId === gameId && isActiveUntil(b.expiresAt, now)) ||
    memberships.some(
      (m) =>
        m.group.gameId === gameId && m.status === "banned" && isActiveUntil(m.bannedUntil, now),
    );

  let holdsSomething =
    identities.length > 1 ||
    identities.some((i) => i.gameId !== gameId) ||
    relationships > 0 ||
    tags > 0 ||
    visibility > 0 ||
    gameBans.length > 0 ||
    history > 0 ||
    // Sanctions and the moderation version live on the person and are
    // deleted with an attached person, so holding any of them makes this
    // side the survivor (or refuses the link) instead of losing them.
    sanctions > 0 ||
    sanctionHistory > 0 ||
    moderated > 0;

  for (const m of memberships) {
    if (holdsSomething) break;
    if (m.status === "banned") {
      holdsSomething = true;
      break;
    }
    if (m.status !== "active") continue;
    const defaultRoleId = m.group.defaultRoleId;
    const nonDefaultRole = m.memberRoles.some((mr) =>
      defaultRoleId !== null ? mr.roleId !== defaultRoleId : !mr.role.isDefault,
    );
    if (
      nonDefaultRole ||
      m._count.permissionOverrides > 0 ||
      !isEmptyObject(m.metadata) ||
      m.notesPublic !== null ||
      m.notesPrivate !== null
    ) {
      holdsSomething = true;
    }
  }

  return { holdsSomething, banned };
}

// =====================================================================
// Merge and split
// =====================================================================

// Locks both people for the rest of the transaction so two links
// touching the same person serialize.
async function lockPeople(tx: Tx, junjoUserIds: string[]): Promise<void> {
  const sorted = [...new Set(junjoUserIds)].sort();
  for (const id of sorted) {
    await tx.$queryRaw`SELECT id FROM "JunjoUser" WHERE id = ${id} FOR UPDATE`;
  }
}

export interface LinkPlan {
  survivorId: string;
  attachedId: string;
  survivor: "issuer" | "redeemer";
}

// Locks both people, then refuses the link when either is banned, when
// both hold something, or when the merge would exceed a group kind's
// maxPerUser. Otherwise the person holding something survives, and the
// issuer survives a tie.
export async function planLink(
  tx: Tx,
  gameId: string,
  issuerId: string,
  redeemerId: string,
): Promise<LinkPlan> {
  // The maxPerUser count takes the same per-person advisory locks as
  // joins, before the person rows: a join holds its advisory lock and
  // then needs a key-share lock on the person row for its insert, so
  // taking the person rows first here could deadlock with it.
  const overflow = await mergedPerUserOverflow(tx, gameId, [issuerId, redeemerId]);
  await lockPeople(tx, [issuerId, redeemerId]);
  const [issuer, redeemer] = await Promise.all([
    loadFootprint(tx, gameId, issuerId),
    loadFootprint(tx, gameId, redeemerId),
  ]);
  if (issuer.banned || redeemer.banned) {
    throw Errors.banned("ids cannot be linked while either person is banned");
  }
  if (issuer.holdsSomething && redeemer.holdsSomething) {
    throw Errors.linkRefused(
      "both ids belong to people with roles, relationships or history; staff must merge them",
    );
  }
  // Each side may sit within a kind's maxPerUser on its own while the
  // merged person would not; the merge would otherwise leave them over.
  if (overflow.length > 0) {
    throw Errors.linkRefused(
      `linking would put this person in more groups of kind ${overflow.join(", ")} than allowed`,
      { reason: "group_limit_reached", kinds: overflow },
    );
  }
  return redeemer.holdsSomething
    ? { survivorId: redeemerId, attachedId: issuerId, survivor: "redeemer" }
    : { survivorId: issuerId, attachedId: redeemerId, survivor: "issuer" };
}

// Moves everything the attached person holds onto the survivor, then
// deletes the attached person. `planLink` has established the attached
// side holds nothing that could conflict, so a membership in a group the
// survivor is already in is dropped rather than merged; the survivor's
// row, whatever its status, stands.
export async function mergePeople(
  tx: Tx,
  survivorId: string,
  attachedId: string,
  now: Date = new Date(),
): Promise<void> {
  await tx.externalIdentity.updateMany({
    where: { junjoUserId: attachedId },
    data: { junjoUserId: survivorId, linkedAt: now },
  });

  const [attachedRows, survivorRows] = await Promise.all([
    tx.groupMember.findMany({
      where: { junjoUserId: attachedId },
      select: { id: true, groupId: true },
    }),
    tx.groupMember.findMany({ where: { junjoUserId: survivorId }, select: { groupId: true } }),
  ]);
  const survivorGroups = new Set(survivorRows.map((r) => r.groupId));
  const drop = attachedRows.filter((r) => survivorGroups.has(r.groupId)).map((r) => r.id);
  const move = attachedRows.filter((r) => !survivorGroups.has(r.groupId)).map((r) => r.id);
  if (drop.length > 0) await tx.groupMember.deleteMany({ where: { id: { in: drop } } });
  // A moved row now belongs to another person, which is a change to the
  // member, so its version rises. Dropped rows are deleted outright.
  if (move.length > 0) {
    await tx.groupMember.updateMany({
      where: { id: { in: move } },
      data: { junjoUserId: survivorId, version: { increment: 1 } },
    });
  }

  // Columns that name a person by internal id without a foreign key.
  // Repointing keeps attribution once the attached row is deleted; this
  // is the one rewrite of audit rows, and it changes who, not what.
  await tx.auditEntry.updateMany({
    where: { actorUserId: attachedId },
    data: { actorUserId: survivorId },
  });
  await tx.gameBan.updateMany({
    where: { bannedByUserId: attachedId },
    data: { bannedByUserId: survivorId },
  });
  await tx.banHistory.updateMany({
    where: { actorJunjoUserId: attachedId },
    data: { actorJunjoUserId: survivorId },
  });
  await tx.invitation.updateMany({
    where: { createdByUserId: attachedId },
    data: { createdByUserId: survivorId },
  });
  await tx.invitation.updateMany({
    where: { usedByUserId: attachedId },
    data: { usedByUserId: survivorId },
  });

  await tx.junjoUser.delete({ where: { id: attachedId } });
}

// Moves one id to a new, empty person. Everything else stays where it is.
export async function splitIdentity(
  tx: Tx,
  identityId: string,
  now: Date = new Date(),
): Promise<string> {
  const fresh = await tx.junjoUser.create({ data: {} });
  await tx.externalIdentity.update({
    where: { id: identityId },
    data: { junjoUserId: fresh.id, linkedAt: now },
  });
  await tx.linkCode.deleteMany({ where: { externalIdentityId: identityId } });
  return fresh.id;
}

export async function orderedIdsOf(tx: Tx, gameId: string, junjoUserId: string) {
  return tx.externalIdentity.findMany({
    where: { gameId, junjoUserId },
    select: { id: true, externalUserId: true, linkedAt: true },
    orderBy: IDENTITY_ORDER,
  });
}
