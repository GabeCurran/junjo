-- CreateIndex
CREATE INDEX "AuditEntry_createdAt_id_idx" ON "AuditEntry"("createdAt" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "AuditEntry_gameId_action_createdAt_idx" ON "AuditEntry"("gameId", "action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "BanHistory_groupId_idx" ON "BanHistory"("groupId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_createdAt_idx" ON "WebhookDelivery"("status", "createdAt");
