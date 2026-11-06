import {
  DISPLAY_NAME_LOOKUP_LIMIT,
  DISPLAY_NAME_MAX_LENGTH,
  type GameId,
  type IdentityLinkedEvent,
  type IdentityUnlinkedEvent,
  type IdentityUpdatedEvent,
  type UserId,
} from "@junjo.io/shared";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { Context, Handler } from "hono";
import { NAMESPACE_FORMAT_MESSAGE, userIdNamespaceSchema } from "../config/schema.js";
import { Errors } from "../errors.js";
import { type EventHub, eventHub as defaultHub } from "../eventHub.js";
import { publishStagedEvents, stageEvent } from "../events.js";
import {
  IDENTITY_ORDER,
  findJunjoUserId,
  findOrCreateJunjoUser,
  renderResolved,
} from "../identity.js";
import {
  LINK_CODE_TTL_MS,
  generateLinkCode,
  hashLinkCode,
  isBannedInGame,
  loadFootprint,
  mergePeople,
  normalizeLinkCode,
  orderedIdsOf,
  planLink,
  splitIdentity,
} from "../identityLink.js";
import { type ConsumeResult, RateLimiter } from "../middleware/rateLimit.js";
import { type PermissionCache, permissionCache } from "../permissionCache.js";
import { isUniqueViolation } from "../prismaErrors.js";
import { currentRequestContext } from "../requestContext.js";
import { assertUserIdsWellFormed, userIdNamespace } from "../userIdFormat.js";
import { parseBody } from "../validation.js";
import { stampStreamPosition } from "./gameEvents.js";
import { redeemLinkCodeBody, setDisplayNameBody } from "./identities.schema.js";

export interface WireLinkedIdentity {
  userId: string;
  // Text before the id's first ":", or null when it has none.
  namespace: string | null;
  linkedAt: string;
  // This id's own display name.
  displayName: string | null;
}

export interface WireLinkedIdentityList {
  items: WireLinkedIdentity[];
}

type IdentityRow = { externalUserId: string; linkedAt: Date; displayName: string | null };

export function serializeLinkedIdentity(row: IdentityRow): WireLinkedIdentity {
  return {
    userId: row.externalUserId,
    namespace: userIdNamespace(row.externalUserId),
    linkedAt: row.linkedAt.toISOString(),
    displayName: row.displayName,
  };
}

// Every id of one person in the calling game, earliest-linked first.
export async function loadLinkedIdentities(
  prisma: PrismaClient,
  gameId: string,
  junjoUserId: string,
): Promise<IdentityRow[]> {
  return prisma.externalIdentity.findMany({
    where: { gameId, junjoUserId },
    select: { externalUserId: true, linkedAt: true, displayName: true },
    orderBy: IDENTITY_ORDER,
  });
}

// =====================================================================
// Display names
// =====================================================================

export interface WireDisplayNameMatch {
  userId: string;
  displayName: string;
  displayNameUpdatedAt: string;
}

// PUT /v1/users/:userId/display-name
// Sets or clears the display name of exactly the id in the path, never
// of the person's other ids; an unknown id becomes a new person first,
// like other writes. A value equal to the stored one writes nothing and
// emits nothing. Names change often, so no audit entry is written.
export function setDisplayNameHandler(prisma: PrismaClient, hub: EventHub): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const gameId = c.var.gameId;
    const body = parseBody(setDisplayNameBody, await c.req.json().catch(() => null));
    const displayName = body.displayName;

    await findOrCreateJunjoUser(prisma, gameId, userId);
    const outcome = await prisma.$transaction(async (tx) => {
      // Locked so two concurrent writes of different names each compare
      // against the value the other committed.
      const rows = await tx.$queryRaw<
        { displayName: string | null; linkedAt: Date; junjoUserId: string }[]
      >(Prisma.sql`
        SELECT "displayName", "linkedAt", "junjoUserId" FROM "ExternalIdentity"
        WHERE "gameId" = ${gameId} AND "externalUserId" = ${userId}
        FOR UPDATE
      `);
      const row = rows[0];
      if (!row) throw Errors.notFound("user");
      if (row.displayName === displayName) {
        return { row: { ...row, externalUserId: userId }, event: null };
      }
      const updated = await tx.externalIdentity.update({
        where: { gameId_externalUserId: { gameId, externalUserId: userId } },
        data: { displayName, displayNameUpdatedAt: displayName === null ? null : new Date() },
        select: { externalUserId: true, linkedAt: true, displayName: true, junjoUserId: true },
      });
      const event = await stageEvent<IdentityUpdatedEvent>(tx, {
        type: "identity.updated",
        gameId: gameId as GameId,
        userId: userId as UserId,
        changedUserId: userId as UserId,
        displayName,
        changed: ["displayName"],
      });
      return { row: updated, event };
    });

    if (outcome.event) publishStagedEvents(hub, outcome.event);
    return c.json<WireLinkedIdentity>(serializeLinkedIdentity(outcome.row));
  };
}

