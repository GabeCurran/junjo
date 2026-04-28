// Translates a stored `JunjoEvent` payload into the Discord webhook
// payload shape (https://discord.com/developers/docs/resources/webhook#execute-webhook).
// The function reads from the wire-shaped payload that lives on
// `WebhookDelivery.payload` after the JSON round-trip in
// `serializeEventForStorage` (Date fields are ISO 8601 strings, branded
// ids are plain strings). That matches what Discord wants on the wire,
// so the formatter never needs a `Date` rehydration step.

const COLOR_GREEN = 0x4ade80;
const COLOR_RED = 0xef4444;
const COLOR_BLUE = 0x3b82f6;
const COLOR_GREY = 0x6b7280;

// Discord's documented field-value cap.
const FIELD_VALUE_MAX_LENGTH = 1024;
// Discord's documented embed-description cap.
const DESCRIPTION_MAX_LENGTH = 4096;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedFooter {
  text: string;
}

export interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  timestamp?: string;
  fields?: DiscordEmbedField[];
  footer?: DiscordEmbedFooter;
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
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

function field(name: string, value: string, inline = true): DiscordEmbedField {
  return { name, value: truncate(value, FIELD_VALUE_MAX_LENGTH), inline };
}

function footerFor(eventId: string): DiscordEmbedFooter {
  return { text: `Junjo - ${eventId}` };
}

