import { z } from "zod";

export const listMembersQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).optional(),
});

export type ListMembersQuery = z.infer<typeof listMembersQuery>;

export const listMembersForUserQuery = z.object({
  gameId: z.string().min(1).optional(),
});

export type ListMembersForUserQuery = z.infer<typeof listMembersForUserQuery>;

export const MEMBER_NOTES_MAX_LENGTH = 5000;

export const updateMemberBody = z
  .object({
    metadata: z.record(z.unknown()).optional(),
    notesPublic: z.string().max(MEMBER_NOTES_MAX_LENGTH).nullable().optional(),
    notesPrivate: z.string().max(MEMBER_NOTES_MAX_LENGTH).nullable().optional(),
  })
  .refine((d) => Object.values(d).some((v) => v !== undefined), {
    message: "at least one field is required",
  });

export type UpdateMemberBody = z.infer<typeof updateMemberBody>;
