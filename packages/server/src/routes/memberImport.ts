import type {
  GameId,
  GroupId,
  GroupKindLimits,
  MemberChangeField,
  MemberImportResult,
  MemberImportRowError,
  MemberImportStatus,
  MemberJoinedEvent,
  MemberUpdatedEvent,
  PartialGameConfig,
  PermissionContext,
  PermissionMode,
  RoleChangedEvent,
  RoleId,
  UserId,
  UserIdFormat,
} from "@junjo.io/shared";
import { type GroupMember, Prisma, type PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { resolveGameConfig } from "../config/defaults.js";
import { Errors, JunjoError } from "../errors.js";
import type { EventHub } from "../eventHub.js";
import { publishStagedEvents, stageEventsBatch, toPublicMember } from "../events.js";
import { isActiveUntil } from "../expiry.js";
import {
  type MembershipGroup,
  afterMembershipChange,
  kindLimitFailures,
  lockGroupMembership,
} from "../groupKinds.js";
import { findOrCreateJunjoUser } from "../identity.js";
import { permissionCache } from "../permissionCache.js";
import { canonicalContextKey, storedContext } from "../permissionContext.js";
import { retryOnUniqueViolation } from "../prismaErrors.js";
import { keyForWrite } from "../roleWrites.js";
import { isUserIdWellFormed } from "../userIdFormat.js";
import { formatIssues, parseBody } from "../validation.js";
import { memberImportBody, memberImportRow } from "./members.schema.js";

type Tx = Prisma.TransactionClient;

// Every statement below is batched, so the transaction is a fixed number
// of round trips regardless of row count; the timeout covers the largest
// batch on a loaded database with room to spare.
const IMPORT_TX_TIMEOUT_MS = 30_000;

// One override, identified by its normalized key and canonical context.
interface OverrideSlot {
  key: string;
  contextKey: string;
  context: PermissionContext;
  value: boolean;
}

// Overrides by `overrideSlot(key, contextKey)`.
type OverrideMap = Map<string, OverrideSlot>;

// Length-prefixed so no key can encode another (key, context) pair.
function overrideSlot(key: string, contextKey: string): string {
  return `${key.length}:${key}|${contextKey}`;
}

interface ParsedRow {
  index: number;
  userId: string;
  roleIds?: string[];
  // Keys normalized in the game's permission mode, contexts folded.
  overrides?: OverrideMap;
  metadata?: Record<string, unknown>;
}

interface LoadedMember {
  row: GroupMember;
  roleIds: string[];
  overrides: OverrideMap;
}

interface Plan {
  input: ParsedRow;
  junjoUserId: string;
  existing: LoadedMember | null;
  status: MemberImportStatus;
  reactivate: boolean;
  finalRoleIds: string[];
  rolesAdded: string[];
  rolesRemoved: string[];
  overridesSet: (OverrideSlot & { before: boolean | undefined })[];
  overridesCleared: OverrideSlot[];
  metadataChanged: boolean;
}

// Key order is not significant in JSON objects and jsonb does not keep
// it, so metadata is compared in a canonical form.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// POST /v1/groups/:id/members/import. Validates every row before writing
// anything, then applies the whole batch in one transaction. A present
// `roleIds`, `overrides` or `metadata` replaces the member's value; an
// absent one is left as is. Like the add, join and accept routes, the
// import never assigns `Group.defaultRoleId`: a created member holds
// exactly the roles in `roleIds`, or none. A member whose row changes
// nothing is reported `unchanged` and gets no audit entry, event or
// version bump.
export function importMembersHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const groupId = c.req.param("id") ?? "";
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    const { members, allowBanned = false, actorUserId } = parseBody(memberImportBody, json);

    const group = await prisma.group.findFirst({
      where: { id: groupId, gameId, softDeletedAt: null },
      select: { id: true, gameId: true, kind: true },
    });
    if (!group) throw Errors.notFound("group");

    // Resolved outside the transaction: the helper owns its own
    // transaction for the first-sight insert.
    const actorJunjoUserId = actorUserId
      ? await findOrCreateJunjoUser(prisma, gameId, actorUserId)
      : null;

    const outcome = await retryOnUniqueViolation(() =>
      prisma.$transaction(
        (tx) =>
          runImport(tx, {
            gameId,
            group,
            members,
            allowBanned,
            actorUserId: actorUserId ?? null,
            actorJunjoUserId,
          }),
        { timeout: IMPORT_TX_TIMEOUT_MS },
      ),
    );

    if (outcome.permissionsChanged) permissionCache.invalidateGroup(group.id);
    publishStagedEvents(hub, ...outcome.events);
    return c.json(outcome.result);
  };
}

