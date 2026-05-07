import { z } from "zod";
import { pageLimit } from "./page.schema.js";

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

const boolFlag = z
  .enum(["true", "false"])
  .optional()
  .transform((s) => s === "true");

export const listInvitationsQuery = z.object({
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
  includeExpired: boolFlag,
  includeUsed: boolFlag,
});

export type ListInvitationsQuery = z.infer<typeof listInvitationsQuery>;

export const acceptInvitationBody = z.object({
  userId: z.string().min(1),
});

export type AcceptInvitationBody = z.infer<typeof acceptInvitationBody>;

export const declineInvitationBody = z
  .object({
    userId: z.string().min(1).optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export type DeclineInvitationBody = z.infer<typeof declineInvitationBody>;
