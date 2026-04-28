// Translates a stored `JunjoEvent` payload into a Slack incoming-webhook
// payload (https://api.slack.com/messaging/webhooks). The function reads
// from the wire-shaped payload that lives on `WebhookDelivery.payload`
// after the JSON round-trip in `serializeEventForStorage` (Date fields
// are ISO 8601 strings, branded ids are plain strings). That matches
// what Slack wants on the wire, so the formatter never needs a `Date`
// rehydration step.
//
// The output uses Block Kit (`blocks` array) plus a top-level `text`
// fallback. The `text` field is what shows up in mobile push
// notifications, in the channel sidebar preview, and in old Slack
// clients that don't render blocks; without it Slack logs a warning.

// Slack's documented limits. Block Kit caps each `mrkdwn` text block at
// 3000 chars; a section's individual `fields` array is capped at 10
// entries with each field's text capped at 2000. The `text` fallback at
// the top level is capped at 40_000 chars (we never get close).
const TEXT_MAX_LENGTH = 3000;
const FIELD_TEXT_MAX_LENGTH = 2000;
const FIELDS_PER_SECTION_MAX = 10;

export interface SlackTextBlock {
  type: "mrkdwn" | "plain_text";
  text: string;
  emoji?: boolean;
}

export interface SlackHeaderBlock {
  type: "header";
  text: SlackTextBlock;
}

export interface SlackSectionBlock {
  type: "section";
  text?: SlackTextBlock;
  fields?: SlackTextBlock[];
}

export interface SlackContextBlock {
  type: "context";
  elements: SlackTextBlock[];
}

export interface SlackDividerBlock {
  type: "divider";
}

export type SlackBlock =
  | SlackHeaderBlock
  | SlackSectionBlock
  | SlackContextBlock
  | SlackDividerBlock;

export interface SlackWebhookPayload {
  text: string;
  blocks: SlackBlock[];
}

interface WireEventBase {
  id: string;
  type: string;
  gameId: string;
  groupId: string;
  occurredAt: string;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function mrkdwn(text: string): SlackTextBlock {
  return { type: "mrkdwn", text: truncate(text, TEXT_MAX_LENGTH) };
}

function header(text: string): SlackHeaderBlock {
  // Slack header blocks must use plain_text and have a 150-char cap.
  return {
    type: "header",
    text: { type: "plain_text", text: truncate(text, 150), emoji: true },
  };
}

function fieldPair(label: string, value: string): SlackTextBlock {
  return {
    type: "mrkdwn",
    text: truncate(`*${label}*\n${value}`, FIELD_TEXT_MAX_LENGTH),
  };
}

function contextLine(eventId: string, occurredAt: string | undefined): SlackContextBlock {
  const parts = [`Junjo · ${eventId}`];
  if (occurredAt !== undefined) parts.push(occurredAt);
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: parts.join("  ·  ") }],
  };
}

function fieldsSection(fields: SlackTextBlock[]): SlackSectionBlock {
  // Slack rejects > 10 fields per section. Truncating to the cap keeps
  // the request shape valid; the docs page calls out the limit.
  return {
    type: "section",
    fields: fields.slice(0, FIELDS_PER_SECTION_MAX),
  };
}

