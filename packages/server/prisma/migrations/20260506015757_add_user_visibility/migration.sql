-- CreateTable
CREATE TABLE "UserVisibility" (
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "friendsListVisibility" TEXT NOT NULL DEFAULT 'private',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserVisibility_pkey" PRIMARY KEY ("gameId","junjoUserId")
);

-- CreateIndex
CREATE INDEX "UserVisibility_junjoUserId_idx" ON "UserVisibility"("junjoUserId");

-- AddForeignKey
ALTER TABLE "UserVisibility" ADD CONSTRAINT "UserVisibility_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserVisibility" ADD CONSTRAINT "UserVisibility_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
