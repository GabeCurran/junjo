-- DropIndex
DROP INDEX "Group_gameId_idx";

-- CreateIndex
CREATE INDEX "ExternalIdentity_gameId_junjoUserId_idx" ON "ExternalIdentity"("gameId", "junjoUserId");

-- CreateIndex
CREATE INDEX "Group_gameId_createdAt_id_idx" ON "Group"("gameId", "createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "GroupMember_groupId_joinedAt_id_idx" ON "GroupMember"("groupId", "joinedAt" DESC, "id" DESC);
