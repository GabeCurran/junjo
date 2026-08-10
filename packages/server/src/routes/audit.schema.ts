import type { AuditAction } from "@junjo.io/shared";
import { z } from "zod";
import { pageLimit } from "./page.schema.js";

// Mirrors the `AuditAction` union in `@junjo.io/shared`: every mutation
// that writes an `auditEntry.create` uses one of these strings, and
// `audit.list` validates the `?actions=` filter against this same set.
// The `_exhaustive` assertions below turn drift in either direction
// into a typecheck failure.
export const AUDIT_ACTIONS = [
  "group.created",
  "group.updated",
  "group.deleted",
  "group.restored",
  "group.relationship.set",
  "group.relationship.cleared",
  "group.parent.set",
  "group.parent.cleared",
  "group.passcode.set",
  "group.passcode.cleared",
  "member.invited",
  "member.joined",
  "member.left",
  "member.kicked",
  "member.banned",
  "member.unbanned",
  "member.metadata.updated",
  "member.notes.updated",
  "game.user.banned",
  "game.user.unbanned",
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

// Compile-time lockstep guard: both directions must be `never`.
type MissingFromList = Exclude<AuditAction, AuditActionString>;
type ExtraInList = Exclude<AuditActionString, AuditAction>;
const _exhaustiveMissing: MissingFromList[] = [] satisfies never[];
const _exhaustiveExtra: ExtraInList[] = [] satisfies never[];
void _exhaustiveMissing;
void _exhaustiveExtra;

export const listAuditQuery = z.object({
  limit: pageLimit(50),
  // Either an audit entry id (the value `nextCursor` returns) or an ISO
  // 8601 timestamp (the original strictly-older-than contract). Ids are
  // validated against the database in `auditBeforeFilter`.
  before: z.string().min(1).max(255).optional(),
  actions: z.array(z.enum(AUDIT_ACTIONS)).optional(),
});

export type ListAuditQuery = z.infer<typeof listAuditQuery>;
