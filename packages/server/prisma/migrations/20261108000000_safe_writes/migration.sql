-- AlterTable
ALTER TABLE "BanHistory" ADD COLUMN     "issuer" TEXT;

-- AlterTable
ALTER TABLE "GameBan" ADD COLUMN     "issuer" TEXT;

-- AlterTable
ALTER TABLE "GroupMember" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "apiKeyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "responseHeaders" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("apiKeyId","key")
);

-- CreateTable
CREATE TABLE "ModerationState" (
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModerationState_pkey" PRIMARY KEY ("gameId","junjoUserId")
);

-- CreateIndex
CREATE INDEX "IdempotencyRecord_createdAt_idx" ON "IdempotencyRecord"("createdAt");

-- CreateIndex
CREATE INDEX "ModerationState_junjoUserId_idx" ON "ModerationState"("junjoUserId");

-- AddForeignKey
ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "IdempotencyRecord_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationState" ADD CONSTRAINT "ModerationState_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModerationState" ADD CONSTRAINT "ModerationState_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every person who already has a game ban or game-scope ban
-- history starts at the number of game-scope ban events recorded for
-- them (at least 1 when a ban row exists), so a conditional write made
-- against a pre-migration read of 0 is refused.
INSERT INTO "ModerationState" ("gameId", "junjoUserId", "version", "updatedAt")
SELECT p."gameId", p."junjoUserId", GREATEST(COALESCE(h.n, 0), CASE WHEN b.id IS NULL THEN 0 ELSE 1 END)::int, CURRENT_TIMESTAMP
FROM (
    SELECT "gameId", "junjoUserId" FROM "GameBan"
    UNION
    SELECT "gameId", "junjoUserId" FROM "BanHistory" WHERE "scope" = 'game'
) p
LEFT JOIN (
    SELECT "gameId", "junjoUserId", COUNT(*) AS n FROM "BanHistory" WHERE "scope" = 'game'
    GROUP BY "gameId", "junjoUserId"
) h ON h."gameId" = p."gameId" AND h."junjoUserId" = p."junjoUserId"
LEFT JOIN "GameBan" b ON b."gameId" = p."gameId" AND b."junjoUserId" = p."junjoUserId";
