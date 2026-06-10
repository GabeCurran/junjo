import type {
  GroupId,
  JunjoEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  PermissionGrantedEvent,
  RoleChangedEvent,
} from "@junjo/shared";
import { describe, expect, it, vi } from "vitest";
import { Junjo, JunjoError } from "./index.js";

interface SSEFrameInit {
  event: string;
  data: unknown;
  id?: string;
}

function frame({ event, data, id }: SSEFrameInit): string {
  const lines: string[] = [`event: ${event}`, `data: ${JSON.stringify(data)}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  return `${lines.join("\n")}\n\n`;
}

interface PushController {
  push: (chunk: string) => void;
  end: () => void;
  abort: (err?: Error) => void;
}

function createPushStream(): { stream: ReadableStream<Uint8Array>; ctrl: PushController } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const ctrl: PushController = {
    push: (chunk: string) => {
      if (cancelled) return;
      try {
        controller?.enqueue(encoder.encode(chunk));
      } catch {}
    },
    end: () => {
      if (cancelled) return;
      try {
        controller?.close();
      } catch {}
    },
    abort: (err?: Error) => {
      if (cancelled) return;
      try {
        controller?.error(err ?? new Error("aborted"));
      } catch {}
    },
  };
  return { stream, ctrl };
}

function streamingResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function jsonErrorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(handler: (req: Request) => Response | Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const target = url instanceof URL ? url.toString() : (url as string);
    const req = new Request(target, init);
    return handler(req);
  });
}

function makeJunjo(fetchImpl: ReturnType<typeof makeFetch>) {
  return new Junjo({
    apiKey: "test_key",
    baseUrl: "https://example.test",
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

const baseEvent = {
  id: "evt_1",
  gameId: "game_1",
  groupId: "grp_1",
  occurredAt: "2026-04-28T12:00:00.000Z",
};

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("groups.subscribe", () => {
  it("opens a GET against /v1/events/:groupId with the auth header", async () => {
    const { stream, ctrl } = createPushStream();
    const captured: { req?: Request } = {};
    const fetchMock = makeFetch((req) => {
      captured.req = req;
      return streamingResponse(stream);
    });
    const junjo = makeJunjo(fetchMock);

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, () => {});

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(captured.req?.method).toBe("GET");
    expect(new URL(captured.req?.url ?? "").pathname).toBe("/v1/events/grp_1");
    expect(captured.req?.headers.get("authorization")).toBe("Bearer test_key");
    expect(captured.req?.headers.get("accept")).toBe("text/event-stream");

    sub.close();
    ctrl.end();
  });

  it("delivers a published event with Date fields rehydrated", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(
      frame({
        event: "member.joined",
        id: "evt_1",
        data: {
          ...baseEvent,
          type: "member.joined",
          userId: "user_alice",
          member: {
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
          },
        },
      }),
    );

    await flushMicrotasks();
    expect(events).toHaveLength(1);
    const [first] = events;
    expect(first?.type).toBe("member.joined");
    expect(first?.id).toBe("evt_1");
    expect(first?.occurredAt).toBeInstanceOf(Date);
    expect(first?.occurredAt.toISOString()).toBe("2026-04-28T12:00:00.000Z");
    if (first?.type === "member.joined") {
      expect(first.member.joinedAt).toBeInstanceOf(Date);
      expect(first.member.userId).toBe("user_alice");
    }

    sub.close();
    ctrl.end();
  });

  it("delivers multiple events in order", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(
      frame({
        event: "member.left",
        id: "evt_a",
        data: {
          ...baseEvent,
          id: "evt_a",
          type: "member.left",
          userId: "user_alice",
          reason: "left",
        },
      }),
    );
    ctrl.push(
      frame({
        event: "member.left",
        id: "evt_b",
        data: {
          ...baseEvent,
          id: "evt_b",
          type: "member.left",
          userId: "user_bob",
          reason: "kicked",
          kickedBy: "user_admin",
        },
      }),
    );

    await flushMicrotasks();
    expect(events.map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
    const second = events[1] as MemberLeftEvent;
    expect(second.reason).toBe("kicked");
    expect(second.kickedBy).toBe("user_admin");

    sub.close();
    ctrl.end();
  });

  it("handles a frame split across multiple chunk boundaries", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    const full = frame({
      event: "group.deleted",
      id: "evt_split",
      data: { ...baseEvent, id: "evt_split", type: "group.deleted" },
    });
    const cut = Math.floor(full.length / 2);
    ctrl.push(full.slice(0, cut));
    await flushMicrotasks(2);
    expect(events).toHaveLength(0);
    ctrl.push(full.slice(cut));
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt_split");
    expect(events[0]?.type).toBe("group.deleted");

    sub.close();
    ctrl.end();
  });

  it("ignores comment-only heartbeat frames", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(":heartbeat\n\n");
    ctrl.push(":heartbeat\n\n");
    ctrl.push(
      frame({
        event: "group.deleted",
        id: "evt_after_hb",
        data: { ...baseEvent, id: "evt_after_hb", type: "group.deleted" },
      }),
    );

    await flushMicrotasks();
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt_after_hb");

    sub.close();
    ctrl.end();
  });

  it("close() aborts the underlying fetch and stops handler invocations", async () => {
    const { stream, ctrl } = createPushStream();
    let abortSeen: AbortSignal | undefined;
    const fetchMock = makeFetch((req) => {
      abortSeen = req.signal;
      return streamingResponse(stream);
    });
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    expect(abortSeen?.aborted).toBe(false);
    sub.close();
    expect(abortSeen?.aborted).toBe(true);

    ctrl.push(
      frame({
        event: "group.deleted",
        id: "evt_after_close",
        data: { ...baseEvent, id: "evt_after_close", type: "group.deleted" },
      }),
    );
    await flushMicrotasks();
    expect(events).toHaveLength(0);

    ctrl.end();
  });

  it("throws JunjoError on a 404 response before the stream is consumed", async () => {
    const fetchMock = makeFetch(() =>
      jsonErrorResponse({ code: "not_found", status: 404, message: "no such group" }, 404),
    );
    const junjo = makeJunjo(fetchMock);

    await expect(junjo.groups.subscribe("grp_missing" as GroupId, () => {})).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(junjo.groups.subscribe("grp_missing" as GroupId, () => {})).rejects.toBeInstanceOf(
      JunjoError,
    );
  });

  it("throws JunjoError on a 401 response", async () => {
    const fetchMock = makeFetch(() =>
      jsonErrorResponse({ code: "invalid_api_key", status: 401, message: "no auth" }, 401),
    );
    const junjo = makeJunjo(fetchMock);

    await expect(junjo.groups.subscribe("grp_1" as GroupId, () => {})).rejects.toMatchObject({
      code: "invalid_api_key",
      status: 401,
    });
  });

  it("URL-encodes the group id", async () => {
    const { stream, ctrl } = createPushStream();
    const captured: { req?: Request } = {};
    const fetchMock = makeFetch((req) => {
      captured.req = req;
      return streamingResponse(stream);
    });
    const junjo = makeJunjo(fetchMock);

    const sub = await junjo.groups.subscribe("grp/with spaces" as GroupId, () => {});
    expect(new URL(captured.req?.url ?? "").pathname).toBe("/v1/events/grp%2Fwith%20spaces");

    sub.close();
    ctrl.end();
  });

  it("calls onError and closes the stream when an event payload fails to parse", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];
    const errors: Error[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e), {
      onError: (err) => errors.push(err),
    });

    ctrl.push("event: group.deleted\ndata: {not-json\n\n");

    await flushMicrotasks();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect(events).toHaveLength(0);

    // After an onError, the stream is closed. A subsequent valid frame
    // should NOT be delivered.
    ctrl.push(
      frame({
        event: "group.deleted",
        id: "evt_late",
        data: { ...baseEvent, id: "evt_late", type: "group.deleted" },
      }),
    );
    await flushMicrotasks();
    expect(events).toHaveLength(0);

    sub.close();
    ctrl.end();
  });

  it("deserializes role.changed and permission.granted events with branded ids", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(
      frame({
        event: "role.changed",
        id: "evt_rc",
        data: {
          ...baseEvent,
          id: "evt_rc",
          type: "role.changed",
          userId: "user_alice",
          added: ["role_a", "role_b"],
          removed: ["role_c"],
        },
      }),
    );
    ctrl.push(
      frame({
        event: "permission.granted",
        id: "evt_pg",
        data: {
          ...baseEvent,
          id: "evt_pg",
          type: "permission.granted",
          roleId: "role_a",
          permission: "guild.invite",
        },
      }),
    );

    await flushMicrotasks();
    const rc = events[0] as RoleChangedEvent;
    expect(rc.type).toBe("role.changed");
    expect(rc.added).toEqual(["role_a", "role_b"]);
    expect(rc.removed).toEqual(["role_c"]);
    const pg = events[1] as PermissionGrantedEvent;
    expect(pg.type).toBe("permission.granted");
    expect(pg.roleId).toBe("role_a");
    expect(pg.permission).toBe("guild.invite");

    sub.close();
    ctrl.end();
  });

  it("deserializes group.relationship.changed with a non-null relationship", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(
      frame({
        event: "group.relationship.changed",
        data: {
          ...baseEvent,
          id: "evt_rel",
          type: "group.relationship.changed",
          otherGroupId: "grp_2",
          relationship: {
            groupAId: "grp_1",
            groupBId: "grp_2",
            type: "ally",
            since: "2026-04-27T00:00:00.000Z",
            setBy: null,
          },
        },
      }),
    );

    await flushMicrotasks();
    const e = events[0];
    expect(e?.type).toBe("group.relationship.changed");
    if (e?.type === "group.relationship.changed") {
      expect(e.otherGroupId).toBe("grp_2");
      expect(e.relationship?.type).toBe("ally");
      expect(e.relationship?.since).toBeInstanceOf(Date);
      expect(e.relationship?.setBy).toBeNull();
    }

    sub.close();
    ctrl.end();
  });

  it("deserializes group.relationship.changed with relationship: null on clear", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(
      frame({
        event: "group.relationship.changed",
        data: {
          ...baseEvent,
          id: "evt_clear",
          type: "group.relationship.changed",
          otherGroupId: "grp_2",
          relationship: null,
        },
      }),
    );

    await flushMicrotasks();
    const e = events[0];
    if (e?.type === "group.relationship.changed") {
      expect(e.relationship).toBeNull();
    } else {
      throw new Error("expected group.relationship.changed event");
    }

    sub.close();
    ctrl.end();
  });

  it("deserializes member.joined with a typed payload", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    ctrl.push(
      frame({
        event: "member.joined",
        data: {
          ...baseEvent,
          id: "evt_mj",
          type: "member.joined",
          userId: "user_alice",
          member: {
            id: "mem_1",
            groupId: "grp_1",
            userId: "user_alice",
            status: "active",
            roles: ["role_recruit"],
            metadata: { rank: "newbie" },
            notesPublic: "welcome",
            notesPrivate: null,
            joinedAt: "2026-04-28T12:00:00.000Z",
            bannedUntil: null,
          },
        },
      }),
    );

    await flushMicrotasks();
    const e = events[0] as MemberJoinedEvent;
    expect(e.type).toBe("member.joined");
    expect(e.member.roles).toEqual(["role_recruit"]);
    expect(e.member.metadata).toEqual({ rank: "newbie" });
    expect(e.member.notesPublic).toBe("welcome");

    sub.close();
    ctrl.end();
  });

  it("skips unknown event types and keeps the stream alive (forward compatibility)", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];
    const errors: Error[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e), {
      onError: (err) => errors.push(err),
    });

    ctrl.push(
      frame({
        event: "member.promoted",
        id: "evt_future",
        data: { ...baseEvent, id: "evt_future", type: "member.promoted", userId: "user_alice" },
      }),
    );
    ctrl.push(
      frame({
        event: "group.deleted",
        id: "evt_known",
        data: { ...baseEvent, id: "evt_known", type: "group.deleted" },
      }),
    );

    await flushMicrotasks();
    expect(errors).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt_known");

    sub.close();
    ctrl.end();
  });

  it("closes with stream_overflow when an unterminated frame exceeds the buffer cap", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const errors: Error[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, () => {}, {
      onError: (err) => errors.push(err),
    });

    // No "\n\n" anywhere: a hostile or broken stream that never
    // terminates its frame. Push past the 1 MiB cap in large chunks.
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 5; i += 1) ctrl.push(chunk);

    await flushMicrotasks(10);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(JunjoError);
    expect((errors[0] as JunjoError).code).toBe("stream_overflow");

    sub.close();
    ctrl.end();
  });

  it("close() is idempotent: calling it twice neither throws nor double-aborts", async () => {
    const { stream, ctrl } = createPushStream();
    let abortCount = 0;
    const fetchMock = makeFetch((req) => {
      req.signal.addEventListener("abort", () => {
        abortCount += 1;
      });
      return streamingResponse(stream);
    });
    const junjo = makeJunjo(fetchMock);

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, () => {});

    expect(() => {
      sub.close();
      sub.close();
    }).not.toThrow();
    expect(abortCount).toBe(1);

    ctrl.end();
  });

  it("parses frames from a CRLF-normalized stream", async () => {
    const { stream, ctrl } = createPushStream();
    const fetchMock = makeFetch(() => streamingResponse(stream));
    const junjo = makeJunjo(fetchMock);
    const events: JunjoEvent[] = [];

    const sub = await junjo.groups.subscribe("grp_1" as GroupId, (e) => events.push(e));

    const data = JSON.stringify({ ...baseEvent, id: "evt_crlf", type: "group.deleted" });
    ctrl.push(`event: group.deleted\r\ndata: ${data}\r\n\r\n`);

    await flushMicrotasks();
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt_crlf");

    sub.close();
    ctrl.end();
  });
});
