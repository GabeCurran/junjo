import { z } from "zod";
import { pageLimit } from "./page.schema.js";

// Mirrors the `AuditAction` union in `@junjo/shared`. Kept in lockstep
// by hand: every mutation that writes an `auditEntry.create` uses one of
// these strings, and `audit.list` validates the `?actions=` filter
// against this same set.
export const AUDIT_ACTIONS = [
  "group.created",
  "group.updated",
  "group.deleted",
  "group.restored",
  "group.relationship.set",
  "group.relationship.cleared",
  "group.parent.set",
  "group.parent.cleared",
  "member.invited",
  "member.joined",
  "member.left",
  "member.kicked",
  "member.metadata.updated",
  "member.notes.updated",
  "role.created",
  "role.updated",
  "role.deleted",
  "role.assigned",
  "role.unassigned",
  "permission.granted",
  "permission.revoked",
  "permission.override.set",
  "permission.override.cleared",
] as const;

export type AuditActionString = (typeof AUDIT_ACTIONS)[number];

export const listAuditQuery = z.object({
  limit: pageLimit(50),
  before: z
    .string()
    .min(1)
    .refine((s) => !Number.isNaN(Date.parse(s)), { message: "before must be an ISO 8601 date" })
    .optional(),
  actions: z.array(z.enum(AUDIT_ACTIONS)).optional(),
});

export type ListAuditQuery = z.infer<typeof listAuditQuery>;
