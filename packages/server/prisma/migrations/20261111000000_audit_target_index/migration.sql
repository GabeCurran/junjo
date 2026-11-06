-- CreateIndex
CREATE INDEX "AuditEntry_gameId_targetId_createdAt_idx" ON "AuditEntry"("gameId", "targetId", "createdAt" DESC);