// Narrow the wire event by `type` and produce the Slack payload. Each
// branch reads only the fields it needs from the loose payload shape, so
// the formatter is tolerant of unknown event types: anything not in the
// switch falls through to a generic "unknown event" message (the worker
// will still POST it; the dev sees the raw type string in Slack). This
// keeps the formatter forward-compatible against new event types added
// to `JunjoEventType` after a rolling deploy.
export function formatJunjoEventForSlack(payload: Record<string, unknown>): SlackWebhookPayload {
  const base = payload as unknown as WireEventBase;
  const eventId = typeof base.id === "string" ? base.id : "unknown";
  const occurredAt = typeof base.occurredAt === "string" ? base.occurredAt : undefined;
  const groupId = typeof base.groupId === "string" ? base.groupId : "";
  const type = typeof base.type === "string" ? base.type : "unknown";

  const title = titleFor(type);

  switch (type) {
    case "member.joined": {
      const userId = readString(payload, "userId") ?? "(unknown user)";
      const member = readObject(payload, "member");
      const status = readString(member, "status") ?? "active";
      const roles = Array.isArray(member?.roles) ? member.roles : [];
      const summary = `${userId} joined \`${groupId || "(unknown)"}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([
            fieldPair("User", userId),
            fieldPair("Group", groupId || "(unknown)"),
            fieldPair("Status", status),
            fieldPair("Roles", String(roles.length)),
          ]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "member.left": {
      const userId = readString(payload, "userId") ?? "(unknown user)";
      const reason = readString(payload, "reason") ?? "left";
      const kickedBy = readString(payload, "kickedBy");
      const summary = `${userId} ${reason} \`${groupId || "(unknown)"}\``;
      const fields: SlackTextBlock[] = [
        fieldPair("User", userId),
        fieldPair("Group", groupId || "(unknown)"),
        fieldPair("Reason", reason),
      ];
      if (kickedBy !== undefined) fields.push(fieldPair("Kicked by", kickedBy));
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection(fields),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "member.invited": {
      const invitation = readObject(payload, "invitation");
      const code = readString(invitation, "code");
      const targetUserId = readString(invitation, "targetUserId");
      const roleId = readString(invitation, "roleId");
      const summary = targetUserId
        ? `${targetUserId} was invited to \`${groupId || "(unknown)"}\``
        : `Open code created for \`${groupId || "(unknown)"}\``;
      const fields: SlackTextBlock[] = [fieldPair("Group", groupId || "(unknown)")];
      if (code !== undefined) fields.push(fieldPair("Code", code));
      if (targetUserId !== undefined) fields.push(fieldPair("Target user", targetUserId));
      if (roleId !== undefined) fields.push(fieldPair("Role", roleId));
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection(fields),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "role.created": {
      const role = readObject(payload, "role");
      const roleId = readString(role, "id") ?? "(unknown)";
      const name = readString(role, "name") ?? "(unnamed)";
      const priority = readNumber(role, "priority");
      const summary = `Role *${name}* created in \`${groupId || "(unknown)"}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([
            fieldPair("Group", groupId || "(unknown)"),
            fieldPair("Role", roleId),
            fieldPair("Name", name),
            fieldPair("Priority", priority === undefined ? "(unknown)" : String(priority)),
          ]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "role.changed": {
      const userId = readString(payload, "userId") ?? "(unknown user)";
      const added = Array.isArray(payload.added) ? payload.added : [];
      const removed = Array.isArray(payload.removed) ? payload.removed : [];
      const summary = `Role membership changed for ${userId} in \`${groupId || "(unknown)"}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([
            fieldPair("User", userId),
            fieldPair("Group", groupId || "(unknown)"),
            fieldPair("Added", added.length === 0 ? "(none)" : added.map(String).join(", ")),
            fieldPair("Removed", removed.length === 0 ? "(none)" : removed.map(String).join(", ")),
          ]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "role.deleted": {
      const roleId = readString(payload, "roleId") ?? "(unknown)";
      const summary = `Role \`${roleId}\` deleted from \`${groupId || "(unknown)"}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([fieldPair("Group", groupId || "(unknown)"), fieldPair("Role", roleId)]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "permission.granted": {
      const roleId = readString(payload, "roleId") ?? "(unknown role)";
      const permission = readString(payload, "permission") ?? "(unknown)";
      const summary = `Granted \`${permission}\` to \`${roleId}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([fieldPair("Role", roleId), fieldPair("Permission", permission)]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "permission.revoked": {
      const roleId = readString(payload, "roleId") ?? "(unknown role)";
      const permission = readString(payload, "permission") ?? "(unknown)";
      const summary = `Revoked \`${permission}\` from \`${roleId}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([fieldPair("Role", roleId), fieldPair("Permission", permission)]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "group.updated": {
      const group = readObject(payload, "group");
      const name = readString(group, "name") ?? groupId;
      const visibility = readString(group, "visibility") ?? "(unknown)";
      const summary = `Group *${name}* updated`;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([
            fieldPair("Group", groupId || "(unknown)"),
            fieldPair("Name", name),
            fieldPair("Visibility", visibility),
          ]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "group.deleted": {
      const summary = `Group \`${groupId || "(unknown)"}\` deleted`;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([fieldPair("Group", groupId || "(unknown)")]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    case "group.relationship.changed": {
      const otherGroupId = readString(payload, "otherGroupId") ?? "(unknown)";
      const relationship = readObject(payload, "relationship");
      const relationshipType = readString(relationship, "type") ?? "(unknown)";
      const cleared = relationship === undefined;
      const summary = cleared
        ? `Relationship cleared: \`${groupId || "(unknown)"}\` -> \`${otherGroupId}\``
        : `Relationship *${relationshipType}* set: \`${groupId || "(unknown)"}\` -> \`${otherGroupId}\``;
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection([
            fieldPair("From", groupId || "(unknown)"),
            fieldPair("To", otherGroupId),
            fieldPair("Type", cleared ? "(cleared)" : relationshipType),
          ]),
          contextLine(eventId, occurredAt),
        ],
      };
    }
    default: {
      const summary = `Event type \`${type}\` delivered`;
      const fields: SlackTextBlock[] = [fieldPair("Type", type), fieldPair("Event ID", eventId)];
      if (groupId) fields.push(fieldPair("Group", groupId));
      return {
        text: `${title}: ${summary}`,
        blocks: [
          header(title),
          { type: "section", text: mrkdwn(summary) },
          fieldsSection(fields),
          contextLine(eventId, occurredAt),
        ],
      };
    }
  }
}

function titleFor(type: string): string {
  switch (type) {
    case "member.joined":
      return "Member joined";
    case "member.left":
      return "Member left";
    case "member.invited":
      return "Member invited";
    case "role.created":
      return "Role created";
    case "role.changed":
      return "Role membership changed";
    case "role.deleted":
      return "Role deleted";
    case "permission.granted":
      return "Permission granted";
    case "permission.revoked":
      return "Permission revoked";
    case "group.updated":
      return "Group updated";
    case "group.deleted":
      return "Group deleted";
    case "group.relationship.changed":
      return "Group relationship changed";
    default:
      return `Junjo event: ${type}`;
  }
}

function readString(obj: unknown, key: string): string | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function readNumber(obj: unknown, key: string): number | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

function readObject(obj: unknown, key: string): Record<string, unknown> | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const v = (obj as Record<string, unknown>)[key];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return undefined;
}
