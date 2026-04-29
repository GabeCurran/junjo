// @cloud-only
//
// Schemas for admin-token-gated endpoints (Phase 11.2a, 11.3a). Co-located
// with `routes/admin.ts` per the existing route-module convention.

import { z } from "zod";

export const GAME_NAME_MAX_LENGTH = 200;

export const listRecentAuditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const listAdminGamesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const createGameBody = z.object({
  name: z.string().min(1).max(GAME_NAME_MAX_LENGTH),
});

export type ListRecentAuditQuery = z.infer<typeof listRecentAuditQuery>;
export type ListAdminGamesQuery = z.infer<typeof listAdminGamesQuery>;
export type CreateGameBody = z.infer<typeof createGameBody>;
