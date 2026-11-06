import { RESERVED_SANCTION_TYPES, SANCTION_TYPE_PATTERN } from "@junjo.io/shared";
import { z } from "zod";
import { pageLimit } from "./page.schema.js";

const isoDate = (field: string) =>
  z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: `${field} must be an ISO 8601 date` });

const reserved: readonly string[] = RESERVED_SANCTION_TYPES;

// A sanction type. Reserved names belong to dedicated APIs.
export const sanctionTypeSchema = z
  .string()
  .regex(
    new RegExp(SANCTION_TYPE_PATTERN),
    "type must be 1-32 of a-z, 0-9, _, . or -, starting with a letter or digit",
  )
  .refine((t) => !reserved.includes(t), { message: "this type is reserved; use the ban API" });

// POST /v1/sanctions
export const createSanctionBody = z
  .object({
    userId: z.string().min(1),
    type: sanctionTypeSchema,
    reason: z.string().max(500).nullable().optional(),
    // A past value creates a sanction that is already expired.
    expiresAt: isoDate("expiresAt").nullable().optional(),
    // May be in the past; the handler rejects values more than
    // SANCTION_STARTED_AT_MAX_SKEW_MS ahead of the server clock.
    startedAt: isoDate("startedAt").optional(),
    issuer: z.string().min(1).max(128).optional(),
    actorUserId: z.string().min(1).optional(),
  })
  .strict();

export const SANCTION_STARTED_AT_MAX_SKEW_MS = 60_000;

// DELETE /v1/sanctions/:userId/:type. The body is optional.
export const deleteSanctionBody = z
  .object({
    actorUserId: z.string().min(1).optional(),
  })
  .strict();

// GET /v1/sanctions
export const listSanctionsQuery = z.object({
  type: sanctionTypeSchema.optional(),
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
});

// GET /v1/users/:userId/sanctions/history
export const listSanctionHistoryQuery = z.object({
  type: sanctionTypeSchema.optional(),
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
});