type ImportEvent = MemberJoinedEvent | RoleChangedEvent | MemberUpdatedEvent;

interface ImportArgs {
  gameId: string;
  group: { id: string; gameId: string; kind: string };
  members: unknown[];
  allowBanned: boolean;
  actorUserId: string | null;
  actorJunjoUserId: string | null;
}

// The game settings and group lock every later step reads.
interface ImportContext {
  gameId: string;
  groupId: string;
  mode: PermissionMode;
  formats: Record<string, UserIdFormat>;
  limits: GroupKindLimits | null;
  lockedGroup: MembershipGroup;
  now: Date;
}

// The people the valid rows name, as the transaction found them.
interface People {
  // External id -> JunjoUser id, for ids already known in the game.
  personOf: Map<string, string>;
  // JunjoUser id -> their membership in this group.
  memberOf: Map<string, LoadedMember>;
  // JunjoUser ids under an active game ban.
  gameBanned: Set<string>;
}

// Holds the first failure of each row; later failures of the same row
// are dropped.
class RowErrors {
  private readonly byIndex = new Map<number, MemberImportRowError>();

  fail(index: number, userId: string, code: MemberImportRowError["code"], message: string): void {
    if (!this.byIndex.has(index)) {
      this.byIndex.set(index, { index, userId: userId as UserId, code, message });
    }
  }

  has(index: number): boolean {
    return this.byIndex.has(index);
  }

  // When every failure shares a code that has its own status, the call
  // answers with it; any mix answers 400.
  throwIfAny(total: number): void {
    if (this.byIndex.size === 0) return;
    const list = [...this.byIndex.values()].sort((a, b) => a.index - b.index);
    const message = `${list.length} of ${total} rows failed; see details.rows`;
    const only = list.every((e) => e.code === list[0]?.code) ? list[0]?.code : undefined;
    const [code, status] =
      only === "banned"
        ? (["banned", 403] as const)
        : only === "group_full" || only === "group_limit_reached"
          ? ([only, 409] as const)
          : (["bad_request", 400] as const);
    throw new JunjoError(code, status, message, { rows: list });
  }
}

function isGroupBanned(m: LoadedMember | null | undefined, now: Date): boolean {
  return m?.row.status === "banned" && isActiveUntil(m.row.bannedUntil, now);
}

async function runImport(
  tx: Tx,
  args: ImportArgs,
): Promise<{ result: MemberImportResult; events: ImportEvent[]; permissionsChanged: boolean }> {
  const ctx = await lockImportContext(tx, args.gameId, args.group);
  const errors = new RowErrors();

  const rows = validateRows(args.members, ctx, errors);
  await checkRoles(tx, ctx, rows, errors);
  const valid = rows.filter((r) => !errors.has(r.index));
  const people = await loadPeople(tx, ctx, valid, errors);
  if (!args.allowBanned) checkBans(ctx, valid, people, errors);
  await checkKindLimits(tx, ctx, valid, people, errors);
  errors.throwIfAny(args.members.length);

  await createPeople(tx, ctx, valid, people.personOf);
  const plans = planChanges(ctx, valid, people);
  const memberId = await applyWrites(tx, ctx, plans);
  await writeAudit(tx, ctx, plans, memberId, args.actorJunjoUserId);
  const { events, versionOf } = await emitEvents(tx, ctx, plans, memberId, args.actorUserId);

  const count = (s: MemberImportStatus) => plans.filter((p) => p.status === s).length;
  return {
    result: {
      created: count("created"),
      reactivated: count("reactivated"),
      updated: count("updated"),
      unchanged: count("unchanged"),
      items: plans.map((p) => ({
        userId: p.input.userId as UserId,
        status: p.status,
        version: versionOf.get(p) as number,
      })),
    },
    events,
    permissionsChanged: plans.some((p) => p.status !== "unchanged"),
  };
}

