import type { JunjoEvent } from "@junjo.io/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GameSubscription, Junjo, JunjoError } from "./index.js";

interface PushController {
  push: (chunk: string) => void;
  end: () => void;
  abort: (err?: Error) => void;
  readonly cancelled: boolean;
}

function createPushStream(): { stream: ReadableStream<Uint8Array>; ctrl: PushController } {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let cancelled = false;
  let finished = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      cancelled = true;
    },
  });
  const ctrl: PushController = {
    push: (chunk) => {
      if (cancelled || finished) return;
      controller?.enqueue(encoder.encode(chunk));
    },
    end: () => {
      if (cancelled || finished) return;
      finished = true;
      controller?.close();
    },
    abort: (err) => {
      if (cancelled || finished) return;
      finished = true;
      controller?.error(err ?? new Error("connection reset"));
    },
    get cancelled() {
      return cancelled;
    },
  };
  return { stream, ctrl };
}

function eventFrame(data: Record<string, unknown>, id: string): string {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;
}

function bannedEvent(id: string): Record<string, unknown> {
  return {
    id,
    gameId: "game_1",
    occurredAt: "2026-11-06T12:00:00.000Z",
    type: "game.user.banned",
    junjoUserId: "ju_1",
    userId: "user_alice",
    reason: null,
    expiresAt: null,
  };
}

function errorResponse(status: number, code: string): Response {
  return new Response(JSON.stringify({ code, status, message: code }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Scripted fake server: each fetch takes the next queued answer, and
// every request plus every opened stream is recorded for assertions.
function makeServer() {
  const requests: Request[] = [];
  const streams: PushController[] = [];
  const queue: Array<() => Response> = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(url instanceof URL ? url.toString() : (url as string), init);
    requests.push(req);
    const next = queue.shift();
    if (next === undefined) throw new Error("unscripted request");
    return next();
  });
  const server = {
    fetch,
    requests,
    streams,
    ok(position: string) {
      queue.push(() => {
        const { stream, ctrl } = createPushStream();
        streams.push(ctrl);
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream", "junjo-stream-position": position },
        });
      });
      return server;
    },
    status(status: number, code: string) {
      queue.push(() => errorResponse(status, code));
      return server;
    },
    networkError() {
      queue.push(() => {
        throw new TypeError("fetch failed");
      });
      return server;
    },
    last(): PushController {
      const ctrl = streams[streams.length - 1];
      if (ctrl === undefined) throw new Error("no stream opened");
      return ctrl;
    },
    header(i: number, name: string): string | null {
      return requests[i]?.headers.get(name) ?? null;
    },
  };
  return server;
}

type Server = ReturnType<typeof makeServer>;

function makeJunjo(server: Server): Junjo {
  return new Junjo({
    apiKey: "jk_test.secret",
    baseUrl: "https://example.test",
    fetch: server.fetch as unknown as typeof fetch,
  });
}

// Yields to the real event loop several times so stream reads,
// response parsing and promise chains settle under fake timers.
async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await vi.advanceTimersByTimeAsync(0);
}

const openSubs: GameSubscription[] = [];
const openServers: Server[] = [];

function track(server: Server): Server {
  openServers.push(server);
  return server;
}

