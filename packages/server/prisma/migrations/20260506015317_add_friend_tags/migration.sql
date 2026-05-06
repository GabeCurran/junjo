-- CreateTable
CREATE TABLE "FriendTag" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FriendTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserRelationshipTag" (
    "userRelationshipId" TEXT NOT NULL,
    "friendTagId" TEXT NOT NULL,
    "taggedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserRelationshipTag_pkey" PRIMARY KEY ("userRelationshipId","friendTagId")
);

-- CreateIndex
CREATE INDEX "FriendTag_gameId_junjoUserId_idx" ON "FriendTag"("gameId", "junjoUserId");

-- CreateIndex
CREATE UNIQUE INDEX "FriendTag_gameId_junjoUserId_name_key" ON "FriendTag"("gameId", "junjoUserId", "name");

-- CreateIndex
CREATE INDEX "UserRelationshipTag_friendTagId_idx" ON "UserRelationshipTag"("friendTagId");

-- AddForeignKey
ALTER TABLE "FriendTag" ADD CONSTRAINT "FriendTag_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FriendTag" ADD CONSTRAINT "FriendTag_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationshipTag" ADD CONSTRAINT "UserRelationshipTag_userRelationshipId_fkey" FOREIGN KEY ("userRelationshipId") REFERENCES "UserRelationship"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRelationshipTag" ADD CONSTRAINT "UserRelationshipTag_friendTagId_fkey" FOREIGN KEY ("friendTagId") REFERENCES "FriendTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
