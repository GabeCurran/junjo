// Mutual-friend suggestions: ranked candidates who share at least
// `friends.discovery.minMutuals` mutual friends with :userId, excluding
// existing friends and anyone blocked in either direction.
//
// One $queryRaw per request joins the UserRelationship table against
// itself twice (me -> my friends -> their friends), groups by candidate,
// and orders by mutual count desc. Bounded to the visible scope so
// scope=network suggestions span sibling games.

import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Handler } from "hono";
import { z } from "zod";
import { gameIdsInScope, loadGameConfig } from "../config/loadGameConfig.js";
import { Errors } from "../errors.js";

// =====================================================================
// Wire shape
// =====================================================================

export interface WireFriendSuggestion {
  junjoUserId: string;
  mutualCount: number;
  // Up to 5 of the mutual friends, surfaced so the dashboard can show
  // "you know A, B, +3 others" without a separate fetch.
  sampleMutualJunjoUserIds: string[];
}

export interface WireFriendSuggestionList {
  items: WireFriendSuggestion[];
}

const querySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
  })
  .strict();

// =====================================================================
// Handler
// =====================================================================

export function listFriendSuggestionsHandler(prisma: PrismaClient): Handler {
  return async (c) => {
    const userId = c.req.param("userId");
    if (!userId) throw Errors.badRequest("userId is required");
    const parsedQ = querySchema.safeParse(c.req.query());
    if (!parsedQ.success) throw Errors.badRequest("invalid query");
    const { limit } = parsedQ.data;

    const gameId = c.var.gameId;
    const loaded = await loadGameConfig(prisma, gameId);
    if (!loaded.config.friends.enabled || !loaded.config.friends.discovery.enabled) {
      throw Errors.notFound("resource");
    }
    const minMutuals = loaded.config.friends.discovery.minMutuals;
    const visibleGameIds = await gameIdsInScope(prisma, loaded);

    // The query: candidate users C such that
    //   - At least `minMutuals` distinct users F exist where:
    //     - userId is friends with F (forward row exists)
    //     - F is friends with C (forward row exists)
    //   - C is NOT userId itself
    //   - C is NOT already a friend of userId
    //   - No block exists in either direction between userId and C
    //
    // sample_mutual_ids picks up to 5 distinct F values per candidate
    // for the dashboard's "you know A, B, +N others" affordance.
    type RawRow = {
      candidate_id: string;
      mutual_count: bigint;
      sample_mutual_ids: string[];
    };
    const rows = await prisma.$queryRaw<RawRow[]>(
      Prisma.sql`
        WITH visible_games AS (
          SELECT unnest(${visibleGameIds}::text[]) AS gid
        ),
        my_friends AS (
          SELECT DISTINCT "targetJunjoUserId" AS friend_id
          FROM "UserRelationship"
          WHERE "actorJunjoUserId" = ${userId}
            AND "type" = 'friend'
            AND "gameId" IN (SELECT gid FROM visible_games)
        ),
        candidates AS (
          SELECT
            fof."targetJunjoUserId" AS candidate_id,
            fof."actorJunjoUserId"  AS via_friend_id
          FROM "UserRelationship" fof
          WHERE fof."type" = 'friend'
            AND fof."gameId" IN (SELECT gid FROM visible_games)
            AND fof."actorJunjoUserId" IN (SELECT friend_id FROM my_friends)
            AND fof."targetJunjoUserId" <> ${userId}
            AND fof."targetJunjoUserId" NOT IN (SELECT friend_id FROM my_friends)
            AND NOT EXISTS (
              SELECT 1 FROM "UserRelationship" b
              WHERE b."type" = 'blocked'
                AND b."gameId" IN (SELECT gid FROM visible_games)
                AND (
                  (b."actorJunjoUserId" = ${userId} AND b."targetJunjoUserId" = fof."targetJunjoUserId")
                  OR
                  (b."targetJunjoUserId" = ${userId} AND b."actorJunjoUserId" = fof."targetJunjoUserId")
                )
            )
        )
        SELECT
          candidate_id,
          COUNT(DISTINCT via_friend_id)::bigint AS mutual_count,
          (ARRAY_AGG(DISTINCT via_friend_id))[1:5] AS sample_mutual_ids
        FROM candidates
        GROUP BY candidate_id
        HAVING COUNT(DISTINCT via_friend_id) >= ${minMutuals}
        ORDER BY mutual_count DESC, candidate_id ASC
        LIMIT ${limit};
      `,
    );

    const items: WireFriendSuggestion[] = rows.map((r) => ({
      junjoUserId: r.candidate_id,
      mutualCount: Number(r.mutual_count),
      sampleMutualJunjoUserIds: r.sample_mutual_ids ?? [],
    }));
    return c.json<WireFriendSuggestionList>({ items });
  };
}
