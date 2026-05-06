import type {
  GameId,
  GroupId,
  JunjoEvent,
  MemberId,
  MemberJoinedEvent,
  UserId,
} from "@junjo/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventHub } from "./eventHub";

function fakeEvent(groupId: string, id = "evt_1"): MemberJoinedEvent {
  return {
    id,
    type: "member.joined",
    gameId: "game_test" as GameId,
    groupId: groupId as GroupId,
    occurredAt: new Date(0),
    userId: "user_alice" as UserId,
    member: {
      id: "mem_1" as MemberId,
      groupId: groupId as GroupId,
      userId: "user_alice" as UserId,
      status: "active",
      roles: [],
      metadata: {},
      notesPublic: null,
      notesPrivate: null,
      joinedAt: new Date(0),
    },
  };
}

describe("EventHub", () => {
  let hub: EventHub;

  beforeEach(() => {
    hub = new EventHub();
  });

  it("publishing without any subscribers is a no-op", () => {
    expect(() => hub.publish(fakeEvent("grp_a"))).not.toThrow();
  });

  it("invokes the registered listener when an event matches the group", () => {
    const seen: JunjoEvent[] = [];
    hub.subscribe("grp_a" as GroupId, (e) => seen.push(e));
    const evt = fakeEvent("grp_a");
    hub.publish(evt);
    expect(seen).toEqual([evt]);
  });

  it("delivers an event to every listener subscribed to the group", () => {
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe("grp_a" as GroupId, a);
    hub.subscribe("grp_a" as GroupId, b);
    hub.publish(fakeEvent("grp_a"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("does not deliver events to listeners on other groups", () => {
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe("grp_a" as GroupId, a);
    hub.subscribe("grp_b" as GroupId, b);
    hub.publish(fakeEvent("grp_a"));
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it("unsubscribe removes the listener", () => {
    const a = vi.fn();
    const off = hub.subscribe("grp_a" as GroupId, a);
    off();
    hub.publish(fakeEvent("grp_a"));
    expect(a).not.toHaveBeenCalled();
    expect(hub.subscriberCount("grp_a" as GroupId)).toBe(0);
  });

  it("calling unsubscribe twice is idempotent", () => {
    const a = vi.fn();
    const off = hub.subscribe("grp_a" as GroupId, a);
    off();
    expect(() => off()).not.toThrow();
    hub.publish(fakeEvent("grp_a"));
    expect(a).not.toHaveBeenCalled();
  });

  it("subscriberCount reflects current registrations", () => {
    expect(hub.subscriberCount("grp_a" as GroupId)).toBe(0);
    const off1 = hub.subscribe("grp_a" as GroupId, () => undefined);
    const off2 = hub.subscribe("grp_a" as GroupId, () => undefined);
    expect(hub.subscriberCount("grp_a" as GroupId)).toBe(2);
    off1();
    expect(hub.subscriberCount("grp_a" as GroupId)).toBe(1);
    off2();
    expect(hub.subscriberCount("grp_a" as GroupId)).toBe(0);
  });

  it("a listener that throws does not prevent other listeners from running", () => {
    const a = vi.fn(() => {
      throw new Error("boom");
    });
    const b = vi.fn();
    hub.subscribe("grp_a" as GroupId, a);
    hub.subscribe("grp_a" as GroupId, b);
    expect(() => hub.publish(fakeEvent("grp_a"))).not.toThrow();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("clear() removes every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    hub.subscribe("grp_a" as GroupId, a);
    hub.subscribe("grp_b" as GroupId, b);
    hub.clear();
    expect(hub.subscriberCount("grp_a" as GroupId)).toBe(0);
    expect(hub.subscriberCount("grp_b" as GroupId)).toBe(0);
    hub.publish(fakeEvent("grp_a"));
    hub.publish(fakeEvent("grp_b"));
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("a listener registered after publish is not retroactively notified", () => {
    hub.publish(fakeEvent("grp_a"));
    const a = vi.fn();
    hub.subscribe("grp_a" as GroupId, a);
    expect(a).not.toHaveBeenCalled();
  });
});
