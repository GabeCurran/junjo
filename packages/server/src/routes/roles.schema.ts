import { z } from "zod";

export const ROLE_NAME_MAX_LENGTH = 64;
export const PERMISSION_KEY_MAX_LENGTH = 128;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const HEX_COLOR_MESSAGE = "must be a 7-character hex color (e.g. #ff5050)";

export const grantPermissionBody = z.object({
  permission: z.string().min(1).max(PERMISSION_KEY_MAX_LENGTH),
});

export type GrantPermissionBody = z.infer<typeof grantPermissionBody>;

export const createRoleBody = z.object({
  name: z.string().min(1).max(ROLE_NAME_MAX_LENGTH),
  priority: z.number().int(),
  color: z.string().regex(HEX_COLOR_PATTERN, HEX_COLOR_MESSAGE).optional(),
  isDefault: z.boolean().optional(),
});

export type CreateRoleBody = z.infer<typeof createRoleBody>;

export const updateRoleBody = z
  .object({
    name: z.string().min(1).max(ROLE_NAME_MAX_LENGTH).optional(),
    priority: z.number().int().optional(),
    color: z.string().regex(HEX_COLOR_PATTERN, HEX_COLOR_MESSAGE).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export type UpdateRoleBody = z.infer<typeof updateRoleBody>;
