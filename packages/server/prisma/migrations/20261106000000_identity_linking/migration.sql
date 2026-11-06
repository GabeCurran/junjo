-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "name" TEXT,
ADD COLUMN     "preferredNamespaces" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "AuditEntry" ADD COLUMN     "apiKeyId" TEXT;

-- AlterTable
ALTER TABLE "ExternalIdentity" ADD COLUMN     "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing ids have never been linked, so they joined their person when created.
UPDATE "ExternalIdentity" SET "linkedAt" = "createdAt";

-- AlterTable
ALTER TABLE "WebhookEndpoint" ADD COLUMN     "preferredNamespaces" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "LinkCode" (
    "id" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "externalIdentityId" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "LinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkCode_externalIdentityId_idx" ON "LinkCode"("externalIdentityId");

-- CreateIndex
CREATE INDEX "LinkCode_expiresAt_idx" ON "LinkCode"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "LinkCode_gameId_codeHash_key" ON "LinkCode"("gameId", "codeHash");

-- AddForeignKey
ALTER TABLE "LinkCode" ADD CONSTRAINT "LinkCode_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "Game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkCode" ADD CONSTRAINT "LinkCode_externalIdentityId_fkey" FOREIGN KEY ("externalIdentityId") REFERENCES "ExternalIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinkCode" ADD CONSTRAINT "LinkCode_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

