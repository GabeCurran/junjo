-- CreateTable
CREATE TABLE "GroupVersion" (
    "groupId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,

    CONSTRAINT "GroupVersion_pkey" PRIMARY KEY ("groupId")
);

-- CreateIndex
CREATE INDEX "GroupVersion_gameId_idx" ON "GroupVersion"("gameId");

-- AddForeignKey
ALTER TABLE "GroupVersion" ADD CONSTRAINT "GroupVersion_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;
