import type { JunjoEventType } from "@junjo/shared";
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

// One representative wire payload per event type in the @junjo/shared
// union. The completeness test below keeps this table honest: adding a
// type to the union without extending the deserializer (or this table)
// fails the suite.
const WIRE_FIXTURES: Record<JunjoEventType, WireJunjoEvent> = {
  "member.joined": {
    ...groupBase,
    type: "member.joined",
    userId: "user_alice",
    member: wireMember,
  } as WireJunjoEvent,
  "member.left": {
    ...groupBase,
    type: "member.left",
    userId: "user_alice",
    reason: "kicked",
    kickedBy: "user_admin",
  } as WireJunjoEvent,
  "member.invited": {
    ...groupBase,
    type: "member.invited",
    invitation: wireInvitation,
  } as WireJunjoEvent,
  "member.banned": {
    ...groupBase,
    type: "member.banned",
    userId: "user_alice",
    reason: "spamming",
    bannedUntil: "2026-05-01T00:00:00.000Z",
  } as WireJunjoEvent,
  "member.unbanned": {
    ...groupBase,
    type: "member.unbanned",
    userId: "user_alice",
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
    junjoUserId: "user_alice",
    reason: "cheating",
    expiresAt: null,
  } as WireJunjoEvent,
  "game.user.unbanned": {
    ...userBase,
    type: "game.user.unbanned",
    junjoUserId: "user_alice",
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
    expect(allTypes).toHaveLength(22);
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
