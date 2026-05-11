import { describe, expect, it } from "vitest";
import {
  type SlackBlock,
  type SlackContextBlock,
  type SlackHeaderBlock,
  type SlackSectionBlock,
  type SlackWebhookPayload,
  formatJunjoEventForSlack,
} from "./slackFormatter.js";

const baseFields = {
  id: "evt_1234567890abcdef12345678",
  gameId: "game_1",
  groupId: "grp_1",
  occurredAt: "2026-04-28T12:00:00.000Z",
};

function findField(section: SlackSectionBlock | undefined, label: string): string | undefined {
  if (!section?.fields) return undefined;
  const prefix = `*${label}*\n`;
  for (const f of section.fields) {
    if (f.text.startsWith(prefix)) return f.text.slice(prefix.length);
  }
  return undefined;
}

function blocksByType<T extends SlackBlock>(out: SlackWebhookPayload, type: T["type"]): T[] {
  return out.blocks.filter((b): b is T => b.type === type);
}

describe("formatJunjoEventForSlack", () => {
  it("renders header + section + fields + context for member.joined with text fallback", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "member.joined",
      userId: "user_a",
      member: {
        id: "mem_1",
        groupId: "grp_1",
        userId: "user_a",
        status: "active",
        roles: ["role_x", "role_y"],
        metadata: {},
        notesPublic: null,
        notesPrivate: null,
        joinedAt: "2026-04-28T12:00:00.000Z",
      },
    });

    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers).toHaveLength(1);
    expect(headers[0]?.text.text).toBe("Member joined");
    expect(headers[0]?.text.type).toBe("plain_text");

    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections.length).toBeGreaterThanOrEqual(2);
    expect(sections[0]?.text?.text).toContain("user_a joined");
    expect(sections[0]?.text?.text).toContain("`grp_1`");

    expect(findField(sections[1], "User")).toBe("user_a");
    expect(findField(sections[1], "Group")).toBe("grp_1");
    expect(findField(sections[1], "Status")).toBe("active");
    expect(findField(sections[1], "Roles")).toBe("2");

    const contexts = blocksByType<SlackContextBlock>(out, "context");
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.elements[0]?.text).toContain("evt_1234567890abcdef12345678");
    expect(contexts[0]?.elements[0]?.text).toContain("2026-04-28T12:00:00.000Z");

    expect(out.text).toContain("Member joined");
    expect(out.text).toContain("user_a joined");
  });

  it("renders member.left (left) without a Kicked by field", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "member.left",
      userId: "user_a",
      reason: "left",
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Member left");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Reason")).toBe("left");
    expect(findField(sections[1], "Kicked by")).toBeUndefined();
  });

  it("includes Kicked by field for member.left when kickedBy is present", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "member.left",
      userId: "user_a",
      reason: "kicked",
      kickedBy: "user_admin",
    });
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Kicked by")).toBe("user_admin");
    expect(findField(sections[1], "Reason")).toBe("kicked");
  });

  it("renders member.invited (direct) with target user fields", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "member.invited",
      invitation: {
        id: "inv_1",
        groupId: "grp_1",
        code: "abc123def456",
        targetUserId: "user_b",
        roleId: "role_z",
        createdBy: null,
        createdAt: "2026-04-28T12:00:00.000Z",
        expiresAt: null,
        usedAt: null,
        usedBy: null,
      },
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Member invited");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections[0]?.text?.text).toContain("user_b was invited");
    expect(findField(sections[1], "Code")).toBe("abc123def456");
    expect(findField(sections[1], "Target user")).toBe("user_b");
    expect(findField(sections[1], "Role")).toBe("role_z");
  });

  it("renders member.invited (open code) without target/role fields", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "member.invited",
      invitation: {
        id: "inv_1",
        groupId: "grp_1",
        code: "open123",
        targetUserId: null,
        roleId: null,
        createdBy: null,
        createdAt: "2026-04-28T12:00:00.000Z",
        expiresAt: null,
        usedAt: null,
        usedBy: null,
      },
    });
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections[0]?.text?.text).toContain("Open code created");
    expect(findField(sections[1], "Code")).toBe("open123");
    expect(findField(sections[1], "Target user")).toBeUndefined();
    expect(findField(sections[1], "Role")).toBeUndefined();
  });

  it("renders role.created with Name + Priority fields", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "role.created",
      role: {
        id: "role_1",
        groupId: "grp_1",
        name: "Officer",
        priority: 50,
        color: null,
        isDefault: false,
        permissions: [],
        createdAt: "2026-04-28T12:00:00.000Z",
      },
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Role created");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Name")).toBe("Officer");
    expect(findField(sections[1], "Priority")).toBe("50");
    expect(findField(sections[1], "Role")).toBe("role_1");
  });

  it("renders role.changed with comma-joined Added/Removed lists", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "role.changed",
      userId: "user_a",
      added: ["role_x", "role_y"],
      removed: ["role_old"],
      actorUserId: null,
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Role membership changed");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Added")).toBe("role_x, role_y");
    expect(findField(sections[1], "Removed")).toBe("role_old");
  });

  it("renders role.changed with (none) placeholders when added or removed is empty", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "role.changed",
      userId: "user_a",
      added: [],
      removed: ["role_old"],
      actorUserId: null,
    });
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Added")).toBe("(none)");
    expect(findField(sections[1], "Removed")).toBe("role_old");
  });

  it("renders role.deleted", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "role.deleted",
      roleId: "role_gone",
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Role deleted");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Role")).toBe("role_gone");
  });

  it("renders permission.granted", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "permission.granted",
      roleId: "role_1",
      permission: "guild.invite_member",
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Permission granted");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Role")).toBe("role_1");
    expect(findField(sections[1], "Permission")).toBe("guild.invite_member");
  });

  it("renders permission.revoked", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "permission.revoked",
      roleId: "role_1",
      permission: "guild.kick_member",
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Permission revoked");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Permission")).toBe("guild.kick_member");
  });

  it("renders group.updated with Name + Visibility fields", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "group.updated",
      group: {
        id: "grp_1",
        gameId: "game_1",
        kind: "guild",
        name: "Crimson Wolves",
        visibility: "invite-only",
        metadata: {},
        defaultRoleId: null,
        parentGroupId: null,
        memberCount: 3,
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-28T12:00:00.000Z",
        softDeletedAt: null,
      },
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Group updated");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections[0]?.text?.text).toContain("Crimson Wolves");
    expect(findField(sections[1], "Name")).toBe("Crimson Wolves");
    expect(findField(sections[1], "Visibility")).toBe("invite-only");
  });

  it("renders group.deleted", () => {
    const out = formatJunjoEventForSlack({ ...baseFields, type: "group.deleted" });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Group deleted");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections[0]?.text?.text).toContain("`grp_1`");
    expect(findField(sections[1], "Group")).toBe("grp_1");
  });

  it("renders group.relationship.changed (set) with type and direction", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "group.relationship.changed",
      otherGroupId: "grp_2",
      relationship: {
        groupAId: "grp_1",
        groupBId: "grp_2",
        type: "ally",
        since: "2026-04-28T12:00:00.000Z",
        setBy: null,
      },
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Group relationship changed");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections[0]?.text?.text).toContain("ally");
    expect(findField(sections[1], "From")).toBe("grp_1");
    expect(findField(sections[1], "To")).toBe("grp_2");
    expect(findField(sections[1], "Type")).toBe("ally");
  });

  it("renders group.relationship.changed (cleared) with (cleared) Type", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "group.relationship.changed",
      otherGroupId: "grp_2",
      relationship: null,
    });
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(sections[0]?.text?.text).toContain("Relationship cleared");
    expect(findField(sections[1], "Type")).toBe("(cleared)");
  });

  it("falls through to a generic message for an unknown event type", () => {
    const out = formatJunjoEventForSlack({ ...baseFields, type: "future.event" });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Junjo event: future.event");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(findField(sections[1], "Type")).toBe("future.event");
    expect(findField(sections[1], "Event ID")).toBe("evt_1234567890abcdef12345678");
  });

  it("survives a payload missing the type field with a generic message", () => {
    const out = formatJunjoEventForSlack({ ...baseFields });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    expect(headers[0]?.text.text).toBe("Junjo event: unknown");
  });

  it("truncates field values longer than Slack's 2000-char field cap", () => {
    const longRoleList = Array.from({ length: 400 }, (_, i) => `role_${i}`);
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "role.changed",
      userId: "user_a",
      added: longRoleList,
      removed: [],
      actorUserId: null,
    });
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    const added = sections[1]?.fields?.find((f) => f.text.startsWith("*Added*\n"));
    expect((added?.text.length ?? 0) <= 2000).toBe(true);
    expect(added?.text.endsWith("…")).toBe(true);
  });

  it("uses mrkdwn for the section text and plain_text for the header", () => {
    const out = formatJunjoEventForSlack({
      ...baseFields,
      type: "member.joined",
      userId: "user_a",
      member: { id: "mem_1", status: "active", roles: [] },
    });
    const headers = blocksByType<SlackHeaderBlock>(out, "header");
    const sections = blocksByType<SlackSectionBlock>(out, "section");
    expect(headers[0]?.text.type).toBe("plain_text");
    expect(sections[0]?.text?.type).toBe("mrkdwn");
    expect(sections[1]?.fields?.[0]?.type).toBe("mrkdwn");
  });
});
