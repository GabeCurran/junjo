import { z } from "zod";
import { PERMISSION_KEY_MAX_LENGTH } from "./roles.schema.js";

export const checkPermissionQuery = z.object({
  userId: z.string().min(1),
  groupId: z.string().min(1),
  permission: z.string().min(1).max(PERMISSION_KEY_MAX_LENGTH),
});

export type CheckPermissionQuery = z.infer<typeof checkPermissionQuery>;
