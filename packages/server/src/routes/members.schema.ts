import { z } from "zod";
import { pageLimit } from "./page.schema.js";

export const MEMBER_STATUSES = ["active", "invited", "left", "kicked", "banned"] as const;
export type MemberStatusString = (typeof MEMBER_STATUSES)[number];

// Comma-separated list of statuses, or a single status. Validated to a
// deduped tuple so the SQL `IN` clause stays minimal. Empty string =
// no filter (same as omitting the parameter entirely).
const memberStatusesParam = z
  .string()
  .optional()
  .transform((s) => {
    if (!s) return undefined;
    return Array.from(
      new Set(
        s
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0),
      ),
    );
  })
  .refine(
    (arr) =>
      arr === undefined || arr.every((s) => (MEMBER_STATUSES as readonly string[]).includes(s)),
    { message: `status must be one or more of: ${MEMBER_STATUSES.join(", ")}` },
  )
  .transform((arr) => arr as MemberStatusString[] | undefined);

export const listMembersQuery = z.object({
  limit: pageLimit(50),
  cursor: z.string().min(1).optional(),
  status: memberStatusesParam,
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

export const overridePermissionBody = z.object({
  grant: z.boolean(),
});

export type OverridePermissionBody = z.infer<typeof overridePermissionBody>;
