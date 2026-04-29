import { describe, expect, it } from "vitest";
import { formatJunjoEventForDiscord } from "./discordFormatter.js";

const baseFields = {
  id: "evt_1234567890abcdef12345678",
  gameId: "game_1",
  groupId: "grp_1",
  occurredAt: "2026-04-28T12:00:00.000Z",
};

describe("formatJunjoEventForDiscord", () => {
  it("renders one embed with title, color, timestamp, and footer for member.joined", () => {
    const out = formatJunjoEventForDiscord({
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
    expect(out.embeds).toHaveLength(1);
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Member joined");
    expect(embed?.color).toBe(0x4ade80);
    expect(embed?.timestamp).toBe("2026-04-28T12:00:00.000Z");
    expect(embed?.footer?.text).toContain("evt_1234567890abcdef12345678");
    expect(embed?.description).toBe("user_a joined grp_1");
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "User")?.value).toBe("user_a");
    expect(fields.find((f) => f.name === "Status")?.value).toBe("active");
    expect(fields.find((f) => f.name === "Roles")?.value).toBe("2");
  });

  it("renders red color and reason field for member.left (left)", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "member.left",
      userId: "user_a",
      reason: "left",
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Member left");
    expect(embed?.color).toBe(0xef4444);
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Reason")?.value).toBe("left");
    expect(fields.find((f) => f.name === "Kicked by")).toBeUndefined();
  });

  it("includes Kicked by field for member.left when kickedBy is present", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "member.left",
      userId: "user_a",
      reason: "kicked",
      kickedBy: "user_admin",
    });
    const fields = out.embeds[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Kicked by")?.value).toBe("user_admin");
    expect(fields.find((f) => f.name === "Reason")?.value).toBe("kicked");
  });

  it("renders member.invited (direct) with target user in description and fields", () => {
    const out = formatJunjoEventForDiscord({
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
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Member invited");
    expect(embed?.color).toBe(0x3b82f6);
    expect(embed?.description).toBe("user_b was invited to grp_1");
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Code")?.value).toBe("abc123def456");
    expect(fields.find((f) => f.name === "Target user")?.value).toBe("user_b");
    expect(fields.find((f) => f.name === "Role")?.value).toBe("role_z");
  });

  it("renders member.invited (open code) without target/role", () => {
    const out = formatJunjoEventForDiscord({
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
    const embed = out.embeds[0];
    expect(embed?.description).toBe("Open code created for grp_1");
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Code")?.value).toBe("open123");
    expect(fields.find((f) => f.name === "Target user")).toBeUndefined();
    expect(fields.find((f) => f.name === "Role")).toBeUndefined();
  });

  it("renders role.created with green color and role fields", () => {
    const out = formatJunjoEventForDiscord({
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
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Role created");
    expect(embed?.color).toBe(0x4ade80);
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Name")?.value).toBe("Officer");
    expect(fields.find((f) => f.name === "Priority")?.value).toBe("50");
    expect(fields.find((f) => f.name === "Role")?.value).toBe("role_1");
  });

  it("renders role.changed with comma-joined added/removed lists", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "role.changed",
      userId: "user_a",
      added: ["role_x", "role_y"],
      removed: ["role_old"],
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Role membership changed");
    expect(embed?.color).toBe(0x3b82f6);
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Added")?.value).toBe("role_x, role_y");
    expect(fields.find((f) => f.name === "Removed")?.value).toBe("role_old");
  });

  it("renders role.changed with (none) placeholders when added or removed is empty", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "role.changed",
      userId: "user_a",
      added: [],
      removed: ["role_old"],
    });
    const fields = out.embeds[0]?.fields ?? [];
    expect(fields.find((f) => f.name === "Added")?.value).toBe("(none)");
    expect(fields.find((f) => f.name === "Removed")?.value).toBe("role_old");
  });

  it("renders role.deleted with red color and Role field", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "role.deleted",
      roleId: "role_gone",
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Role deleted");
    expect(embed?.color).toBe(0xef4444);
    expect(embed?.fields?.find((f) => f.name === "Role")?.value).toBe("role_gone");
  });

  it("renders permission.granted with green color and permission fields", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "permission.granted",
      roleId: "role_1",
      permission: "guild.invite_member",
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Permission granted");
    expect(embed?.color).toBe(0x4ade80);
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Role")?.value).toBe("role_1");
    expect(fields.find((f) => f.name === "Permission")?.value).toBe("guild.invite_member");
  });

  it("renders permission.revoked with red color and permission fields", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "permission.revoked",
      roleId: "role_1",
      permission: "guild.kick_member",
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Permission revoked");
    expect(embed?.color).toBe(0xef4444);
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Permission")?.value).toBe("guild.kick_member");
  });

  it("renders group.updated with name and visibility fields", () => {
    const out = formatJunjoEventForDiscord({
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
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Group updated");
    expect(embed?.color).toBe(0x3b82f6);
    expect(embed?.description).toBe('Group "Crimson Wolves" updated');
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "Name")?.value).toBe("Crimson Wolves");
    expect(fields.find((f) => f.name === "Visibility")?.value).toBe("invite-only");
  });

  it("renders group.deleted with red color and Group field", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "group.deleted",
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Group deleted");
    expect(embed?.color).toBe(0xef4444);
    expect(embed?.description).toBe("Group grp_1 deleted");
    expect(embed?.fields?.find((f) => f.name === "Group")?.value).toBe("grp_1");
  });

  it("renders group.relationship.changed (set) with type and direction", () => {
    const out = formatJunjoEventForDiscord({
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
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Group relationship changed");
    expect(embed?.description).toBe('Relationship "ally" set: grp_1 -> grp_2');
    const fields = embed?.fields ?? [];
    expect(fields.find((f) => f.name === "From")?.value).toBe("grp_1");
    expect(fields.find((f) => f.name === "To")?.value).toBe("grp_2");
    expect(fields.find((f) => f.name === "Type")?.value).toBe("ally");
  });

  it("renders group.relationship.changed (cleared) with (cleared) Type", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "group.relationship.changed",
      otherGroupId: "grp_2",
      relationship: null,
    });
    const embed = out.embeds[0];
    expect(embed?.description).toBe("Relationship cleared: grp_1 -> grp_2");
    expect(embed?.fields?.find((f) => f.name === "Type")?.value).toBe("(cleared)");
  });

  it("falls through to a generic embed for an unknown event type", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "future.event",
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Junjo event: future.event");
    expect(embed?.color).toBe(0x6b7280);
    expect(embed?.fields?.find((f) => f.name === "Type")?.value).toBe("future.event");
    expect(embed?.fields?.find((f) => f.name === "Event ID")?.value).toBe(
      "evt_1234567890abcdef12345678",
    );
  });

  it("truncates field values longer than Discord's 1024-char limit", () => {
    const longRoleList = Array.from({ length: 200 }, (_, i) => `role_${i}`);
    const out = formatJunjoEventForDiscord({
      ...baseFields,
      type: "role.changed",
      userId: "user_a",
      added: longRoleList,
      removed: [],
    });
    const addedField = out.embeds[0]?.fields?.find((f) => f.name === "Added");
    expect((addedField?.value.length ?? 0) <= 1024).toBe(true);
    expect(addedField?.value.endsWith("…")).toBe(true);
  });

  it("survives a payload missing the type field with a generic embed", () => {
    const out = formatJunjoEventForDiscord({
      ...baseFields,
    });
    const embed = out.embeds[0];
    expect(embed?.title).toBe("Junjo event: unknown");
    expect(embed?.color).toBe(0x6b7280);
  });
});
