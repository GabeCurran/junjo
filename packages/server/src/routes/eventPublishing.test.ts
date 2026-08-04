import type {
  GroupDeletedEvent,
  GroupId,
  GroupRelationshipChangedEvent,
  GroupUpdatedEvent,
  JunjoEvent,
  MemberInvitedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  PermissionGrantedEvent,
  PermissionRevokedEvent,
  RoleChangedEvent,
  RoleCreatedEvent,
  RoleDeletedEvent,
} from "@junjo-io/shared";
import { type Prisma, PrismaClient } from "@prisma/client";
import type { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { EventHub } from "../eventHub";
import { createApiKey, createGame } from "../seed";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

// Wires a fresh `EventHub` into the app and captures every event published
// through it on a per-group listener. Keeps assertions terse: the test
// bodies just inspect `recorded`.
function recorder(hub: EventHub, groupId: string): JunjoEvent[] {
  const events: JunjoEvent[] = [];
  hub.subscribe(groupId as GroupId, (e) => events.push(e));
  return events;
}

describe.skipIf(!TEST_DATABASE_URL)("event publishing from mutation routes", () => {
  let prisma: PrismaClient;
  let app: Hono;
  let hub: EventHub;
  let authHeader: string;
  let gameId: string;

  beforeAll(() => {
    prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "AuditEntry", "MemberPermissionOverride", "RolePermission", "MemberRole", "PermissionDef", "Role", "Invitation", "GroupRelationship", "GroupMember", "JunjoUser", "ExternalIdentity", "Group", "ApiKey", "Game" RESTART IDENTITY CASCADE',
    );
    const game = await createGame("Test Game", prisma);
    gameId = game.id;
    const seeded = await createApiKey(game.id, prisma);
    authHeader = `Bearer ${seeded.raw.full}`;
    hub = new EventHub();
    app = createApp({ prisma, events: { hub, heartbeatIntervalMs: 30_000 } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeGroup(name = "Crimson Wolves") {
    return prisma.group.create({
      data: {
        gameId,
        kind: "guild",
        name,
        visibility: "invite-only",
        metadata: {} as Prisma.InputJsonValue,
      },
    });
  }

  async function makeMember(groupId: string, externalUserId = "user_alice") {
    const junjoUser = await prisma.junjoUser.create({ data: {} });
    await prisma.externalIdentity.create({
      data: { gameId, externalUserId, junjoUserId: junjoUser.id },
    });
    const member = await prisma.groupMember.create({
      data: { groupId, junjoUserId: junjoUser.id, status: "active" },
    });
    return { junjoUser, member, externalUserId };
  }

  async function makeRole(groupId: string, name = "Officer", priority = 50) {
    return prisma.role.create({
      data: { groupId, name, priority, color: null, isDefault: false },
    });
  }

  it("PATCH /v1/groups/:id publishes group.updated", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as GroupUpdatedEvent;
    expect(e.type).toBe("group.updated");
    expect(e.gameId).toBe(gameId);
    expect(e.groupId).toBe(group.id);
    expect(e.id).toMatch(/^[0-9a-f]{24}$/);
    expect(e.occurredAt).toBeInstanceOf(Date);
    expect(e.group.id).toBe(group.id);
    expect(e.group.name).toBe("New Name");
    expect(e.group.memberCount).toBe(0);
  });

  it("PATCH /v1/groups/:id with no-op body publishes nothing", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: group.name }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("DELETE /v1/groups/:id publishes group.deleted (soft)", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as GroupDeletedEvent;
    expect(e.type).toBe("group.deleted");
    expect(e.gameId).toBe(gameId);
    expect(e.groupId).toBe(group.id);
  });

  it("DELETE /v1/groups/:id?hard=true publishes group.deleted", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}?hard=true`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(204);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("group.deleted");
  });

  it("POST /v1/groups/:id/restore publishes group.updated", async () => {
    const group = await makeGroup();
    await prisma.group.update({
      where: { id: group.id },
      data: { softDeletedAt: new Date() },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/restore`, {
      method: "POST",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("group.updated");
  });

  it("PUT /v1/groups/:id/parent publishes group.updated", async () => {
    const parent = await makeGroup("Alliance");
    const child = await makeGroup("Sub-clan");
    const events = recorder(hub, child.id);

    const res = await app.request(`/v1/groups/${child.id}/parent`, {
      method: "PUT",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ parentGroupId: parent.id }),
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as GroupUpdatedEvent;
    expect(e.type).toBe("group.updated");
    expect(e.group.parentGroupId).toBe(parent.id);
  });

  it("POST /v1/groups/:id/invitations publishes member.invited", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/invitations`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ targetUserId: "user_target" }),
    });
    expect(res.status).toBe(201);

    expect(events).toHaveLength(1);
    const e = events[0] as MemberInvitedEvent;
    expect(e.type).toBe("member.invited");
    expect(e.invitation.targetUserId).toBe("user_target");
    expect(e.invitation.code).toMatch(/^[0-9a-f]{16}$/);
  });

  it("POST /v1/groups/:id/bulk-invite publishes one member.invited per row", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/bulk-invite`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "text/csv" },
      body: "user_a\nuser_b\nuser_c",
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type === "member.invited")).toBe(true);
    const targets = events.map((e) => (e as MemberInvitedEvent).invitation.targetUserId);
    expect(targets.sort()).toEqual(["user_a", "user_b", "user_c"]);
  });

  it("POST /v1/groups/:id/bulk-invite with empty body publishes nothing", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/bulk-invite`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "text/csv" },
      body: "",
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("POST /v1/invitations/:code/accept publishes member.joined", async () => {
    const group = await makeGroup();
    const invitation = await prisma.invitation.create({
      data: {
        groupId: group.id,
        code: "abcd1234abcd1234",
        roleId: null,
        targetUserId: null,
        createdByUserId: null,
      },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/invitations/${invitation.code}/accept`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ userId: "user_new" }),
    });
    expect(res.status).toBe(201);

    expect(events).toHaveLength(1);
    const e = events[0] as MemberJoinedEvent;
    expect(e.type).toBe("member.joined");
    expect(e.userId).toBe("user_new");
    expect(e.member.userId).toBe("user_new");
    expect(e.member.status).toBe("active");
  });

  it("POST /v1/groups/:id/leave publishes member.left with reason=left", async () => {
    const group = await makeGroup();
    const { externalUserId } = await makeMember(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/leave`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ userId: externalUserId }),
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as MemberLeftEvent;
    expect(e.type).toBe("member.left");
    expect(e.userId).toBe(externalUserId);
    expect(e.reason).toBe("left");
  });

  it("leave on already-left member is a no-op publishing nothing", async () => {
    const group = await makeGroup();
    const { junjoUser, member, externalUserId } = await makeMember(group.id);
    void junjoUser;
    await prisma.groupMember.update({
      where: { id: member.id },
      data: { status: "left", leftAt: new Date() },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/leave`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ userId: externalUserId }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("POST /v1/groups/:id/members/:userId/kick publishes member.left with reason=kicked", async () => {
    const group = await makeGroup();
    const { externalUserId } = await makeMember(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/members/${externalUserId}/kick`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ reason: "afk" }),
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as MemberLeftEvent;
    expect(e.type).toBe("member.left");
    expect(e.userId).toBe(externalUserId);
    expect(e.reason).toBe("kicked");
  });

  it("POST /v1/groups/:id/roles publishes role.created", async () => {
    const group = await makeGroup();
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/roles`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ name: "Officer", priority: 50 }),
    });
    expect(res.status).toBe(201);

    expect(events).toHaveLength(1);
    const e = events[0] as RoleCreatedEvent;
    expect(e.type).toBe("role.created");
    expect(e.role.name).toBe("Officer");
    expect(e.role.priority).toBe(50);
  });

  it("DELETE /v1/roles/:id publishes role.deleted", async () => {
    const group = await makeGroup();
    const role = await makeRole(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/roles/${role.id}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(204);

    expect(events).toHaveLength(1);
    const e = events[0] as RoleDeletedEvent;
    expect(e.type).toBe("role.deleted");
    expect(e.roleId).toBe(role.id);
  });

  it("POST /v1/groups/:id/members/:userId/roles/:roleId publishes role.changed (added)", async () => {
    const group = await makeGroup();
    const { externalUserId } = await makeMember(group.id);
    const role = await makeRole(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(
      `/v1/groups/${group.id}/members/${externalUserId}/roles/${role.id}`,
      { method: "POST", headers: { authorization: authHeader } },
    );
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as RoleChangedEvent;
    expect(e.type).toBe("role.changed");
    expect(e.userId).toBe(externalUserId);
    expect(e.added).toEqual([role.id]);
    expect(e.removed).toEqual([]);
    // Default-null actor when no body is supplied (legacy contract).
    expect(e.actorUserId).toBeNull();
  });

  it("role.changed carries actorUserId when supplied in the body", async () => {
    const group = await makeGroup();
    const { externalUserId } = await makeMember(group.id);
    const role = await makeRole(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(
      `/v1/groups/${group.id}/members/${externalUserId}/roles/${role.id}`,
      {
        method: "POST",
        headers: { authorization: authHeader, "content-type": "application/json" },
        body: JSON.stringify({ actorUserId: "mod_bob" }),
      },
    );
    expect(res.status).toBe(200);
    expect(events).toHaveLength(1);
    const e = events[0] as RoleChangedEvent;
    expect(e.actorUserId).toBe("mod_bob");
  });

  it("DELETE /v1/groups/:id/members/:userId/roles/:roleId publishes role.changed (removed)", async () => {
    const group = await makeGroup();
    const { member, externalUserId } = await makeMember(group.id);
    const role = await makeRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(
      `/v1/groups/${group.id}/members/${externalUserId}/roles/${role.id}`,
      { method: "DELETE", headers: { authorization: authHeader } },
    );
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as RoleChangedEvent;
    expect(e.type).toBe("role.changed");
    expect(e.added).toEqual([]);
    expect(e.removed).toEqual([role.id]);
  });

  it("assignRole already-assigned is a no-op publishing nothing", async () => {
    const group = await makeGroup();
    const { member, externalUserId } = await makeMember(group.id);
    const role = await makeRole(group.id);
    await prisma.memberRole.create({
      data: { groupMemberId: member.id, roleId: role.id },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(
      `/v1/groups/${group.id}/members/${externalUserId}/roles/${role.id}`,
      { method: "POST", headers: { authorization: authHeader } },
    );
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("POST /v1/roles/:id/permissions publishes permission.granted", async () => {
    const group = await makeGroup();
    const role = await makeRole(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/roles/${role.id}/permissions`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ permission: "guild.invite_member" }),
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as PermissionGrantedEvent;
    expect(e.type).toBe("permission.granted");
    expect(e.roleId).toBe(role.id);
    expect(e.permission).toBe("guild.invite_member");
  });

  it("DELETE /v1/roles/:id/permissions/:permission publishes permission.revoked", async () => {
    const group = await makeGroup();
    const role = await makeRole(group.id);
    await prisma.permissionDef.create({
      data: { gameId, key: "guild.invite_member" },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionKey: "guild.invite_member" },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/roles/${role.id}/permissions/guild.invite_member`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as PermissionRevokedEvent;
    expect(e.type).toBe("permission.revoked");
    expect(e.roleId).toBe(role.id);
    expect(e.permission).toBe("guild.invite_member");
  });

  it("grantPermission already-granted is a no-op publishing nothing", async () => {
    const group = await makeGroup();
    const role = await makeRole(group.id);
    await prisma.permissionDef.create({
      data: { gameId, key: "guild.invite_member" },
    });
    await prisma.rolePermission.create({
      data: { roleId: role.id, permissionKey: "guild.invite_member" },
    });
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/roles/${role.id}/permissions`, {
      method: "POST",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ permission: "guild.invite_member" }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("PUT /v1/groups/:a/relationships/:b publishes group.relationship.changed", async () => {
    const a = await makeGroup("Faction A");
    const b = await makeGroup("Faction B");
    const events = recorder(hub, a.id);

    const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
      method: "PUT",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ type: "ally" }),
    });
    expect(res.status).toBe(200);

    expect(events).toHaveLength(1);
    const e = events[0] as GroupRelationshipChangedEvent;
    expect(e.type).toBe("group.relationship.changed");
    expect(e.groupId).toBe(a.id);
    expect(e.otherGroupId).toBe(b.id);
    expect(e.relationship).not.toBeNull();
    expect(e.relationship?.type).toBe("ally");
  });

  it("setRelationship with mutual=true publishes one event per direction", async () => {
    const a = await makeGroup("Faction A");
    const b = await makeGroup("Faction B");
    const eventsA = recorder(hub, a.id);
    const eventsB = recorder(hub, b.id);

    const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
      method: "PUT",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ type: "ally", mutual: true }),
    });
    expect(res.status).toBe(200);

    expect(eventsA).toHaveLength(1);
    expect(eventsB).toHaveLength(1);
    expect((eventsA[0] as GroupRelationshipChangedEvent).otherGroupId).toBe(b.id);
    expect((eventsB[0] as GroupRelationshipChangedEvent).otherGroupId).toBe(a.id);
  });

  it("setRelationship type-equal is a no-op publishing nothing", async () => {
    const a = await makeGroup("Faction A");
    const b = await makeGroup("Faction B");
    await prisma.groupRelationship.create({
      data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
    });
    const events = recorder(hub, a.id);

    const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
      method: "PUT",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ type: "ally" }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });

  it("DELETE /v1/groups/:a/relationships/:b publishes group.relationship.changed (relationship: null)", async () => {
    const a = await makeGroup("Faction A");
    const b = await makeGroup("Faction B");
    await prisma.groupRelationship.create({
      data: { groupAId: a.id, groupBId: b.id, type: "ally", setByUserId: null },
    });
    const events = recorder(hub, a.id);

    const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(204);

    expect(events).toHaveLength(1);
    const e = events[0] as GroupRelationshipChangedEvent;
    expect(e.type).toBe("group.relationship.changed");
    expect(e.relationship).toBeNull();
  });

  it("clearRelationship on missing row is a no-op publishing nothing", async () => {
    const a = await makeGroup("Faction A");
    const b = await makeGroup("Faction B");
    const events = recorder(hub, a.id);

    const res = await app.request(`/v1/groups/${a.id}/relationships/${b.id}`, {
      method: "DELETE",
      headers: { authorization: authHeader },
    });
    expect(res.status).toBe(204);
    expect(events).toHaveLength(0);
  });

  it("members.setMetadata publishes nothing (no event type for member metadata)", async () => {
    const group = await makeGroup();
    const { externalUserId } = await makeMember(group.id);
    const events = recorder(hub, group.id);

    const res = await app.request(`/v1/groups/${group.id}/members/${externalUserId}`, {
      method: "PATCH",
      headers: { authorization: authHeader, "content-type": "application/json" },
      body: JSON.stringify({ metadata: { foo: "bar" } }),
    });
    expect(res.status).toBe(200);
    expect(events).toHaveLength(0);
  });
});
