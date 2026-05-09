-- CreateTable
CREATE TABLE "BanHistory" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "groupId" TEXT,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "eventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorJunjoUserId" TEXT,

    CONSTRAINT "BanHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BanHistory_gameId_junjoUserId_eventAt_idx" ON "BanHistory"("gameId", "junjoUserId", "eventAt" DESC);

-- CreateIndex
CREATE INDEX "BanHistory_gameId_eventAt_idx" ON "BanHistory"("gameId", "eventAt" DESC);

-- AddForeignKey
ALTER TABLE "BanHistory" ADD CONSTRAINT "BanHistory_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanHistory" ADD CONSTRAINT "BanHistory_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BanHistory" ADD CONSTRAINT "BanHistory_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;
