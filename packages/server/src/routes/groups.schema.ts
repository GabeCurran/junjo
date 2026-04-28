import { z } from "zod";

const VISIBILITY = ["public", "invite-only", "secret"] as const;

export const createGroupBody = z.object({
  kind: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  visibility: z.enum(VISIBILITY).optional(),
  metadata: z.record(z.unknown()).optional(),
  defaultRoleId: z.string().min(1).optional(),
});

export type CreateGroupBody = z.infer<typeof createGroupBody>;
