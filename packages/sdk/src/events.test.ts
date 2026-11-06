import type { JunjoEventType } from "@junjo.io/shared";
import { describe, expect, it } from "vitest";
import { JunjoError } from "./errors.js";
import {
  UNKNOWN_EVENT_TYPE,
  type WireJunjoEvent,
  deserializeEvent,
  parseSSEFrame,
} from "./events.js";
import { parseWireDate } from "./wire.js";

const groupBase = {
  id: "evt_1",
  gameId: "game_1",
  groupId: "grp_1",
  occurredAt: "2026-04-28T12:00:00.000Z",
};

const userBase = {
  id: "evt_1",
  gameId: "game_1",
  occurredAt: "2026-04-28T12:00:00.000Z",
};

const wireMember = {
  id: "mem_1",
  groupId: "grp_1",
  userId: "user_alice",
  status: "active",
  roles: [],
  metadata: {},
  notesPublic: null,
  notesPrivate: null,
  joinedAt: "2026-04-28T12:00:00.000Z",
  bannedUntil: null,
  version: 3,
};

const wireInvitation = {
  id: "inv_1",
  groupId: "grp_1",
  code: "JOIN-ME",
  roleId: null,
  targetUserId: "user_bob",
  createdBy: "user_alice",
  createdAt: "2026-04-28T12:00:00.000Z",
  expiresAt: null,
  usedAt: null,
  usedBy: null,
};

const wireRole = {
  id: "role_1",
  groupId: "grp_1",
  name: "Officer",
  priority: 10,
  permissions: ["guild.invite"],
  createdAt: "2026-04-28T12:00:00.000Z",
};

const wireGroup = {
  id: "grp_1",
  gameId: "game_1",
  kind: "guild",
  name: "The Guild",
  visibility: "public",
  metadata: {},
  defaultRoleId: null,
  parentGroupId: null,
  memberCount: 3,
  hasPasscode: false,
  createdAt: "2026-04-28T12:00:00.000Z",
  updatedAt: "2026-04-28T12:00:00.000Z",
  softDeletedAt: null,
};

