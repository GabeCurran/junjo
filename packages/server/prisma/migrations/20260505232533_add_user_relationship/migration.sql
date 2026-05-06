-- CreateTable
CREATE TABLE "UserRelationship" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "actorJunjoUserId" TEXT NOT NULL,
    "targetJunjoUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "UserRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRelationship_gameId_targetJunjoUserId_type_idx" ON "UserRelationship"("gameId", "targetJunjoUserId", "type");

-- CreateIndex
CREATE INDEX "UserRelationship_gameId_actorJunjoUserId_type_idx" ON "UserRelationship"("gameId", "actorJunjoUserId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "UserRelationship_gameId_actorJunjoUserId_targetJunjoUserId__key" ON "UserRelationship"("gameId", "actorJunjoUserId", "targetJunjoUserId", "type");

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_actorJunjoUserId_fkey" FOREIGN KEY ("actorJunjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationship" ADD CONSTRAINT "UserRelationship_targetJunjoUserId_fkey" FOREIGN KEY ("targetJunjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;
