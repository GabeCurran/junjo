import type {
  GameId,
  GroupId,
  InvitationId,
  JunjoEvent,
  MemberId,
  MemberInvitedEvent,
  MemberJoinedEvent,
  UserId,
} from "@junjo.io/shared";
import { describe, expect, it } from "vitest";
import { emittedUserIds, renderEvent, renderIsIdentity } from "./eventRender";

const at = new Date("2026-11-05T00:00:00.000Z");

function joined(userId: string): MemberJoinedEvent {
  return {
    id: "evt_1",
    type: "member.joined",
    gameId: "game_1" as GameId,
    groupId: "group_1" as GroupId,
    occurredAt: at,
    userId: userId as UserId,
    member: {
      id: "mem_1" as MemberId,
      groupId: "group_1" as GroupId,
      userId: userId as UserId,
      status: "active",
      roles: [],
      metadata: { note: userId },
      notesPublic: null,
      notesPrivate: null,
      joinedAt: at,
      bannedUntil: null,
      version: 1,
    },
    memberVersion: 1,
  };
}

const table = new Map([["web:2", ["mc:1", "web:2"]]]);

describe("renderEvent", () => {
  it("rewrites every declared path to the preferred id", () => {
    const out = renderEvent(joined("web:2"), table, []) as MemberJoinedEvent;
    expect(out.userId).toBe("mc:1");
    expect(out.member.userId).toBe("mc:1");
  });

  it("leaves undeclared fields, including dev metadata, untouched", () => {
    const out = renderEvent(joined("web:2"), table, []) as MemberJoinedEvent;
    expect(out.member.metadata).toEqual({ note: "web:2" });
    expect(out.occurredAt).toEqual(at);
  });

  it("honours the namespace preference", () => {
    const out = renderEvent(joined("web:2"), table, ["web"]) as MemberJoinedEvent;
    expect(out.userId).toBe("web:2");
  });

  it("returns the same object when nothing changes and never mutates", () => {
    const event = joined("web:2");
    expect(renderEvent(event, table, ["web"])).toBe(event);
    renderEvent(event, table, []);
    expect(event.userId).toBe("web:2");
  });

  it("delivers unknown ids unchanged", () => {
    const event = joined("ghost");
    expect(renderEvent(event, table, [])).toBe(event);
  });

  it("does not rewrite literal invitation targets", () => {
    const event: MemberInvitedEvent = {
      id: "evt_2",
      type: "member.invited",
      gameId: "game_1" as GameId,
      groupId: "group_1" as GroupId,
      occurredAt: at,
      invitation: {
        id: "inv_1" as InvitationId,
        groupId: "group_1" as GroupId,
        code: "abc",
        roleId: null,
        targetUserId: "web:2" as UserId,
        createdBy: null,
        createdAt: at,
        expiresAt: null,
        usedAt: null,
        usedBy: null,
      },
    };
    expect(emittedUserIds(event as JunjoEvent)).toEqual([]);
  });
});

describe("renderIsIdentity", () => {
  it("is true only when every emitted id is its person's only id", () => {
    expect(renderIsIdentity(new Map([["a", ["a"]]]))).toBe(true);
    expect(renderIsIdentity(table)).toBe(false);
    expect(renderIsIdentity(new Map())).toBe(true);
  });
});