// One representative wire payload per event type in the @junjo.io/shared
// union. The completeness test below keeps this table honest: adding a
// type to the union without extending the deserializer (or this table)
// fails the suite.
const WIRE_FIXTURES: Record<JunjoEventType, WireJunjoEvent> = {
  "member.joined": {
    ...groupBase,
    type: "member.joined",
    userId: "user_alice",
    member: wireMember,
    memberVersion: 3,
  } as WireJunjoEvent,
  "member.left": {
    ...groupBase,
    type: "member.left",
    userId: "user_alice",
    reason: "kicked",
    kickedBy: "user_admin",
    memberVersion: 4,
  } as WireJunjoEvent,
  "member.invited": {
    ...groupBase,
    type: "member.invited",
    invitation: wireInvitation,
  } as WireJunjoEvent,
  "member.updated": {
    ...groupBase,
    type: "member.updated",
    userId: "user_alice",
    changed: ["metadata", "overrides"],
    memberVersion: 5,
  } as WireJunjoEvent,
  "member.banned": {
    ...groupBase,
    type: "member.banned",
    userId: "user_alice",
    reason: "spamming",
    bannedUntil: "2026-05-01T00:00:00.000Z",
    memberVersion: 6,
  } as WireJunjoEvent,
  "member.unbanned": {
    ...groupBase,
    type: "member.unbanned",
    userId: "user_alice",
    memberVersion: 7,
  } as WireJunjoEvent,
  "role.created": {
    ...groupBase,
    type: "role.created",
    role: wireRole,
  } as WireJunjoEvent,
  "role.changed": {
    ...groupBase,
    type: "role.changed",
    userId: "user_alice",
    added: ["role_a"],
    removed: [],
    actorUserId: "user_admin",
    memberVersion: 8,
  } as WireJunjoEvent,
  "role.updated": {
    ...groupBase,
    type: "role.updated",
    roleId: "role_a",
    changed: ["entries", "parents"],
  } as WireJunjoEvent,
  "role.deleted": {
    ...groupBase,
    type: "role.deleted",
    roleId: "role_a",
  } as WireJunjoEvent,
  "permission.granted": {
    ...groupBase,
    type: "permission.granted",
    roleId: "role_a",
    permission: "guild.invite",
  } as WireJunjoEvent,
  "permission.revoked": {
    ...groupBase,
    type: "permission.revoked",
    roleId: "role_a",
    permission: "guild.invite",
  } as WireJunjoEvent,
  "group.updated": {
    ...groupBase,
    type: "group.updated",
    group: wireGroup,
  } as WireJunjoEvent,
  "group.deleted": {
    ...groupBase,
    type: "group.deleted",
  } as WireJunjoEvent,
  "group.relationship.changed": {
    ...groupBase,
    type: "group.relationship.changed",
    otherGroupId: "grp_2",
    relationship: null,
  } as WireJunjoEvent,
  "friend.request.sent": {
    ...userBase,
    type: "friend.request.sent",
    requestId: "freq_1",
    actorJunjoUserId: "user_alice",
    targetJunjoUserId: "user_bob",
  } as WireJunjoEvent,
  "friend.request.accepted": {
    ...userBase,
    type: "friend.request.accepted",
    relationshipId: "frel_1",
    actorJunjoUserId: "user_alice",
    targetJunjoUserId: "user_bob",
    respondedAt: "2026-04-28T12:30:00.000Z",
  } as WireJunjoEvent,
  "friend.request.declined": {
    ...userBase,
    type: "friend.request.declined",
    requestId: "freq_1",
    actorJunjoUserId: "user_alice",
    targetJunjoUserId: "user_bob",
  } as WireJunjoEvent,
  "friend.request.cancelled": {
    ...userBase,
    type: "friend.request.cancelled",
    requestId: "freq_1",
    actorJunjoUserId: "user_alice",
    targetJunjoUserId: "user_bob",
  } as WireJunjoEvent,
  "friend.removed": {
    ...userBase,
    type: "friend.removed",
    removedByJunjoUserId: "user_alice",
    otherJunjoUserId: "user_bob",
  } as WireJunjoEvent,
  "friend.blocked": {
    ...userBase,
    type: "friend.blocked",
    byJunjoUserId: "user_alice",
    otherJunjoUserId: "user_bob",
  } as WireJunjoEvent,
  "friend.unblocked": {
    ...userBase,
    type: "friend.unblocked",
    byJunjoUserId: "user_alice",
    otherJunjoUserId: "user_bob",
  } as WireJunjoEvent,
  "game.user.banned": {
    ...userBase,
    type: "game.user.banned",
    junjoUserId: "jusr_alice",
    userId: "game:alice",
    reason: "cheating",
    expiresAt: null,
    moderationVersion: 2,
  } as WireJunjoEvent,
  "game.user.unbanned": {
    ...userBase,
    type: "game.user.unbanned",
    junjoUserId: "jusr_alice",
    userId: "game:alice",
    moderationVersion: 3,
  } as WireJunjoEvent,
  "identity.linked": {
    ...userBase,
    type: "identity.linked",
    userId: "game:alice",
    linkedUserId: "web:alice",
    identities: ["game:alice", "web:alice"],
  } as WireJunjoEvent,
  "identity.unlinked": {
    ...userBase,
    type: "identity.unlinked",
    userId: "game:alice",
    unlinkedUserId: "web:alice",
    identities: ["game:alice"],
  } as WireJunjoEvent,
  "game.user.sanctioned": {
    ...userBase,
    type: "game.user.sanctioned",
    userId: "game:alice",
    sanctionType: "mute",
    reason: "spam",
    expiresAt: "2026-04-28T13:00:00.000Z",
    moderationVersion: 4,
  } as WireJunjoEvent,
  "game.user.unsanctioned": {
    ...userBase,
    type: "game.user.unsanctioned",
    userId: "game:alice",
    sanctionType: "mute",
    moderationVersion: 5,
  } as WireJunjoEvent,
  "identity.updated": {
    ...userBase,
    type: "identity.updated",
    userId: "game:alice",
    changedUserId: "web:alice",
    displayName: "Alice",
    changed: ["displayName"],
  } as WireJunjoEvent,
  "permissions.config.updated": {
    ...userBase,
    type: "permissions.config.updated",
    mode: "nodes",
    contexts: { world: { inherit: { nether: ["overworld"] } } },
  } as WireJunjoEvent,
};