async function subscribe(
  junjo: Junjo,
  handler: Parameters<Junjo["events"]["subscribe"]>[0],
  opts?: Parameters<Junjo["events"]["subscribe"]>[1],
): Promise<GameSubscription> {
  const sub = await junjo.events.subscribe(handler, opts);
  openSubs.push(sub);
  return sub;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  for (const sub of openSubs.splice(0)) sub.close();
  for (const server of openServers.splice(0)) {
    for (const ctrl of server.streams) ctrl.end();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("events.position", () => {
  it("GETs /v1/events/position and returns the position string untouched", async () => {
    const fetch = vi.fn(async () => Response.json({ position: "9223372036854775807" }));
    const junjo = new Junjo({
      apiKey: "jk_test.secret",
      baseUrl: "https://example.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(junjo.events.position()).resolves.toBe("9223372036854775807");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/events/position");
    expect(init.method).toBe("GET");
  });

  it("rejects with invalid_wire_data when the body has no position", async () => {
    const fetch = vi.fn(async () => Response.json({}));
    const junjo = new Junjo({
      apiKey: "jk_test.secret",
      baseUrl: "https://example.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await expect(junjo.events.position()).rejects.toMatchObject({ code: "invalid_wire_data" });
  });
});

describe("events.subscribe: first connection", () => {
  it("opens GET /v1/events with auth and no Last-Event-ID, starting at the header position", async () => {
    const server = track(makeServer().ok("42"));
    const sub = await subscribe(makeJunjo(server), () => {});

    const req = server.requests[0] as Request;
    expect(new URL(req.url).pathname).toBe("/v1/events");
    expect(new URL(req.url).search).toBe("");
    expect(req.headers.get("authorization")).toBe("Bearer jk_test.secret");
    expect(req.headers.get("accept")).toBe("text/event-stream");
    expect(req.headers.get("last-event-id")).toBeNull();
    expect(sub.position).toBe("42");
  });

  it("sends types comma-joined and URL-encoded", async () => {
    const server = track(makeServer().ok("1"));
    await subscribe(makeJunjo(server), () => {}, {
      types: ["game.user.banned", "member.updated"],
    });

    const url = new URL((server.requests[0] as Request).url);
    expect(url.search).toBe("?types=game.user.banned%2Cmember.updated");
    expect(url.searchParams.get("types")).toBe("game.user.banned,member.updated");
  });

  it("omits the types query for an empty list", async () => {
    const server = track(makeServer().ok("1"));
    await subscribe(makeJunjo(server), () => {}, { types: [] });
    expect(new URL((server.requests[0] as Request).url).search).toBe("");
  });

  it("sends `from` as Last-Event-ID", async () => {
    const server = track(makeServer().ok("17"));
    const sub = await subscribe(makeJunjo(server), () => {}, { from: "17" });
    expect(server.header(0, "last-event-id")).toBe("17");
    expect(sub.position).toBe("17");
  });

  it.each([
    [400, "bad_request"],
    [401, "invalid_api_key"],
    [410, "stream_position_expired"],
    [429, "too_many_streams"],
    [503, "internal"],
  ])("rejects on a %i without retrying", async (status, code) => {
    const server = track(makeServer().status(status, code));
    const onResync = vi.fn();
    await expect(
      makeJunjo(server).events.subscribe(() => {}, { from: "5", onResync }),
    ).rejects.toMatchObject({ code, status });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledOnce();
    expect(onResync).not.toHaveBeenCalled();
  });

  it("rejects with network_error on a transport failure without retrying", async () => {
    const server = track(makeServer().networkError());
    await expect(makeJunjo(server).events.subscribe(() => {})).rejects.toMatchObject({
      code: "network_error",
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("rejects with cancelled for a pre-aborted signal without fetching", async () => {
    const server = track(makeServer());
    const ac = new AbortController();
    ac.abort();
    await expect(
      makeJunjo(server).events.subscribe(() => {}, { signal: ac.signal }),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(server.fetch).not.toHaveBeenCalled();
  });

  it("rejects with invalid_wire_data when the position header is missing", async () => {
    const { stream, ctrl } = createPushStream();
    const fetch = vi.fn(async () => new Response(stream, { status: 200 }));
    const junjo = new Junjo({
      apiKey: "jk_test.secret",
      baseUrl: "https://example.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(junjo.events.subscribe(() => {})).rejects.toMatchObject({
      code: "invalid_wire_data",
    });
    expect(ctrl.cancelled).toBe(true);
  });
});

describe("events.subscribe: frames and positions", () => {
  it("delivers events with their frame position and advances on heartbeats", async () => {
    const server = track(makeServer().ok("10"));
    const seen: Array<[JunjoEvent, string]> = [];
    const sub = await subscribe(makeJunjo(server), (event, meta) =>
      seen.push([event, meta.position]),
    );

    server.last().push(eventFrame(bannedEvent("evt_a"), "11"));
    server.last().push(eventFrame(bannedEvent("evt_b"), "12"));
    await flush();
    expect(seen.map(([e, p]) => [e.id, p])).toEqual([
      ["evt_a", "11"],
      ["evt_b", "12"],
    ]);
    expect(seen[0]?.[0].occurredAt).toBeInstanceOf(Date);
    expect(sub.position).toBe("12");

    server.last().push(":heartbeat\nid: 57\n\n");
    await flush();
    expect(seen).toHaveLength(2);
    expect(sub.position).toBe("57");
  });

  it("keeps positions beyond Number's exact range as exact strings", async () => {
    const server = track(makeServer().ok("9007199254740993"));
    const positions: string[] = [];
    const sub = await subscribe(makeJunjo(server), (_e, meta) => positions.push(meta.position));

    server.last().push(eventFrame(bannedEvent("evt_big"), "9223372036854775807"));
    await flush();
    expect(positions).toEqual(["9223372036854775807"]);
    expect(sub.position).toBe("9223372036854775807");
  });

  it("skips an unknown event type but still advances the position", async () => {
    const server = track(makeServer().ok("1"));
    const handler = vi.fn();
    const onError = vi.fn();
    const sub = await subscribe(makeJunjo(server), handler, { onError });

    server.last().push(eventFrame({ ...bannedEvent("evt_future"), type: "game.future" }, "2"));
    await flush();
    expect(handler).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(sub.position).toBe("2");
  });

  it("delivers member.updated with its changed fields", async () => {
    const server = track(makeServer().ok("1"));
    const events: JunjoEvent[] = [];
    await subscribe(makeJunjo(server), (e) => events.push(e));

    server.last().push(
      eventFrame(
        {
          id: "evt_mu",
          gameId: "game_1",
          groupId: "grp_1",
          occurredAt: "2026-11-06T12:00:00.000Z",
          type: "member.updated",
          userId: "user_alice",
          changed: ["notes"],
        },
        "2",
      ),
    );
    await flush();
    const event = events[0];
    if (event?.type !== "member.updated") throw new Error("expected member.updated");
    expect(event.groupId).toBe("grp_1");
    expect(event.userId).toBe("user_alice");
    expect(event.changed).toEqual(["notes"]);
  });

  it("stops with onError when the handler throws, without reconnecting", async () => {
    const server = track(makeServer().ok("1"));
    const boom = new Error("handler broke");
    const onError = vi.fn();
    const onReconnecting = vi.fn();
    await subscribe(
      makeJunjo(server),
      () => {
        throw boom;
      },
      { onError, onReconnecting },
    );

    server.last().push(eventFrame(bannedEvent("evt_a"), "2"));
    server.last().push(eventFrame(bannedEvent("evt_b"), "3"));
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(server.last().cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(onReconnecting).not.toHaveBeenCalled();
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("stops with onError on a malformed frame and does not advance past it", async () => {
    const server = track(makeServer().ok("1"));
    const onError = vi.fn();
    const sub = await subscribe(makeJunjo(server), () => {}, { onError });

    server.last().push("event: game.user.banned\ndata: {not-json\nid: 2\n\n");
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(sub.position).toBe("1");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("stops with stream_overflow when an unterminated frame passes the cap", async () => {
    const server = track(makeServer().ok("1"));
    const onError = vi.fn();
    await subscribe(makeJunjo(server), () => {}, { onError });

    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 5; i += 1) server.last().push(chunk);
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]?.[0] as JunjoError).code).toBe("stream_overflow");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("delivers nothing after close() is called from inside the handler", async () => {
    const server = track(makeServer().ok("1"));
    const ids: string[] = [];
    const sub: GameSubscription = await subscribe(makeJunjo(server), (event) => {
      ids.push(event.id);
      sub.close();
    });

    server
      .last()
      .push(eventFrame(bannedEvent("evt_a"), "2") + eventFrame(bannedEvent("evt_b"), "3"));
    await flush();
    expect(ids).toEqual(["evt_a"]);
  });
});

describe("events.subscribe: reconnect", () => {
  it("reconnects after a clean server close with Last-Event-ID and the same types", async () => {
    const server = track(makeServer().ok("10").ok("12"));
    const onReconnecting = vi.fn();
    const onReconnected = vi.fn();
    const sub = await subscribe(makeJunjo(server), () => {}, {
      types: ["game.user.banned"],
      onReconnecting,
      onReconnected,
    });

    server.last().push(eventFrame(bannedEvent("evt_a"), "11"));
    server.last().push(":heartbeat\nid: 12\n\n");
    server.last().end();
    await flush();
    expect(onReconnecting).toHaveBeenCalledWith({ attempt: 1, delayMs: 500 });
    expect(server.fetch).toHaveBeenCalledOnce();
    expect(onReconnected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(server.fetch).toHaveBeenCalledTimes(2);
    expect(onReconnected).toHaveBeenCalledWith({ position: "12" });
    expect(server.header(1, "last-event-id")).toBe("12");
    expect(new URL((server.requests[1] as Request).url).searchParams.get("types")).toBe(
      "game.user.banned",
    );
    expect(sub.position).toBe("12");
  });

  it("reconnects after a read error and passes the error to onReconnecting", async () => {
    const server = track(makeServer().ok("3").ok("3"));
    const onReconnecting = vi.fn();
    const handler = vi.fn();
    await subscribe(makeJunjo(server), handler, { onReconnecting });

    server.last().abort(new Error("connection reset"));
    await flush();
    expect(onReconnecting).toHaveBeenCalledOnce();
    const info = onReconnecting.mock.calls[0]?.[0] as { error?: Error };
    expect(info.error?.message).toBe("connection reset");

    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(server.header(1, "last-event-id")).toBe("3");
    server.last().push(eventFrame(bannedEvent("evt_after"), "4"));
    await flush();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("backs off with full jitter, keeps retrying 5xx and network errors, and resets after success", async () => {
    const server = track(
      makeServer()
        .ok("1")
        .networkError()
        .status(503, "internal")
        .status(502, "unknown")
        .networkError()
        .status(500, "internal")
        .ok("1")
        .ok("1"),
    );
    const delays: number[] = [];
    const attempts: number[] = [];
    await subscribe(makeJunjo(server), () => {}, {
      reconnect: { initialDelayMs: 100, maxDelayMs: 1000 },
      onReconnecting: ({ attempt, delayMs }) => {
        attempts.push(attempt);
        delays.push(delayMs);
      },
    });

    server.last().end();
    await flush();
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(delays[delays.length - 1] ?? 0);
      await flush();
    }
    // random() is pinned at 0.5: half of min(max, initial * 2^n).
    expect(delays).toEqual([50, 100, 200, 400, 500, 500]);
    expect(attempts).toEqual([1, 2, 3, 4, 5, 6]);
    expect(server.fetch).toHaveBeenCalledTimes(7);

    server.last().end();
    await flush();
    expect(attempts[attempts.length - 1]).toBe(1);
    expect(delays[delays.length - 1]).toBe(50);
  });

  it("uses the full delay range when random() varies", async () => {
    const server = track(makeServer().ok("1"));
    const onReconnecting = vi.fn();
    vi.mocked(Math.random).mockReturnValue(0.999);
    await subscribe(makeJunjo(server), () => {}, { onReconnecting });
    server.last().end();
    await flush();
    expect(onReconnecting).toHaveBeenCalledWith({ attempt: 1, delayMs: 999 });
  });

  it("on 410 with onResync, opens a live stream before calling onResync", async () => {
    const server = track(makeServer().ok("5").status(410, "stream_position_expired").ok("900"));
    const handler = vi.fn();
    const requestsAtResync: Array<string | null> = [];
    const onResync = vi.fn(() => {
      requestsAtResync.push(...server.requests.map((r) => r.headers.get("last-event-id")));
    });
    const onError = vi.fn();
    const onReconnected = vi.fn();
    const sub = await subscribe(makeJunjo(server), handler, { onResync, onError, onReconnected });

    server.last().end();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();

    expect(onResync).toHaveBeenCalledOnce();
    expect(onResync).toHaveBeenCalledWith({ position: "900" });
    // Initial (no header), resume (5, answered 410), live (no header):
    // all three were sent before onResync ran.
    expect(requestsAtResync).toEqual([null, "5", null]);
    expect(sub.position).toBe("900");
    expect(onError).not.toHaveBeenCalled();
    expect(onReconnected).not.toHaveBeenCalled();

    server.last().push(eventFrame(bannedEvent("evt_live"), "901"));
    await flush();
    expect(handler).toHaveBeenCalledOnce();
  });

  it("on 410 without onResync, stops and fires onError with the 410", async () => {
    const server = track(makeServer().ok("5").status(410, "stream_position_expired"));
    const onError = vi.fn();
    await subscribe(makeJunjo(server), () => {}, { onError });

    server.last().end();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "stream_position_expired",
      status: 410,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "invalid_api_key"],
    [429, "too_many_streams"],
    [400, "bad_request"],
    [403, "forbidden"],
    [404, "not_found"],
  ])("treats a %i on reconnect as fatal", async (status, code) => {
    const server = track(makeServer().ok("5").status(status, code));
    const onError = vi.fn();
    const onReconnecting = vi.fn();
    await subscribe(makeJunjo(server), () => {}, { onError, onReconnecting });

    server.last().end();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(JunjoError);
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code, status });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledTimes(2);
    expect(onReconnecting).toHaveBeenCalledOnce();
  });

  it("with reconnect disabled, a server close fires onError with network_error", async () => {
    const server = track(makeServer().ok("5"));
    const onError = vi.fn();
    await subscribe(makeJunjo(server), () => {}, { reconnect: false, onError });

    server.last().end();
    await flush();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0]?.[0]).toMatchObject({ code: "network_error" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("close() cancels a pending reconnect and fires nothing afterwards", async () => {
    const server = track(makeServer().ok("5"));
    const onError = vi.fn();
    const onReconnecting = vi.fn();
    const sub = await subscribe(makeJunjo(server), () => {}, { onError, onReconnecting });

    server.last().end();
    await flush();
    expect(onReconnecting).toHaveBeenCalledOnce();
    sub.close();
    sub.close();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(server.fetch).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("close() during an in-flight reconnect aborts it silently", async () => {
    let release: (() => void) | undefined;
    const server = track(makeServer().ok("5"));
    const onError = vi.fn();
    const onReconnecting = vi.fn();
    const sub = await subscribe(makeJunjo(server), () => {}, { onError, onReconnecting });
    let reconnectSignal: AbortSignal | undefined;
    server.fetch.mockImplementationOnce(async (_url, init) => {
      reconnectSignal = (init as RequestInit).signal ?? undefined;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new DOMException("aborted", "AbortError");
    });

    server.last().end();
    await flush();
    await vi.advanceTimersByTimeAsync(500);
    await flush();
    expect(reconnectSignal?.aborted).toBe(false);
    sub.close();
    expect(reconnectSignal?.aborted).toBe(true);
    release?.();
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(onReconnecting).toHaveBeenCalledOnce();
  });
});

describe("events.subscribe: abort", () => {
  it("aborting the signal mid-stream closes it and delivers nothing more", async () => {
    const server = track(makeServer().ok("1"));
    const ac = new AbortController();
    const handler = vi.fn();
    const onError = vi.fn();
    await subscribe(makeJunjo(server), handler, { signal: ac.signal, onError });

    ac.abort();
    expect(server.last().cancelled).toBe(true);
    server.last().push(eventFrame(bannedEvent("evt_late"), "2"));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("aborting during a pending reconnect cancels it", async () => {
    const server = track(makeServer().ok("1"));
    const ac = new AbortController();
    const onReconnecting = vi.fn();
    await subscribe(makeJunjo(server), () => {}, { signal: ac.signal, onReconnecting });

    server.last().end();
    await flush();
    expect(onReconnecting).toHaveBeenCalledOnce();
    ac.abort();
    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(server.fetch).toHaveBeenCalledOnce();
  });

  it("aborting during the first connection rejects with cancelled", async () => {
    const ac = new AbortController();
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const junjo = new Junjo({
      apiKey: "jk_test.secret",
      baseUrl: "https://example.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    const pending = junjo.events.subscribe(() => {}, { signal: ac.signal });
    await flush(2);
    ac.abort();
    await expect(pending).rejects.toMatchObject({ code: "cancelled" });
  });
});