// Narrow the wire event by `type` and produce the Discord payload. Each
// branch reads only the fields it needs from the loose payload shape, so
// the formatter is tolerant of unknown event types: anything not in the
// switch falls through to a generic "unknown event" embed (the worker
// will still POST it; the dev sees the raw type string in Discord). This
// keeps the formatter forward-compatible against new event types added
// to `JunjoEventType` after a rolling deploy.
export function formatJunjoEventForDiscord(
  payload: Record<string, unknown>,
): DiscordWebhookPayload {
  const base = payload as unknown as WireEventBase;
  const eventId = typeof base.id === "string" ? base.id : "unknown";
  const occurredAt = typeof base.occurredAt === "string" ? base.occurredAt : undefined;
  const groupId = typeof base.groupId === "string" ? base.groupId : "";
  const type = typeof base.type === "string" ? base.type : "unknown";

  const embed: DiscordEmbed = {
    title: titleFor(type),
    color: colorFor(type),
    footer: footerFor(eventId),
  };
  if (occurredAt !== undefined) embed.timestamp = occurredAt;

  switch (type) {
    case "member.joined": {
      const userId = readString(payload, "userId");
      const member = readObject(payload, "member");
      const status = readString(member, "status");
      const roles = Array.isArray(member?.roles) ? member.roles : [];
      embed.description = truncate(
        `${userId ?? "(unknown user)"} joined ${groupId}`,
        DESCRIPTION_MAX_LENGTH,
      );
      embed.fields = [
        field("User", userId ?? "(unknown)"),
        field("Group", groupId || "(unknown)"),
        field("Status", status ?? "active"),
        field("Roles", String(roles.length), true),
      ];
      return { embeds: [embed] };
    }
    case "member.left": {
      const userId = readString(payload, "userId");
      const reason = readString(payload, "reason") ?? "left";
      const kickedBy = readString(payload, "kickedBy");
      embed.description = truncate(
        `${userId ?? "(unknown user)"} ${reason} ${groupId}`,
        DESCRIPTION_MAX_LENGTH,
      );
      const fields: DiscordEmbedField[] = [
        field("User", userId ?? "(unknown)"),
        field("Group", groupId || "(unknown)"),
        field("Reason", reason),
      ];
      if (kickedBy !== undefined) fields.push(field("Kicked by", kickedBy));
      embed.fields = fields;
      return { embeds: [embed] };
    }
    case "member.invited": {
      const invitation = readObject(payload, "invitation");
      const code = readString(invitation, "code");
      const targetUserId = readString(invitation, "targetUserId");
      const roleId = readString(invitation, "roleId");
      embed.description = truncate(
        targetUserId
          ? `${targetUserId} was invited to ${groupId}`
          : `Open code created for ${groupId}`,
        DESCRIPTION_MAX_LENGTH,
      );
      const fields: DiscordEmbedField[] = [field("Group", groupId || "(unknown)")];
      if (code !== undefined) fields.push(field("Code", code));
      if (targetUserId !== undefined) fields.push(field("Target user", targetUserId));
      if (roleId !== undefined) fields.push(field("Role", roleId));
      embed.fields = fields;
      return { embeds: [embed] };
    }
    case "role.created": {
      const role = readObject(payload, "role");
      const roleId = readString(role, "id");
      const name = readString(role, "name");
      const priority = readNumber(role, "priority");
      embed.description = truncate(
        `Role "${name ?? "(unnamed)"}" created in ${groupId}`,
        DESCRIPTION_MAX_LENGTH,
      );
      embed.fields = [
        field("Group", groupId || "(unknown)"),
        field("Role", roleId ?? "(unknown)"),
        field("Name", name ?? "(unnamed)"),
        field("Priority", priority === undefined ? "(unknown)" : String(priority)),
      ];
      return { embeds: [embed] };
    }
    case "role.changed": {
      const userId = readString(payload, "userId");
      const added = Array.isArray(payload.added) ? payload.added : [];
      const removed = Array.isArray(payload.removed) ? payload.removed : [];
      embed.description = truncate(
        `Role membership changed for ${userId ?? "(unknown user)"} in ${groupId}`,
        DESCRIPTION_MAX_LENGTH,
      );
      const fields: DiscordEmbedField[] = [
        field("User", userId ?? "(unknown)"),
        field("Group", groupId || "(unknown)"),
        field("Added", added.length === 0 ? "(none)" : added.map(String).join(", "), false),
        field("Removed", removed.length === 0 ? "(none)" : removed.map(String).join(", "), false),
      ];
      embed.fields = fields;
      return { embeds: [embed] };
    }
    case "role.deleted": {
      const roleId = readString(payload, "roleId");
      embed.description = truncate(
        `Role ${roleId ?? "(unknown)"} deleted from ${groupId}`,
        DESCRIPTION_MAX_LENGTH,
      );
      embed.fields = [field("Group", groupId || "(unknown)"), field("Role", roleId ?? "(unknown)")];
      return { embeds: [embed] };
    }
    case "permission.granted": {
      const roleId = readString(payload, "roleId");
      const permission = readString(payload, "permission");
      embed.description = truncate(
        `Granted "${permission ?? "(unknown)"}" to ${roleId ?? "(unknown role)"}`,
        DESCRIPTION_MAX_LENGTH,
      );
      embed.fields = [
        field("Role", roleId ?? "(unknown)"),
        field("Permission", permission ?? "(unknown)"),
      ];
      return { embeds: [embed] };
    }
    case "permission.revoked": {
      const roleId = readString(payload, "roleId");
      const permission = readString(payload, "permission");
      embed.description = truncate(
        `Revoked "${permission ?? "(unknown)"}" from ${roleId ?? "(unknown role)"}`,
        DESCRIPTION_MAX_LENGTH,
      );
      embed.fields = [
        field("Role", roleId ?? "(unknown)"),
        field("Permission", permission ?? "(unknown)"),
      ];
      return { embeds: [embed] };
    }
    case "group.updated": {
      const group = readObject(payload, "group");
      const name = readString(group, "name");
      const visibility = readString(group, "visibility");
      embed.description = truncate(`Group "${name ?? groupId}" updated`, DESCRIPTION_MAX_LENGTH);
      embed.fields = [
        field("Group", groupId || "(unknown)"),
        field("Name", name ?? "(unknown)"),
        field("Visibility", visibility ?? "(unknown)"),
      ];
      return { embeds: [embed] };
    }
    case "group.deleted": {
      embed.description = truncate(`Group ${groupId} deleted`, DESCRIPTION_MAX_LENGTH);
      embed.fields = [field("Group", groupId || "(unknown)")];
      return { embeds: [embed] };
    }
    case "group.relationship.changed": {
      const otherGroupId = readString(payload, "otherGroupId");
      const relationship = readObject(payload, "relationship");
      const relationshipType = readString(relationship, "type");
      const cleared = relationship === undefined;
      embed.description = truncate(
        cleared
          ? `Relationship cleared: ${groupId} -> ${otherGroupId ?? "(unknown)"}`
          : `Relationship "${relationshipType ?? "(unknown)"}" set: ${groupId} -> ${otherGroupId ?? "(unknown)"}`,
        DESCRIPTION_MAX_LENGTH,
      );
      const fields: DiscordEmbedField[] = [
        field("From", groupId || "(unknown)"),
        field("To", otherGroupId ?? "(unknown)"),
        field("Type", cleared ? "(cleared)" : (relationshipType ?? "(unknown)")),
      ];
      embed.fields = fields;
      return { embeds: [embed] };
    }
    default: {
      embed.description = truncate(`Event type "${type}" delivered`, DESCRIPTION_MAX_LENGTH);
      embed.fields = [field("Type", type), field("Event ID", eventId, false)];
      if (groupId) embed.fields.push(field("Group", groupId));
      return { embeds: [embed] };
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

function colorFor(type: string): number {
  switch (type) {
    case "member.joined":
    case "permission.granted":
    case "role.created":
      return COLOR_GREEN;
    case "member.left":
    case "permission.revoked":
    case "role.deleted":
    case "group.deleted":
      return COLOR_RED;
    case "member.invited":
    case "role.changed":
    case "group.updated":
    case "group.relationship.changed":
      return COLOR_BLUE;
    default:
      return COLOR_GREY;
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
