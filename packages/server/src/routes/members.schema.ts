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
