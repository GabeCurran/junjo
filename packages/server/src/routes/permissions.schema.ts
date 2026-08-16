import { z } from "zod";
import { PERMISSION_KEY_MAX_LENGTH } from "./roles.schema.js";

// Strict "true" / "false" matches the precedent set by the
// `includeExpired` / `includeUsed` flags on `listInvitationsQuery`.
const boolFlag = z
  .enum(["true", "false"])
  .optional()
  .transform((s) => s === "true");

export const checkPermissionQuery = z.object({
  userId: z.string().min(1),
  groupId: z.string().min(1),
  permission: z.string().min(1).max(PERMISSION_KEY_MAX_LENGTH),
  // Opt-in parent walk. Off keeps the historical behavior: resolution
  // against direct membership in the queried group only.
  inherit: boolFlag,
});

export type CheckPermissionQuery = z.infer<typeof checkPermissionQuery>;

// Batch cap. Each entry costs the same database work as a single check,
// so the cap bounds how much a caller can amplify one rate-limited
// request into server-side work.
export const MAX_BATCH_CHECKS = 100;

const checkTriple = z
  .object({
    userId: z.string().min(1),
    groupId: z.string().min(1),
    permission: z.string().min(1).max(PERMISSION_KEY_MAX_LENGTH),
  })
  .strict();

export const checkPermissionBatchBody = z
  .object({
    checks: z
      .array(checkTriple)
      .min(1)
      .max(MAX_BATCH_CHECKS, `checks exceeds the ${MAX_BATCH_CHECKS} entry cap`),
    // Applies to every entry in the batch; there is no per-entry flag.
    inherit: z.boolean().optional(),
  })
  .strict();

export type CheckPermissionBatchBody = z.infer<typeof checkPermissionBatchBody>;
