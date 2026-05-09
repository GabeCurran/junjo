import { z } from "zod";
import { pageLimit } from "./page.schema.js";

// POST /v1/bans
export const createGameBanBody = z
  .object({
    userId: z.string().min(1),
    reason: z.string().max(500).nullable().optional(),
    // Validator rejects past timestamps to catch typos client-side; lazy
    // expiry on read still treats already-elapsed values as not-banned
    // for any rows that pre-date this validation.
    expiresAt: z
      .string()
      .min(1)
      .refine((s) => !Number.isNaN(Date.parse(s)), {
        message: "expiresAt must be an ISO 8601 date",
      })
      .nullable()
      .optional(),
  })
  .strict();

export type CreateGameBanBody = z.infer<typeof createGameBanBody>;

// GET /v1/bans
export const listGameBansQuery = z.object({
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
  // When `true`, also returns rows whose expiresAt is in the past. The
  // default mirrors the runtime contract (the ban check ignores expired
  // rows) -- expired rows are surfaced only when the operator asks.
  includeExpired: z
    .enum(["true", "false"])
    .optional()
    .transform((s) => s === "true"),
});

export type ListGameBansQuery = z.infer<typeof listGameBansQuery>;

// GET /v1/bans/:userId/history
// Newest-first cursor pagination on (eventAt DESC, id DESC). Optional
// scope / groupId filters narrow the timeline to one surface.
export const listBanHistoryQuery = z.object({
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
  scope: z.enum(["game", "group"]).optional(),
  // When set, scope is forced to "group" implicitly. Mismatched
  // scope=game + groupId returns 400.
  groupId: z.string().min(1).optional(),
});

export type ListBanHistoryQuery = z.infer<typeof listBanHistoryQuery>;