// The share lock on the Game row keeps the permission mode and the
// declared id formats fixed for the rest of the transaction; the config
// write path takes the row FOR UPDATE. The group lock is taken before
// any member row, as on every membership write.
async function lockImportContext(
  tx: Tx,
  gameId: string,
  group: ImportArgs["group"],
): Promise<ImportContext> {
  const now = new Date();
  const gameRows = await tx.$queryRaw<{ config: unknown }[]>(
    Prisma.sql`SELECT config FROM "Game" WHERE id = ${gameId} FOR SHARE`,
  );
  const config = resolveGameConfig((gameRows[0]?.config ?? null) as PartialGameConfig | null);
  const limits = Object.hasOwn(config.groups.kinds, group.kind)
    ? (config.groups.kinds[group.kind] ?? null)
    : null;
  const lockedGroup = await lockGroupMembership(tx, group.id);
  return {
    gameId,
    groupId: group.id,
    mode: config.permissions.mode,
    formats: config.identity.formats,
    limits,
    lockedGroup,
    now,
  };
}

// Shape, id format, repeated ids and permission keys. Returns every row
// that parsed, including rows that failed a later check here.
function validateRows(members: unknown[], ctx: ImportContext, errors: RowErrors): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const firstIndexOf = new Map<string, number>();
  members.forEach((raw, index) => {
    const rowParse = memberImportRow.safeParse(raw);
    const rawUserId =
      raw !== null &&
      typeof raw === "object" &&
      typeof (raw as { userId?: unknown }).userId === "string"
        ? (raw as { userId: string }).userId
        : "";
    if (!rowParse.success) {
      errors.fail(index, rawUserId, "bad_request", formatIssues(rowParse.error) || "invalid row");
      return;
    }
    const row = rowParse.data;
    if (!isUserIdWellFormed(ctx.formats, row.userId)) {
      errors.fail(
        index,
        row.userId,
        "invalid_user_id",
        "userId does not match its namespace's declared format",
      );
      return;
    }
    const first = firstIndexOf.get(row.userId);
    if (first !== undefined) {
      errors.fail(index, row.userId, "bad_request", `userId repeats row ${first}`);
      return;
    }
    firstIndexOf.set(row.userId, index);

    let overrides: OverrideMap | undefined;
    if (row.overrides) {
      overrides = new Map();
      for (const entry of row.overrides) {
        let key: string;
        try {
          key = keyForWrite(ctx.mode, entry.permission);
        } catch (err) {
          errors.fail(
            index,
            row.userId,
            "bad_request",
            err instanceof Error ? err.message : "invalid permission",
          );
          return;
        }
        const context = entry.context ?? {};
        const contextKey = canonicalContextKey(context);
        const slot = overrideSlot(key, contextKey);
        if (overrides.has(slot)) {
          const where = contextKey === "" ? "" : ` with context ${contextKey}`;
          errors.fail(
            index,
            row.userId,
            "bad_request",
            `permission ${JSON.stringify(entry.permission)}${where} is listed twice`,
          );
          return;
        }
        overrides.set(slot, { key, contextKey, context, value: entry.value });
      }
    }
    rows.push({
      index,
      userId: row.userId,
      roleIds: row.roleIds ? [...new Set(row.roleIds)] : undefined,
      overrides,
      metadata: row.metadata,
    });
  });
  return rows;
}

// Every requested role must exist and belong to this group.
async function checkRoles(
  tx: Tx,
  ctx: ImportContext,
  rows: ParsedRow[],
  errors: RowErrors,
): Promise<void> {
  const requestedRoleIds = new Set<string>();
  for (const row of rows) for (const id of row.roleIds ?? []) requestedRoleIds.add(id);
  if (requestedRoleIds.size === 0) return;
  const roleRows = await tx.role.findMany({
    where: { id: { in: [...requestedRoleIds] } },
    select: { id: true, groupId: true },
  });
  const roleGroup = new Map(roleRows.map((r) => [r.id, r.groupId]));
  for (const row of rows) {
    for (const id of row.roleIds ?? []) {
      const owner = roleGroup.get(id);
      if (owner === undefined) {
        errors.fail(row.index, row.userId, "not_found", `role ${id} not found`);
        break;
      }
      if (owner !== ctx.groupId) {
        errors.fail(
          row.index,
          row.userId,
          "bad_request",
          `role ${id} does not belong to this group`,
        );
        break;
      }
    }
  }
}

