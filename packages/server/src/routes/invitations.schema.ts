import { z } from "zod";

export const inviteByUserIdBody = z.object({
  targetUserId: z.string().min(1),
  roleId: z.string().min(1).optional(),
});

export type InviteByUserIdBody = z.infer<typeof inviteByUserIdBody>;
