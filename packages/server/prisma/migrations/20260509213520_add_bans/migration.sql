-- AlterTable
ALTER TABLE "GroupMember" ADD COLUMN     "bannedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "GameBan" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "bannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "reason" TEXT,
    "bannedByUserId" TEXT,

    CONSTRAINT "GameBan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GameBan_gameId_expiresAt_idx" ON "GameBan"("gameId", "expiresAt");

-- CreateIndex
CREATE INDEX "GameBan_junjoUserId_idx" ON "GameBan"("junjoUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GameBan_gameId_junjoUserId_key" ON "GameBan"("gameId", "junjoUserId");

-- AddForeignKey
ALTER TABLE "GameBan" ADD CONSTRAINT "GameBan_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GameBan" ADD CONSTRAINT "GameBan_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
