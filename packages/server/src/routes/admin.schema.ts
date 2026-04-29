// @cloud-only
//
// Schemas for admin-token-gated endpoints (Phase 11.2a). Co-located with
// `routes/admin.ts` per the existing route-module convention.

import { z } from "zod";

export const listRecentAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type ListRecentAuditQuery = z.infer<typeof listRecentAuditQuery>;
