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

// Relationship `type` is dev-defined (the schema stores it as a free
// string). Capped at 64 chars to match `Role.name` (the other open string
// devs commonly hand the API).
export const RELATIONSHIP_TYPE_MAX_LENGTH = 64;

export const setRelationshipBody = z.object({
  type: z.string().min(1).max(RELATIONSHIP_TYPE_MAX_LENGTH),
  mutual: z.boolean().optional(),
});

export type SetRelationshipBody = z.infer<typeof setRelationshipBody>;

// Strict "true" / "false" matches the precedent set by the
// `includeExpired` / `includeUsed` flags on `listInvitationsQuery`.
export const clearRelationshipQuery = z.object({
  mutual: z.enum(["true", "false"]).optional(),
});

export type ClearRelationshipQuery = z.infer<typeof clearRelationshipQuery>;
