-- AuditEntry now carries a denormalized gameId so game-scoped events
-- (e.g. game.user.banned with groupId=null) can be audit-logged and the
-- per-game admin feed can query a single index instead of joining
-- through Group. groupId becomes nullable to support those events.

-- 1. Add gameId nullable + drop NOT NULL on groupId.
ALTER TABLE "AuditEntry" ADD COLUMN "gameId" TEXT;
ALTER TABLE "AuditEntry" ALTER COLUMN "groupId" DROP NOT NULL;

-- 2. Backfill gameId from each row's Group.gameId. Every existing row
--    has a non-null groupId (the column was NOT NULL until this
--    migration), so the join always finds a match.
UPDATE "AuditEntry" ae
SET "gameId" = g."gameId"
FROM "Group" g
WHERE ae."groupId" = g."id";

-- 3. Now lock gameId as NOT NULL.
ALTER TABLE "AuditEntry" ALTER COLUMN "gameId" SET NOT NULL;

-- 4. Index + FK to support per-game admin queries.
CREATE INDEX "AuditEntry_gameId_createdAt_idx" ON "AuditEntry"("gameId", "createdAt" DESC);
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