// GET /v1/identities/by-name?name=&namespace=
// Ids whose own display name equals `name` ignoring case, optionally
// only ids in `namespace`, most recently named first. Each match names
// the matching id itself, not the person's rendered id, because the
// caller asked by that id's name. Served by the expression index on
// (gameId, lower(displayName)).
export function findIdentitiesByNameHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const gameId = c.var.gameId;
    const name = c.req.query("name");
    if (name === undefined || name.length < 1 || name.length > DISPLAY_NAME_MAX_LENGTH) {
      throw Errors.badRequest(`name must be 1-${DISPLAY_NAME_MAX_LENGTH} characters`);
    }
    const namespace = c.req.query("namespace");
    if (namespace !== undefined && !userIdNamespaceSchema.safeParse(namespace).success) {
      throw Errors.badRequest(NAMESPACE_FORMAT_MESSAGE);
    }
    const rows = await prisma.$queryRaw<
      { externalUserId: string; displayName: string; displayNameUpdatedAt: Date | null }[]
    >(Prisma.sql`
      SELECT "externalUserId", "displayName", "displayNameUpdatedAt"
      FROM "ExternalIdentity"
      WHERE "gameId" = ${gameId}
        AND "displayName" IS NOT NULL
        AND lower("displayName") = lower(${name})
        ${namespace === undefined ? Prisma.empty : Prisma.sql`AND starts_with("externalUserId", ${`${namespace}:`})`}
      ORDER BY "displayNameUpdatedAt" DESC NULLS LAST, id DESC
      LIMIT ${DISPLAY_NAME_LOOKUP_LIMIT}
    `);
    return c.json<{ items: WireDisplayNameMatch[] }>({
      items: rows.map((r) => ({
        userId: r.externalUserId,
        displayName: r.displayName,
        displayNameUpdatedAt: (r.displayNameUpdatedAt ?? new Date(0)).toISOString(),
      })),
    });
  };
}

// GET /v1/users/:userId/identities. A never-seen id answers with an
// empty list rather than 404, matching the other per-user listings.
export function listLinkedIdentitiesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const gameId = c.var.gameId;
    await stampStreamPosition(c, prisma, gameId);

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) return c.json<WireLinkedIdentityList>({ items: [] });
    const rows = await loadLinkedIdentities(prisma, gameId, junjoUserId);
    return c.json<WireLinkedIdentityList>({ items: rows.map(serializeLinkedIdentity) });
  };
}

// =====================================================================
// Link codes, redeem, unlink
// =====================================================================

// Per-id budgets bound how fast one id can churn codes or attempts. The
// per-key budget bounds guessing; it is charged only for failed redeems,
// so a backend redeeming for many users is not throttled by successes.
const LINK_CODE_ISSUE_LIMIT = { perMinute: 1, burst: 5 };
const LINK_CODE_REDEEM_LIMIT = { perMinute: 1, burst: 5 };
const LINK_CODE_FAILED_REDEEM_LIMIT = { perMinute: 30, burst: 60 };

export interface WireLinkCode {
  code: string;
  expiresAt: string;
}

// The person after the change (named by the rendering rule) and their ids.
export interface WireIdentityChange {
  userId: string;
  identities: WireLinkedIdentity[];
}

export interface WireIdentityLinked extends WireIdentityChange {
  // The id that joined the person.
  linkedUserId: string;
}

export interface WireIdentityUnlinked extends WireIdentityChange {
  // The id that left; it now names a new, empty person.
  unlinkedUserId: string;
}

export interface IdentityRouteOptions {
  hub?: EventHub;
  cache?: PermissionCache;
  now?: () => number;
}

function rateLimited(c: Context, result: ConsumeResult, what: string): never {
  const retryAfter = Math.max(result.retryAfterSeconds ?? 0, 1);
  c.header("Retry-After", String(retryAfter));
  throw Errors.rateLimitExceeded(`too many ${what}; retry after ${retryAfter}s`);
}

function bucketKey(gameId: string, userId: string): string {
  return `${gameId.length}:${gameId}|${userId}`;
}