// Resolves the rows' ids to people, refuses two rows naming one linked
// person, and loads the known people's memberships (locked, so the
// versions read are the ones this write replaces) and game bans.
async function loadPeople(
  tx: Tx,
  ctx: ImportContext,
  valid: ParsedRow[],
  errors: RowErrors,
): Promise<People> {
  const identities = await tx.externalIdentity.findMany({
    where: { gameId: ctx.gameId, externalUserId: { in: valid.map((r) => r.userId) } },
    select: { externalUserId: true, junjoUserId: true },
  });
  const personOf = new Map(identities.map((i) => [i.externalUserId, i.junjoUserId]));

  const rowOfPerson = new Map<string, number>();
  for (const row of valid) {
    const person = personOf.get(row.userId);
    if (!person) continue;
    const first = rowOfPerson.get(person);
    if (first !== undefined) {
      errors.fail(
        row.index,
        row.userId,
        "bad_request",
        `userId names the same person as row ${first}`,
      );
      continue;
    }
    rowOfPerson.set(person, row.index);
  }

  const memberOf = new Map<string, LoadedMember>();
  const gameBanned = new Set<string>();
  const knownPeople = [...rowOfPerson.keys()];
  if (knownPeople.length === 0) return { personOf, memberOf, gameBanned };

  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM "GroupMember"
    WHERE "groupId" = ${ctx.groupId} AND "junjoUserId" = ANY(${knownPeople}::text[])
    FOR UPDATE
  `);
  const [memberRows, gameBans] = await Promise.all([
    tx.groupMember.findMany({
      where: { groupId: ctx.groupId, junjoUserId: { in: knownPeople } },
      include: {
        memberRoles: { select: { roleId: true } },
        permissionOverrides: {
          select: { permissionKey: true, grant: true, context: true, contextKey: true },
        },
      },
    }),
    tx.gameBan.findMany({
      where: { gameId: ctx.gameId, junjoUserId: { in: knownPeople } },
      select: { junjoUserId: true, expiresAt: true },
    }),
  ]);
  for (const m of memberRows) {
    const { memberRoles, permissionOverrides, ...row } = m;
    memberOf.set(m.junjoUserId, {
      row,
      roleIds: memberRoles.map((r) => r.roleId),
      overrides: new Map(
        permissionOverrides.map((o) => [
          overrideSlot(o.permissionKey, o.contextKey),
          {
            key: o.permissionKey,
            contextKey: o.contextKey,
            context: (o.contextKey === "" ? {} : (o.context ?? {})) as PermissionContext,
            value: o.grant,
          },
        ]),
      ),
    });
  }
  for (const b of gameBans) if (isActiveUntil(b.expiresAt, ctx.now)) gameBanned.add(b.junjoUserId);
  return { personOf, memberOf, gameBanned };
}

function checkBans(ctx: ImportContext, valid: ParsedRow[], people: People, errors: RowErrors) {
  for (const row of valid) {
    if (errors.has(row.index)) continue;
    const person = people.personOf.get(row.userId);
    if (!person) continue;
    if (people.gameBanned.has(person)) {
      errors.fail(row.index, row.userId, "banned", "user is banned from this game");
    } else if (isGroupBanned(people.memberOf.get(person), ctx.now)) {
      errors.fail(row.index, row.userId, "banned", "user is banned from this group");
    }
  }
}

// Kind limits, over the rows that would make someone an active member:
// new members and reactivations (a kept group ban activates no one). A
// person not yet known has no memberships, so a placeholder key stands
// in for them; it contains ":", which internal ids never do.
async function checkKindLimits(
  tx: Tx,
  ctx: ImportContext,
  valid: ParsedRow[],
  people: People,
  errors: RowErrors,
): Promise<void> {
  const activating: { row: ParsedRow; key: string }[] = [];
  for (const row of valid) {
    if (errors.has(row.index)) continue;
    const person = people.personOf.get(row.userId);
    const existing = person ? people.memberOf.get(person) : undefined;
    if (existing && (existing.row.status === "active" || isGroupBanned(existing, ctx.now))) {
      continue;
    }
    activating.push({ row, key: person ?? `new:${row.userId}` });
  }
  const limitFailures = await kindLimitFailures(
    tx,
    ctx.lockedGroup,
    ctx.limits,
    activating.map((a) => a.key),
  );
  for (const { row, key } of activating) {
    const failure = limitFailures.get(key);
    if (failure === "group_full") {
      errors.fail(row.index, row.userId, "group_full", "this group has reached its member limit");
    } else if (failure === "group_limit_reached") {
      errors.fail(
        row.index,
        row.userId,
        "group_limit_reached",
        "user has reached the membership limit for this group kind",
      );
    }
  }
}

// Mints a person for every id the game has not seen, adding each to
// `personOf`.
async function createPeople(
  tx: Tx,
  ctx: ImportContext,
  valid: ParsedRow[],
  personOf: Map<string, string>,
): Promise<void> {
  const unknown = valid.filter((r) => !personOf.has(r.userId));
  if (unknown.length === 0) return;
  const users = await tx.junjoUser.createManyAndReturn({
    data: unknown.map(() => ({})),
    select: { id: true },
  });
  await tx.externalIdentity.createMany({
    data: unknown.map((r, i) => ({
      gameId: ctx.gameId,
      junjoUserId: (users[i] as { id: string }).id,
      externalUserId: r.userId,
    })),
  });
  unknown.forEach((r, i) => personOf.set(r.userId, (users[i] as { id: string }).id));
}

function planChanges(ctx: ImportContext, valid: ParsedRow[], people: People): Plan[] {
  return valid.map((input) => {
    const junjoUserId = people.personOf.get(input.userId) as string;
    const existing = people.memberOf.get(junjoUserId) ?? null;
    const keepsBan = isGroupBanned(existing, ctx.now);
    const created = existing === null;
    const reactivate = !created && existing.row.status !== "active" && !keepsBan;

    const priorRoles = existing?.roleIds ?? [];
    const finalRoleIds = input.roleIds ?? priorRoles;
    const rolesAdded = finalRoleIds.filter((id) => !priorRoles.includes(id));
    const rolesRemoved = priorRoles.filter((id) => !finalRoleIds.includes(id));

    const priorOverrides: OverrideMap = existing?.overrides ?? new Map();
    const overridesSet: Plan["overridesSet"] = [];
    const overridesCleared: Plan["overridesCleared"] = [];
    if (input.overrides) {
      for (const [slot, next] of input.overrides) {
        const before = priorOverrides.get(slot)?.value;
        if (before !== next.value) overridesSet.push({ ...next, before });
      }
      for (const [slot, prior] of priorOverrides) {
        if (!input.overrides.has(slot)) overridesCleared.push(prior);
      }
    }

    const metadataChanged =
      input.metadata !== undefined &&
      canonicalJson(input.metadata) !== canonicalJson(existing?.row.metadata ?? {});

    const changed =
      rolesAdded.length > 0 ||
      rolesRemoved.length > 0 ||
      overridesSet.length > 0 ||
      overridesCleared.length > 0 ||
      metadataChanged;
    const status: MemberImportStatus = created
      ? "created"
      : reactivate
        ? "reactivated"
        : changed
          ? "updated"
          : "unchanged";
    return {
      input,
      junjoUserId,
      existing,
      status,
      reactivate,
      finalRoleIds,
      rolesAdded,
      rolesRemoved,
      overridesSet,
      overridesCleared,
      metadataChanged,
    };
  });
}

// Applies every plan in a fixed number of statements. Returns the
// member row id of each plan.
async function applyWrites(
  tx: Tx,
  ctx: ImportContext,
  plans: Plan[],
): Promise<(p: Plan) => string> {
  const toCreate = plans.filter((p) => p.status === "created");
  const toUpdate = plans.filter((p) => p.status === "reactivated" || p.status === "updated");
  const memberIdOf = new Map<string, string>();
  for (const p of plans) if (p.existing) memberIdOf.set(p.junjoUserId, p.existing.row.id);

  if (toCreate.length > 0) {
    const createdRows = await tx.groupMember.createManyAndReturn({
      data: toCreate.map((p) => ({
        groupId: ctx.groupId,
        junjoUserId: p.junjoUserId,
        status: "active",
        metadata: (p.input.metadata ?? {}) as Prisma.InputJsonValue,
      })),
      select: { id: true, junjoUserId: true },
    });
    for (const r of createdRows) memberIdOf.set(r.junjoUserId, r.id);
  }

  if (toUpdate.length > 0) {
    // One statement for every changed existing member: one version step
    // each, plus reactivation and metadata replacement where planned.
    const payload = JSON.stringify(
      toUpdate.map((p) => ({
        id: memberIdOf.get(p.junjoUserId),
        reactivate: p.reactivate,
        setMetadata: p.metadataChanged,
        metadata: p.metadataChanged ? p.input.metadata : {},
      })),
    );
    await tx.$executeRaw(Prisma.sql`
      UPDATE "GroupMember" AS g SET
        version = g.version + 1,
        status = CASE WHEN v.reactivate THEN 'active' ELSE g.status END,
        "leftAt" = CASE WHEN v.reactivate THEN NULL ELSE g."leftAt" END,
        "bannedUntil" = CASE WHEN v.reactivate THEN NULL ELSE g."bannedUntil" END,
        metadata = CASE WHEN v."setMetadata" THEN v.metadata ELSE g.metadata END
      FROM jsonb_to_recordset(${payload}::jsonb)
        AS v(id text, reactivate boolean, "setMetadata" boolean, metadata jsonb)
      WHERE g.id = v.id
    `);
  }

  const memberId = (p: Plan) => memberIdOf.get(p.junjoUserId) as string;

  const roleRemovals = plans.flatMap((p) =>
    p.rolesRemoved.map((roleId) => ({ groupMemberId: memberId(p), roleId })),
  );
  if (roleRemovals.length > 0) await tx.memberRole.deleteMany({ where: { OR: roleRemovals } });
  const roleAdds = plans.flatMap((p) =>
    p.rolesAdded.map((roleId) => ({ groupMemberId: memberId(p), roleId })),
  );
  if (roleAdds.length > 0) await tx.memberRole.createMany({ data: roleAdds, skipDuplicates: true });

  const overrideTouched = plans.flatMap((p) =>
    [...p.overridesSet, ...p.overridesCleared].map((o) => ({
      groupMemberId: memberId(p),
      permissionKey: o.key,
      contextKey: o.contextKey,
    })),
  );
  if (overrideTouched.length > 0) {
    await tx.memberPermissionOverride.deleteMany({ where: { OR: overrideTouched } });
  }
  const overrideWrites = plans.flatMap((p) =>
    p.overridesSet.map((o) => ({
      groupMemberId: memberId(p),
      permissionKey: o.key,
      grant: o.value,
      context: storedContext(o.context) ?? Prisma.DbNull,
      contextKey: o.contextKey,
      setAt: ctx.now,
      setByUserId: null,
    })),
  );
  if (overrideWrites.length > 0) {
    await tx.permissionDef.createMany({
      data: [...new Set(overrideWrites.map((o) => o.permissionKey))].map((key) => ({
        gameId: ctx.gameId,
        key,
      })),
      skipDuplicates: true,
    });
    await tx.memberPermissionOverride.createMany({ data: overrideWrites });
  }

  if (plans.some((p) => p.status === "created" || p.status === "reactivated")) {
    await afterMembershipChange(tx, ctx.lockedGroup, ctx.limits, false);
  }
  return memberId;
}

async function writeAudit(
  tx: Tx,
  ctx: ImportContext,
  plans: Plan[],
  memberId: (p: Plan) => string,
  actorJunjoUserId: string | null,
): Promise<void> {
  const audit: Prisma.AuditEntryCreateManyInput[] = [];
  for (const p of plans) {
    const base = {
      gameId: ctx.gameId,
      groupId: ctx.groupId,
      actorUserId: actorJunjoUserId,
      targetId: p.input.userId,
    };
    const id = memberId(p);
    if (p.status === "created" || p.status === "reactivated") {
      audit.push({ ...base, action: "member.joined", payload: { memberId: id, via: "import" } });
    }
    for (const roleId of p.rolesAdded) {
      audit.push({ ...base, action: "role.assigned", payload: { memberId: id, roleId } });
    }
    for (const roleId of p.rolesRemoved) {
      audit.push({ ...base, action: "role.unassigned", payload: { memberId: id, roleId } });
    }
    for (const o of p.overridesSet) {
      audit.push({
        ...base,
        action: "permission.override.set",
        payload: {
          memberId: id,
          permission: o.key,
          grant: o.value,
          ...(o.contextKey === "" ? {} : { context: o.context }),
          ...(o.before !== undefined ? { before: { grant: o.before } } : {}),
        },
      });
    }
    for (const o of p.overridesCleared) {
      audit.push({
        ...base,
        action: "permission.override.cleared",
        payload: {
          memberId: id,
          permission: o.key,
          grant: o.value,
          ...(o.contextKey === "" ? {} : { context: o.context }),
        },
      });
    }
    if (p.metadataChanged) {
      audit.push({
        ...base,
        action: "member.metadata.updated",
        payload: {
          before: { metadata: (p.existing?.row.metadata ?? {}) as Prisma.InputJsonValue },
          after: { metadata: p.input.metadata as Prisma.InputJsonValue },
        },
      });
    }
  }
  if (audit.length > 0) await tx.auditEntry.createMany({ data: audit });
}

// Stages the events of every changed member and returns each plan's
// member version as this write leaves it.
async function emitEvents(
  tx: Tx,
  ctx: ImportContext,
  plans: Plan[],
  memberId: (p: Plan) => string,
  actorUserId: string | null,
): Promise<{ events: ImportEvent[]; versionOf: Map<Plan, number> }> {
  const touched = plans.filter((p) => p.status !== "unchanged");
  const finalRows =
    touched.length === 0
      ? []
      : await tx.groupMember.findMany({ where: { id: { in: touched.map(memberId) } } });
  const finalRowOf = new Map(finalRows.map((r) => [r.id, r]));

  const joinedPayloads: Omit<MemberJoinedEvent, "id" | "occurredAt">[] = [];
  const rolePayloads: Omit<RoleChangedEvent, "id" | "occurredAt">[] = [];
  const updatedPayloads: Omit<MemberUpdatedEvent, "id" | "occurredAt">[] = [];
  const versionOf = new Map<Plan, number>();
  for (const p of plans) {
    const row = finalRowOf.get(memberId(p)) ?? p.existing?.row;
    const version = row?.version ?? 1;
    versionOf.set(p, version);
    if (p.status === "unchanged" || !row) continue;
    const userId = p.input.userId as UserId;
    const scope = { gameId: ctx.gameId as GameId, groupId: ctx.groupId as GroupId, userId };
    // The joined snapshot carries the member as this write leaves it, so
    // a consumer that keeps it as its copy is current at `memberVersion`
    // and may skip the role and update events that follow.
    if (p.status === "created" || p.status === "reactivated") {
      joinedPayloads.push({
        type: "member.joined",
        ...scope,
        member: toPublicMember(row, p.input.userId, p.finalRoleIds),
        memberVersion: version,
      });
    }
    if (p.rolesAdded.length > 0 || p.rolesRemoved.length > 0) {
      rolePayloads.push({
        type: "role.changed",
        ...scope,
        added: p.rolesAdded as RoleId[],
        removed: p.rolesRemoved as RoleId[],
        actorUserId: (actorUserId as UserId | null) ?? null,
        memberVersion: version,
      });
    }
    const changed: MemberChangeField[] = [];
    if (p.metadataChanged) changed.push("metadata");
    if (p.overridesSet.length > 0 || p.overridesCleared.length > 0) changed.push("overrides");
    if (changed.length > 0) {
      updatedPayloads.push({ type: "member.updated", ...scope, changed, memberVersion: version });
    }
  }

  // Batched per type in this order, so each member's events keep the
  // order the equivalent single calls would emit them in.
  const events = [
    ...(joinedPayloads.length > 0 ? await stageEventsBatch(tx, joinedPayloads) : []),
    ...(rolePayloads.length > 0 ? await stageEventsBatch(tx, rolePayloads) : []),
    ...(updatedPayloads.length > 0 ? await stageEventsBatch(tx, updatedPayloads) : []),
  ];
  return { events, versionOf };
}
