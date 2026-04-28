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

export const listGroupsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
  gameId: z.string().min(1).optional(),
});

export type ListGroupsQuery = z.infer<typeof listGroupsQuery>;

export const updateGroupBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    visibility: z.enum(VISIBILITY).optional(),
    metadata: z.record(z.unknown()).optional(),
    defaultRoleId: z.string().min(1).nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export type UpdateGroupBody = z.infer<typeof updateGroupBody>;

export const leaveGroupBody = z.object({
  userId: z.string().min(1),
});

export type LeaveGroupBody = z.infer<typeof leaveGroupBody>;

export const kickMemberBody = z
  .object({
    reason: z.string().max(500).nullable().optional(),
  })
  .optional()
  .transform((b) => b ?? {});

export type KickMemberBody = z.infer<typeof kickMemberBody>;

export const bulkInviteQuery = z.object({
  roleId: z.string().min(1).optional(),
});

export type BulkInviteQuery = z.infer<typeof bulkInviteQuery>;
