import { z } from "zod";
import { permissionContextSchema } from "../permissionContext.js";

export const ROLE_NAME_MAX_LENGTH = 64;
export const PERMISSION_KEY_MAX_LENGTH = 128;
// Caps on one role. The inheritance depth cap is `MAX_ROLE_DEPTH` in
// `permissionResolve.ts`.
export const MAX_ROLE_ENTRIES = 5000;
export const MAX_ROLE_PARENTS = 32;
// Role metadata is a free-form JSON object, capped like group metadata.
export const ROLE_METADATA_MAX_SERIALIZED = 16 * 1024;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HEX_COLOR_MESSAGE = "must be a 7-character hex color (e.g. #ff5050)";

const roleMetadata = z
  .record(z.unknown())
  .refine((m) => JSON.stringify(m).length <= ROLE_METADATA_MAX_SERIALIZED, {
    message: `metadata exceeds ${ROLE_METADATA_MAX_SERIALIZED} serialized characters`,
  });

const permissionKey = z.string().min(1).max(PERMISSION_KEY_MAX_LENGTH);

// `value` defaults to true (grant). `context` absent or empty targets
// the global entry.
export const grantPermissionBody = z.object({
  permission: permissionKey,
  value: z.boolean().optional(),
  context: permissionContextSchema.optional(),
});

export type GrantPermissionBody = z.infer<typeof grantPermissionBody>;

export const createRoleBody = z.object({
  name: z.string().min(1).max(ROLE_NAME_MAX_LENGTH),
  priority: z.number().int(),
  color: z.string().regex(HEX_COLOR_PATTERN, HEX_COLOR_MESSAGE).optional(),
  isDefault: z.boolean().optional(),
  metadata: roleMetadata.optional(),
});

export type CreateRoleBody = z.infer<typeof createRoleBody>;

export const updateRoleBody = z
  .object({
    name: z.string().min(1).max(ROLE_NAME_MAX_LENGTH).optional(),
    priority: z.number().int().optional(),
    color: z.string().regex(HEX_COLOR_PATTERN, HEX_COLOR_MESSAGE).nullable().optional(),
    isDefault: z.boolean().optional(),
    metadata: roleMetadata.optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export type UpdateRoleBody = z.infer<typeof updateRoleBody>;

export const replaceRoleEntriesBody = z
  .object({
    entries: z
      .array(
        z
          .object({
            permission: permissionKey,
            value: z.boolean(),
            context: permissionContextSchema.optional(),
          })
          .strict(),
      )
      .max(MAX_ROLE_ENTRIES, `entries exceeds the ${MAX_ROLE_ENTRIES} entry cap`),
  })
  .strict();

export type ReplaceRoleEntriesBody = z.infer<typeof replaceRoleEntriesBody>;

export const setRoleParentsBody = z
  .object({
    parents: z
      .array(z.string().min(1))
      .max(MAX_ROLE_PARENTS, `parents exceeds the ${MAX_ROLE_PARENTS} parent cap`),
  })
  .strict();

export type SetRoleParentsBody = z.infer<typeof setRoleParentsBody>;
