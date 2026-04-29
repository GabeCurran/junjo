// @cloud-only
//
// Cross-game user query (Phase 10.2). Returns every game a Junjo user has an
// `ExternalIdentity` row in, alongside the dev-supplied external id and the
// number of active group memberships in that game. Gated by the admin token
// (separate auth scheme from per-game API keys), so it lives outside the
// per-game `apiKeyMiddleware` chain. Mirror SDK is intentionally NOT shipped
// in V1 per the VISION spec; the dashboard calls this endpoint directly via
// fetch.

import type { PrismaClient } from "@prisma/client";
import type { Handler } from "hono";
import { Errors } from "../errors.js";

export interface WireUserGameRow {
  gameId: string;
  externalUserId: string;
  joinedGroupCount: number;
}

export interface WireUserGames {
  junjoUserId: string;
  games: WireUserGameRow[];
}

// `GET /v1/users/:junjoUserId/games`. The `junjoUserId` path parameter is the
// internal cross-game id (a `JunjoUser.id`), not a dev-supplied external user
// id; the dashboard knows this id because it queried Postgres directly or
// observed it on a webhook payload.
//
// Response shape:
//
//   {
//     junjoUserId: "...",
//     games: [
//       { gameId, externalUserId, joinedGroupCount },
//       ...
//     ]
//   }
//
// Behavior:
//
//   - A `junjoUserId` with no `ExternalIdentity` rows returns 200 with
//     `games: []`. The route does not 404 because the user might exist but
//     have no cross-game footprint (newly-created JunjoUser whose first
//     ExternalIdentity is still pending), and "no games" is the same answer
//     for the consumer either way.
//
//   - `joinedGroupCount` is the count of `GroupMember` rows in `status:
//     "active"` whose group belongs to the listed game and is not
//     soft-deleted. Matches the `Group.memberCount` precedent (and the
//     permission resolver's "non-active = effectively not a member" rule).
//
//   - Games are sorted by `gameId` ascending for deterministic output;
//     pagination is intentionally absent (a single Junjo user across more
//     than a few hundred games is not a V1 concern).
export function listUserGamesHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const junjoUserId = c.req.param("junjoUserId");
    // Hono's path-parameter typing widens to `string | undefined`; the
    // matched route guarantees a non-empty value at runtime, but the
    // type system needs a defensive narrow.
    if (!junjoUserId) throw Errors.badRequest("junjoUserId is required");

    const identities = await prisma.externalIdentity.findMany({
      where: { junjoUserId },
      select: { gameId: true, externalUserId: true },
      orderBy: { gameId: "asc" },
    });

    if (identities.length === 0) {
      return c.json<WireUserGames>({ junjoUserId, games: [] });
    }

    // Single batched query for active memberships across every game the
    // user has an identity in; the in-memory tally below avoids N+1 counts.
    const memberRows = await prisma.groupMember.findMany({
      where: {
        junjoUserId,
        status: "active",
        group: { softDeletedAt: null },
      },
      select: { group: { select: { gameId: true } } },
    });

    const counts = new Map<string, number>();
    for (const row of memberRows) {
      const id = row.group.gameId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const games: WireUserGameRow[] = identities.map((identity) => ({
      gameId: identity.gameId,
      externalUserId: identity.externalUserId,
      joinedGroupCount: counts.get(identity.gameId) ?? 0,
    }));

    return c.json<WireUserGames>({ junjoUserId, games });
  };
}
