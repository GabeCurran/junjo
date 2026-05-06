-- AlterTable
ALTER TABLE "Game" ADD COLUMN     "config" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "networkId" TEXT;

-- CreateIndex
CREATE INDEX "Game_networkId_idx" ON "Game"("networkId");