describe("deserializeEvent completeness", () => {
  const allTypes = Object.keys(WIRE_FIXTURES) as JunjoEventType[];

  it.each(allTypes)("round-trips %s with a rehydrated occurredAt", (type) => {
    const event = deserializeEvent(WIRE_FIXTURES[type]);
    expect(event).toBeDefined();
    expect(event.type).toBe(type);
    expect(event.occurredAt).toBeInstanceOf(Date);
    expect(event.occurredAt.toISOString()).toBe("2026-04-28T12:00:00.000Z");
    expect(event.id).toBe("evt_1");
  });

  it("covers every type in the JunjoEvent union (none deserialize to undefined)", () => {
    for (const type of allTypes) {
      expect(deserializeEvent(WIRE_FIXTURES[type])).toBeDefined();
    }
    expect(allTypes).toHaveLength(30);
  });

  it("carries userId and the changed fields on member.updated", () => {
    const event = deserializeEvent(WIRE_FIXTURES["member.updated"]);
    if (event.type !== "member.updated") throw new Error("wrong type");
    expect(event.groupId).toBe("grp_1");
    expect(event.userId).toBe("user_alice");
    expect(event.changed).toEqual(["metadata", "overrides"]);
  });

  it("throws JunjoError(unknown_event_type) on a type this SDK predates", () => {
    const future = { ...groupBase, type: "member.promoted" } as unknown as WireJunjoEvent;
    try {
      deserializeEvent(future);
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JunjoError);
      expect((err as JunjoError).code).toBe(UNKNOWN_EVENT_TYPE);
      expect((err as JunjoError).message).toContain("member.promoted");
    }
  });

  it("rehydrates nested dates and nullables on member.banned", () => {
    const event = deserializeEvent(WIRE_FIXTURES["member.banned"]);
    if (event.type !== "member.banned") throw new Error("wrong type");
    expect(event.bannedUntil).toBeInstanceOf(Date);
    expect(event.reason).toBe("spamming");
    expect(event.groupId).toBe("grp_1");
  });

  it("carries roleId and the changed fields on role.updated", () => {
    const event = deserializeEvent(WIRE_FIXTURES["role.updated"]);
    if (event.type !== "role.updated") throw new Error("wrong type");
    expect(event.groupId).toBe("grp_1");
    expect(event.roleId).toBe("role_a");
    expect(event.changed).toEqual(["entries", "parents"]);
  });

  it("defaults entries, parents, and metadata on a role.created role from an older server", () => {
    const event = deserializeEvent(WIRE_FIXTURES["role.created"]);
    if (event.type !== "role.created") throw new Error("wrong type");
    expect(event.role.entries).toEqual([]);
    expect(event.role.parents).toEqual([]);
    expect(event.role.metadata).toEqual({});
  });

  it("preserves null bannedUntil (permanent ban)", () => {
    const wire = {
      ...WIRE_FIXTURES["member.banned"],
      bannedUntil: null,
    } as WireJunjoEvent;
    const event = deserializeEvent(wire);
    if (event.type !== "member.banned") throw new Error("wrong type");
    expect(event.bannedUntil).toBeNull();
  });

  it("rehydrates respondedAt on friend.request.accepted", () => {
    const event = deserializeEvent(WIRE_FIXTURES["friend.request.accepted"]);
    if (event.type !== "friend.request.accepted") throw new Error("wrong type");
    expect(event.respondedAt).toBeInstanceOf(Date);
    expect(event.actorJunjoUserId).toBe("user_alice");
    expect(event.targetJunjoUserId).toBe("user_bob");
  });

  it("carries the external userId alongside junjoUserId on game.user.banned and unbanned", () => {
    const banned = deserializeEvent(WIRE_FIXTURES["game.user.banned"]);
    if (banned.type !== "game.user.banned") throw new Error("wrong type");
    expect(banned.userId).toBe("game:alice");
    expect(banned.junjoUserId).toBe("jusr_alice");
    expect(banned.expiresAt).toBeNull();
    const unbanned = deserializeEvent(WIRE_FIXTURES["game.user.unbanned"]);
    if (unbanned.type !== "game.user.unbanned") throw new Error("wrong type");
    expect(unbanned.userId).toBe("game:alice");
    expect(unbanned.junjoUserId).toBe("jusr_alice");
  });

  it("carries memberVersion on every member event and the member's version on member.joined", () => {
    const expected: Partial<Record<JunjoEventType, number>> = {
      "member.joined": 3,
      "member.left": 4,
      "member.updated": 5,
      "member.banned": 6,
      "member.unbanned": 7,
      "role.changed": 8,
    };
    for (const [type, version] of Object.entries(expected)) {
      const event = deserializeEvent(WIRE_FIXTURES[type as JunjoEventType]);
      expect((event as { memberVersion?: number }).memberVersion).toBe(version);
    }
    const joined = deserializeEvent(WIRE_FIXTURES["member.joined"]);
    if (joined.type !== "member.joined") throw new Error("wrong type");
    expect(joined.member.version).toBe(3);
  });

  it("carries moderationVersion on game.user.banned and unbanned", () => {
    const banned = deserializeEvent(WIRE_FIXTURES["game.user.banned"]);
    if (banned.type !== "game.user.banned") throw new Error("wrong type");
    expect(banned.moderationVersion).toBe(2);
    const unbanned = deserializeEvent(WIRE_FIXTURES["game.user.unbanned"]);
    if (unbanned.type !== "game.user.unbanned") throw new Error("wrong type");
    expect(unbanned.moderationVersion).toBe(3);
  });

  it("deserializes identity.linked with the person, the joining id, and every id", () => {
    const event = deserializeEvent(WIRE_FIXTURES["identity.linked"]);
    if (event.type !== "identity.linked") throw new Error("wrong type");
    expect(event.userId).toBe("game:alice");
    expect(event.linkedUserId).toBe("web:alice");
    expect(event.identities).toEqual(["game:alice", "web:alice"]);
    expect("groupId" in event).toBe(false);
  });

  it("deserializes identity.unlinked with the remaining person and the leaving id", () => {
    const event = deserializeEvent(WIRE_FIXTURES["identity.unlinked"]);
    if (event.type !== "identity.unlinked") throw new Error("wrong type");
    expect(event.userId).toBe("game:alice");
    expect(event.unlinkedUserId).toBe("web:alice");
    expect(event.identities).toEqual(["game:alice"]);
    expect("groupId" in event).toBe(false);
  });

  it("deserializes game.user.sanctioned and unsanctioned with sanctionType and moderationVersion", () => {
    const set = deserializeEvent(WIRE_FIXTURES["game.user.sanctioned"]);
    if (set.type !== "game.user.sanctioned") throw new Error("wrong type");
    expect(set.userId).toBe("game:alice");
    expect(set.sanctionType).toBe("mute");
    expect(set.reason).toBe("spam");
    expect(set.expiresAt).toEqual(new Date("2026-04-28T13:00:00.000Z"));
    expect(set.moderationVersion).toBe(4);
    expect("groupId" in set).toBe(false);
    const lifted = deserializeEvent(WIRE_FIXTURES["game.user.unsanctioned"]);
    if (lifted.type !== "game.user.unsanctioned") throw new Error("wrong type");
    expect(lifted.sanctionType).toBe("mute");
    expect(lifted.moderationVersion).toBe(5);
  });

  it("preserves a null expiresAt on game.user.sanctioned (permanent)", () => {
    const wire = { ...WIRE_FIXTURES["game.user.sanctioned"], expiresAt: null } as WireJunjoEvent;
    const event = deserializeEvent(wire);
    if (event.type !== "game.user.sanctioned") throw new Error("wrong type");
    expect(event.expiresAt).toBeNull();
  });

  it("deserializes identity.updated with the person, the changed id, and the new name", () => {
    const event = deserializeEvent(WIRE_FIXTURES["identity.updated"]);
    if (event.type !== "identity.updated") throw new Error("wrong type");
    expect(event.userId).toBe("game:alice");
    expect(event.changedUserId).toBe("web:alice");
    expect(event.displayName).toBe("Alice");
    expect(event.changed).toEqual(["displayName"]);
    const cleared = deserializeEvent({
      ...WIRE_FIXTURES["identity.updated"],
      displayName: null,
    } as WireJunjoEvent);
    if (cleared.type !== "identity.updated") throw new Error("wrong type");
    expect(cleared.displayName).toBeNull();
  });

  it("deserializes permissions.config.updated with the new mode and inheritance", () => {
    const event = deserializeEvent(WIRE_FIXTURES["permissions.config.updated"]);
    if (event.type !== "permissions.config.updated") throw new Error("wrong type");
    expect(event.mode).toBe("nodes");
    expect(event.contexts).toEqual({ world: { inherit: { nether: ["overworld"] } } });
    expect("groupId" in event).toBe(false);
    const empty = deserializeEvent({
      ...WIRE_FIXTURES["permissions.config.updated"],
      mode: "exact",
      contexts: {},
    } as WireJunjoEvent);
    if (empty.type !== "permissions.config.updated") throw new Error("wrong type");
    expect(empty.mode).toBe("exact");
    expect(empty.contexts).toEqual({});
  });

  it("user-scoped events carry no groupId", () => {
    const event = deserializeEvent(WIRE_FIXTURES["friend.request.sent"]);
    expect("groupId" in event).toBe(false);
  });

  it("throws JunjoError(invalid_wire_data) on a malformed occurredAt", () => {
    const wire = {
      ...WIRE_FIXTURES["group.deleted"],
      occurredAt: "yesterday-ish",
    } as WireJunjoEvent;
    expect(() => deserializeEvent(wire)).toThrowError(/invalid timestamp in occurredAt/);
  });
});