// Limiter state is per instance, so each app (and each test app) starts
// with fresh budgets.
export function identityLinkHandlers(prisma: PrismaClient, opts: IdentityRouteOptions = {}) {
  const hub = opts.hub ?? defaultHub;
  const cache = opts.cache ?? permissionCache;
  const now = opts.now ?? Date.now;
  const issueLimiter = new RateLimiter(LINK_CODE_ISSUE_LIMIT, now);
  const redeemLimiter = new RateLimiter(LINK_CODE_REDEEM_LIMIT, now);
  const failedRedeemLimiter = new RateLimiter(LINK_CODE_FAILED_REDEEM_LIMIT, now);

  // POST /v1/users/:userId/link-codes
  const issue: Handler = async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const gameId = c.var.gameId;

    // Format and budget first, so a refused request creates nothing.
    await assertUserIdsWellFormed(prisma, gameId, [userId]);
    const limit = issueLimiter.consume(bucketKey(gameId, userId));
    if (!limit.allowed) rateLimited(c, limit, "link codes for this id");
    const junjoUserId = await findOrCreateJunjoUser(prisma, gameId, userId);

    const identity = await prisma.externalIdentity.findUnique({
      where: { gameId_externalUserId: { gameId, externalUserId: userId } },
      select: { id: true, junjoUserId: true },
    });
    // Moved by a concurrent unlink after the resolve above.
    if (!identity || identity.junjoUserId !== junjoUserId) throw Errors.notFound("user");
    if (await isBannedInGame(prisma, gameId, junjoUserId)) {
      throw Errors.banned("a banned id cannot request a link code");
    }

    const issuedAt = new Date(now());
    const expiresAt = new Date(issuedAt.getTime() + LINK_CODE_TTL_MS);
    for (let attempt = 0; ; attempt++) {
      const code = generateLinkCode();
      const codeHash = hashLinkCode(normalizeLinkCode(code) as string);
      try {
        await prisma.$transaction(async (tx) => {
          // One live code per id. Expired codes in the game are swept on
          // the way, so the table stays proportional to recent requests.
          await tx.linkCode.deleteMany({
            where: {
              OR: [{ externalIdentityId: identity.id }, { gameId, expiresAt: { lt: issuedAt } }],
            },
          });
          await tx.linkCode.create({
            data: {
              gameId,
              codeHash,
              externalIdentityId: identity.id,
              apiKeyId: currentRequestContext()?.apiKeyId ?? null,
              expiresAt,
            },
          });
        });
        return c.json<WireLinkCode>({ code, expiresAt: expiresAt.toISOString() }, 201);
      } catch (err) {
        // A live code in this game already has this hash: draw again.
        if (isUniqueViolation(err) && attempt < 3) continue;
        throw err;
      }
    }
  };

  // POST /v1/link-codes/redeem
  const redeem: Handler = async (c) => {
    const gameId = c.var.gameId;
    const json = await c.req.json().catch(() => null);
    if (json === null) throw Errors.badRequest("malformed JSON");
    const body = parseBody(redeemLinkCodeBody, json);

    const keyBucket = c.var.apiKeyPrefix;
    if (!failedRedeemLimiter.wouldAllow(keyBucket)) {
      rateLimited(c, { allowed: false, retryAfterSeconds: 2 }, "failed link code redeems");
    }
    await assertUserIdsWellFormed(prisma, gameId, [body.userId]);
    const limit = redeemLimiter.consume(bucketKey(gameId, body.userId));
    if (!limit.allowed) rateLimited(c, limit, "link code redeems for this id");

    // Unknown, expired and used codes are one answer, so a guesser
    // cannot tell them apart; each one spends the key's failure budget.
    const invalid = () => {
      failedRedeemLimiter.consume(keyBucket);
      return Errors.linkCodeInvalid();
    };
    const normalized = normalizeLinkCode(body.code);
    if (!normalized) throw invalid();
    const codeHash = hashLinkCode(normalized);
    const at = new Date(now());

    // Screens out dead codes before the redeeming id is created, so a
    // failed guess writes nothing. Re-checked under the transaction.
    const live = await prisma.linkCode.findUnique({
      where: { gameId_codeHash: { gameId, codeHash } },
      select: { usedAt: true, expiresAt: true },
    });
    if (!live || live.usedAt !== null || live.expiresAt <= at) throw invalid();
    const redeemerId = await findOrCreateJunjoUser(prisma, gameId, body.userId);

    const outcome = await prisma.$transaction(
      async (tx) => {
        const code = await tx.linkCode.findUnique({
          where: { gameId_codeHash: { gameId, codeHash } },
          select: {
            id: true,
            usedAt: true,
            expiresAt: true,
            externalIdentity: { select: { externalUserId: true, junjoUserId: true } },
          },
        });
        if (!code || code.usedAt !== null || code.expiresAt <= at) throw invalid();
        const issuerId = code.externalIdentity.junjoUserId;
        const issuerUserId = code.externalIdentity.externalUserId;
        if (issuerUserId === body.userId) {
          throw Errors.badRequest("a link code cannot be redeemed by the id that requested it");
        }

        // Single use, guarded against a concurrent redeem of the same
        // code. A refusal below rolls this back, so the code survives a
        // refused attempt until it expires.
        const consumed = await tx.linkCode.updateMany({
          where: { id: code.id, usedAt: null },
          data: { usedAt: at },
        });
        if (consumed.count === 0) throw invalid();

        if (issuerId === redeemerId) {
          return { changed: false as const, survivorId: issuerId, linkedUserId: body.userId };
        }

        const plan = await planLink(tx, gameId, issuerId, redeemerId);
        const linkedUserId = plan.survivor === "issuer" ? body.userId : issuerUserId;
        await mergePeople(tx, plan.survivorId, plan.attachedId, at);
        const ids = await orderedIdsOf(tx, gameId, plan.survivorId);
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: null,
            actorUserId: plan.survivorId,
            action: "identity.linked",
            targetId: linkedUserId,
            payload: {
              issuerUserId,
              redeemerUserId: body.userId,
              survivor: plan.survivor,
              identities: ids.map((i) => i.externalUserId),
            } as Prisma.InputJsonValue,
          },
        });
        const event = await stageEvent<IdentityLinkedEvent>(tx, {
          type: "identity.linked",
          gameId: gameId as GameId,
          userId: linkedUserId as UserId,
          linkedUserId: linkedUserId as UserId,
          identities: ids.map((i) => i.externalUserId as UserId),
        });
        return { changed: true as const, survivorId: plan.survivorId, linkedUserId, event };
      },
      { timeout: 30_000 },
    );

    if (outcome.changed) {
      publishStagedEvents(hub, outcome.event);
      // Cached answers are keyed by external id, and the moved id now
      // resolves to a different person.
      cache.clear();
    }
    const rows = await loadLinkedIdentities(prisma, gameId, outcome.survivorId);
    return c.json<WireIdentityLinked>({
      userId: await renderResolved(prisma, gameId, outcome.survivorId, outcome.linkedUserId),
      linkedUserId: outcome.linkedUserId,
      identities: rows.map(serializeLinkedIdentity),
    });
  };

  // POST /v1/users/:userId/unlink
  const unlink: Handler = async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const gameId = c.var.gameId;

    const junjoUserId = await findJunjoUserId(prisma, gameId, userId);
    if (!junjoUserId) throw Errors.notFound("user");

    const at = new Date(now());
    const outcome = await prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "JunjoUser" WHERE id = ${junjoUserId} FOR UPDATE`;
        const ids = await orderedIdsOf(tx, gameId, junjoUserId);
        const leaving = ids.find((i) => i.externalUserId === userId);
        // Moved by a concurrent link or unlink after the resolve above.
        if (!leaving) throw Errors.notFound("user");
        if (ids.length === 1) {
          throw Errors.badRequest("cannot unlink a person's only id in this game");
        }
        const footprint = await loadFootprint(tx, gameId, junjoUserId, at);
        if (footprint.banned) {
          throw Errors.banned("ids cannot be unlinked while the person is banned");
        }

        await splitIdentity(tx, leaving.id, at);
        const remaining = ids.filter((i) => i.id !== leaving.id);
        const first = remaining[0] as (typeof remaining)[number];
        await tx.auditEntry.create({
          data: {
            gameId,
            groupId: null,
            actorUserId: junjoUserId,
            action: "identity.unlinked",
            targetId: userId,
            payload: {
              identities: remaining.map((i) => i.externalUserId),
            } as Prisma.InputJsonValue,
          },
        });
        const event = await stageEvent<IdentityUnlinkedEvent>(tx, {
          type: "identity.unlinked",
          gameId: gameId as GameId,
          userId: first.externalUserId as UserId,
          unlinkedUserId: userId as UserId,
          identities: remaining.map((i) => i.externalUserId as UserId),
        });
        return { event, first: first.externalUserId };
      },
      { timeout: 30_000 },
    );

    publishStagedEvents(hub, outcome.event);
    cache.clear();
    const rows = await loadLinkedIdentities(prisma, gameId, junjoUserId);
    return c.json<WireIdentityUnlinked>({
      userId: await renderResolved(prisma, gameId, junjoUserId, outcome.first),
      unlinkedUserId: userId,
      identities: rows.map(serializeLinkedIdentity),
    });
  };

  return { issue, redeem, unlink };
}
