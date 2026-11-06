-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "canExport" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ExternalIdentity" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "displayNameUpdatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Group" ADD COLUMN     "memberActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "Sanction" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "reason" TEXT,
    "issuer" TEXT,
    "issuedByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "context" TEXT,

    CONSTRAINT "Sanction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SanctionHistory" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "junjoUserId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT,
    "expiresAt" TIMESTAMP(3),
    "eventAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorJunjoUserId" TEXT,
    "issuer" TEXT,

    CONSTRAINT "SanctionHistory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Sanction_gameId_startedAt_id_idx" ON "Sanction"("gameId", "startedAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "Sanction_junjoUserId_idx" ON "Sanction"("junjoUserId");

-- CreateIndex
CREATE UNIQUE INDEX "Sanction_gameId_junjoUserId_type_key" ON "Sanction"("gameId", "junjoUserId", "type");

-- CreateIndex
CREATE INDEX "SanctionHistory_gameId_junjoUserId_eventAt_idx" ON "SanctionHistory"("gameId", "junjoUserId", "eventAt" DESC);

-- CreateIndex
CREATE INDEX "SanctionHistory_gameId_eventAt_idx" ON "SanctionHistory"("gameId", "eventAt" DESC);

-- CreateIndex
CREATE INDEX "Group_gameId_kind_memberActivityAt_idx" ON "Group"("gameId", "kind", "memberActivityAt");

-- AddForeignKey
ALTER TABLE "Sanction" ADD CONSTRAINT "Sanction_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sanction" ADD CONSTRAINT "Sanction_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SanctionHistory" ADD CONSTRAINT "SanctionHistory_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SanctionHistory" ADD CONSTRAINT "SanctionHistory_junjoUserId_fkey" FOREIGN KEY ("junjoUserId") REFERENCES "JunjoUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Display-name lookup matches ignoring case. An expression index, so it
-- is created here rather than declared in the schema.
CREATE INDEX "ExternalIdentity_gameId_lower_displayName_idx" ON "ExternalIdentity"("gameId", lower("displayName")) WHERE "displayName" IS NOT NULL;

-- Backfill: a group's membership activity starts at its latest member
-- join or departure, or its creation when it never had a member, so the
-- idle sweeper does not treat every existing group as freshly active.
UPDATE "Group" g SET "memberActivityAt" = GREATEST(
    g."createdAt",
    COALESCE((SELECT MAX(m."joinedAt") FROM "GroupMember" m WHERE m."groupId" = g.id), g."createdAt"),
    COALESCE((SELECT MAX(m."leftAt") FROM "GroupMember" m WHERE m."groupId" = g.id), g."createdAt")
);
