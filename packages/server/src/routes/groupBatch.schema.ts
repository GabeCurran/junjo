import { GROUP_BATCH_MAX_OPS, type GroupBatchOpName } from "@junjo.io/shared";
import { type ZodTypeAny, z } from "zod";
import { Errors, JunjoError } from "../errors.js";
import { permissionContextSchema } from "../permissionContext.js";
import { formatIssues } from "../validation.js";
import {
  addMemberBody,
  banMemberFields,
  kickMemberFields,
  leaveGroupBody,
  namesGroupChange,
  roleAssignFields,
  setRelationshipBody,
  unbanMemberFields,
  updateGroupFields,
} from "./groups.schema.js";
import { updateMemberFields } from "./members.schema.js";
import { grantPermissionBody } from "./roles.schema.js";

// Each op reuses its single route's field schema, with the path
// parameters as fields and unknown fields refused.

const userId = z.string().min(1);
const roleId = z.string().min(1);
const otherGroupId = z.string().min(1);

const memberAdd = addMemberBody
  .extend({ op: z.literal("member.add"), createOnly: z.boolean().optional() })
  .strict();
const memberKick = kickMemberFields.extend({ op: z.literal("member.kick"), userId }).strict();
const memberLeave = leaveGroupBody.extend({ op: z.literal("member.leave") }).strict();
const memberBan = banMemberFields.extend({ op: z.literal("member.ban"), userId }).strict();
const memberUnban = unbanMemberFields.extend({ op: z.literal("member.unban"), userId }).strict();
const memberUpdate = updateMemberFields
  .extend({ op: z.literal("member.update"), userId })
  .strict()
  .refine((d) => [d.metadata, d.notesPublic, d.notesPrivate].some((v) => v !== undefined), {
    message: "at least one field is required",
  });
const memberRoleAdd = roleAssignFields
  .extend({ op: z.literal("member.role.add"), userId, roleId })
  .strict();
const memberRoleRemove = roleAssignFields
  .extend({ op: z.literal("member.role.remove"), userId, roleId })
  .strict();
const groupUpdate = updateGroupFields
  .omit({ passcode: true })
  .extend({ op: z.literal("group.update") })
  .strict()
  .refine((d) => namesGroupChange(d, ["actorUserId", "op"]), {
    message: "at least one field is required",
  });
const roleEntrySet = grantPermissionBody
  .extend({ op: z.literal("role.entry.set"), roleId })
  .strict();
const roleEntryRemove = z
  .object({
    op: z.literal("role.entry.remove"),
    roleId,
    permission: z.string().min(1),
    context: permissionContextSchema.optional(),
  })
  .strict();
const relationshipSet = setRelationshipBody
  .extend({ op: z.literal("relationship.set"), otherGroupId })
  .strict();
const relationshipClear = z
  .object({
    op: z.literal("relationship.clear"),
    otherGroupId,
    mutual: z.boolean().optional(),
    actorUserId: z.string().min(1).optional(),
  })
  .strict();

const OP_SCHEMAS = {
  "member.add": memberAdd,
  "member.kick": memberKick,
  "member.leave": memberLeave,
  "member.ban": memberBan,
  "member.unban": memberUnban,
  "member.update": memberUpdate,
  "member.role.add": memberRoleAdd,
  "member.role.remove": memberRoleRemove,
  "group.update": groupUpdate,
  "role.entry.set": roleEntrySet,
  "role.entry.remove": roleEntryRemove,
  "relationship.set": relationshipSet,
  "relationship.clear": relationshipClear,
} as const satisfies Record<GroupBatchOpName, ZodTypeAny>;

type OpSchemas = typeof OP_SCHEMAS;
export type BatchOp = { [K in keyof OpSchemas]: z.infer<OpSchemas[K]> }[keyof OpSchemas];

const envelope = z.object({ ops: z.array(z.unknown()).min(1).max(GROUP_BATCH_MAX_OPS) }).strict();

function opError(index: number, message: string): JunjoError {
  return new JunjoError("bad_request", 400, `ops.${index}: ${message}`, { opIndex: index });
}

// Parses the whole body before anything is read or written. A
// malformed envelope is a plain 400; a malformed op is a 400 whose
// `details.opIndex` names the first bad op.
export function parseGroupBatchBody(input: unknown): BatchOp[] {
  const parsed = envelope.safeParse(input);
  if (!parsed.success)
    throw Errors.badRequest(formatIssues(parsed.error) || "invalid request body");
  return parsed.data.ops.map((raw, index) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw opError(index, "must be an object");
    }
    const name = (raw as { op?: unknown }).op;
    if (typeof name !== "string" || !Object.hasOwn(OP_SCHEMAS, name)) {
      throw opError(index, `op must be one of: ${Object.keys(OP_SCHEMAS).join(", ")}`);
    }
    if (name === "group.update" && Object.hasOwn(raw, "passcode")) {
      throw opError(index, "passcode cannot be set in a batch; use PATCH /v1/groups/:id");
    }
    const schema: ZodTypeAny = OP_SCHEMAS[name as GroupBatchOpName];
    const op = schema.safeParse(raw);
    if (!op.success) throw opError(index, formatIssues(op.error) || "invalid op");
    return op.data as BatchOp;
  });
}
