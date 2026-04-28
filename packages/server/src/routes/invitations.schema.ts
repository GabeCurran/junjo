import { z } from "zod";

const expiresInPattern = /^\d+[smhd]$/;

export const createInvitationBody = z.object({
  targetUserId: z.string().min(1).optional(),
  roleId: z.string().min(1).optional(),
  expiresIn: z
    .string()
    .regex(expiresInPattern, "expiresIn must match <positive integer><unit> where unit is s|m|h|d")
    .optional(),
});

export type CreateInvitationBody = z.infer<typeof createInvitationBody>;