describe("parseWireDate", () => {
  it("parses a valid ISO timestamp", () => {
    const d = parseWireDate("2026-04-28T12:00:00.000Z", "x");
    expect(d.toISOString()).toBe("2026-04-28T12:00:00.000Z");
  });

  it("throws JunjoError(invalid_wire_data) naming the field on garbage", () => {
    try {
      parseWireDate("garbage", "joinedAt");
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(JunjoError);
      expect((err as JunjoError).code).toBe("invalid_wire_data");
      expect((err as JunjoError).message).toContain("joinedAt");
    }
  });
});

describe("parseSSEFrame CRLF tolerance", () => {
  it("parses a frame whose lines end with \\r (CRLF-normalized stream)", () => {
    const frame = parseSSEFrame('event: group.deleted\r\ndata: {"a":1}\r\nid: evt_x\r');
    expect(frame).toEqual({ event: "group.deleted", data: '{"a":1}', id: "evt_x" });
  });

  it("does not strip meaningful characters from LF-only frames", () => {
    const frame = parseSSEFrame('event: group.deleted\ndata: {"a":1}');
    expect(frame).toEqual({ event: "group.deleted", data: '{"a":1}' });
  });

  it("still treats comment-only CRLF frames as keep-alives", () => {
    expect(parseSSEFrame(":heartbeat\r")).toBeNull();
  });
});
