import { z } from "zod";
import { permissionContextSchema } from "../permissionContext.js";
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

export const updateMemberFields = z.object({
  metadata: z.record(z.unknown()).optional(),
  notesPublic: z.string().max(MEMBER_NOTES_MAX_LENGTH).nullable().optional(),
  notesPrivate: z.string().max(MEMBER_NOTES_MAX_LENGTH).nullable().optional(),
});

export const updateMemberBody = updateMemberFields.refine(
  (d) => Object.values(d).some((v) => v !== undefined),
  { message: "at least one field is required" },
);

export type UpdateMemberBody = z.infer<typeof updateMemberBody>;

// `value` is accepted as an alias of `grant`, matching the role-entry
// shape. Sending both is allowed only when they agree.
export const overridePermissionBody = z
  .object({
    grant: z.boolean().optional(),
    value: z.boolean().optional(),
    // Absent or empty targets the global override.
    context: permissionContextSchema.optional(),
  })
  .refine((d) => d.grant !== undefined || d.value !== undefined, {
    message: "grant (or value) is required",
    path: ["grant"],
  })
  .refine((d) => d.grant === undefined || d.value === undefined || d.grant === d.value, {
    message: "grant and value must agree when both are sent",
    path: ["value"],
  })
  .transform((d) => ({ grant: (d.grant ?? d.value) as boolean, context: d.context ?? {} }));

export type OverridePermissionBody = z.infer<typeof overridePermissionBody>;

export const MEMBER_IMPORT_MAX_ROWS = 500;

// POST /v1/groups/:id/members/import. The body schema checks only the
// envelope; each row is parsed with `memberImportRow` by the handler so
// a malformed row is reported with its index alongside every other
// failing row instead of failing the call with one message.
export const memberImportBody = z
  .object({
    members: z
      .array(z.unknown())
      .min(1, "members must contain at least one row")
      .max(MEMBER_IMPORT_MAX_ROWS, `members is limited to ${MEMBER_IMPORT_MAX_ROWS} rows`),
    allowBanned: z.boolean().optional(),
    actorUserId: z.string().min(1).optional(),
  })
  .strict();

export type MemberImportBody = z.infer<typeof memberImportBody>;

export const memberImportRow = z
  .object({
    userId: z.string().min(1).max(255),
    roleIds: z.array(z.string().min(1)).max(100).optional(),
    overrides: z
      .array(
        z
          .object({
            permission: z.string().min(1),
            value: z.boolean(),
            context: permissionContextSchema.optional(),
          })
          .strict(),
      )
      .max(500)
      .optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export type MemberImportRow = z.infer<typeof memberImportRow>;
