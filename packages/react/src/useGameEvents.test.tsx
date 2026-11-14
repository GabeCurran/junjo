import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { GameEventMeta, GameSubscribeOptions, GameSubscription } from "@junjo.io/sdk";
import type { GameId, JunjoEvent, JunjoEventType, UserId } from "@junjo.io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useGameEvents } from "./useGameEvents.js";

const GAME_ID = "game_test" as GameId;

interface Capture {
  handler: (event: JunjoEvent, meta: GameEventMeta) => void;
  opts: GameSubscribeOptions;
  close: ReturnType<typeof vi.fn>;
}

interface Harness {
  client: Junjo;
  subscribe: ReturnType<typeof vi.fn>;
  captures: Capture[];
}

// `pending` keeps each handshake unresolved until the test settles it.
function makeHarness(opts: { position?: string; pending?: boolean } = {}): Harness & {
  resolve: (i: number) => void;
  reject: (i: number, err: Error) => void;
} {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const captures: Capture[] = [];
  const settlers: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  const subscribe = vi.fn(
    (
      handler: (event: JunjoEvent, meta: GameEventMeta) => void,
      subOpts: GameSubscribeOptions = {},
    ) => {
      const close = vi.fn();
      captures.push({ handler, opts: subOpts, close });
      const sub: GameSubscription = { close, position: opts.position ?? "100" };
      if (!opts.pending) return Promise.resolve(sub);
      return new Promise<GameSubscription>((resolve, reject) => {
        settlers.push({ resolve: () => resolve(sub), reject });
      });
    },
  );
  Object.assign(client.events, { subscribe });
  return {
    client,
    subscribe,
    captures,
    resolve: (i) => settlers[i]?.resolve(),
    reject: (i, err) => settlers[i]?.reject(err),
  };
}

function wrapper(client: Junjo, strict = false) {
  return function Wrapper({ children }: { children: ReactNode }) {
    const tree = <JunjoProvider client={client}>{children}</JunjoProvider>;
    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
}

function banned(id: string): JunjoEvent {
  return {
    id,
    gameId: GAME_ID,
    occurredAt: new Date("2026-11-06T12:00:00.000Z"),
    origin: { apiKeyId: null, tag: null },
    type: "game.user.banned",
    moderationVersion: 1,
    junjoUserId: "ju_1",
    userId: "user_alice" as UserId,
    reason: null,
    expiresAt: null,
  };
}

function unbanned(id: string): JunjoEvent {
  return {
    id,
    gameId: GAME_ID,
    occurredAt: new Date("2026-11-06T12:00:00.000Z"),
    origin: { apiKeyId: null, tag: null },
    type: "game.user.unbanned",
    moderationVersion: 1,
    junjoUserId: "ju_1",
    userId: "user_alice" as UserId,
  };
}

function capture(h: Harness, i = 0): Capture {
  const c = h.captures[i];
  if (c === undefined) throw new Error(`no subscription #${i}`);
  return c;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useGameEvents", () => {
  it("opens one unfiltered stream and reports connecting, then open with the start position", async () => {
    const h = makeHarness({ position: "42", pending: true });
    const { result } = renderHook(() => useGameEvents(() => {}), { wrapper: wrapper(h.client) });

    expect(result.current).toEqual({ status: "connecting", error: null, position: null });
    expect(h.subscribe).toHaveBeenCalledOnce();
    expect(capture(h).opts.types).toBeUndefined();

    await act(async () => h.resolve(0));
    expect(result.current).toEqual({ status: "open", error: null, position: "42" });
  });

  it("shares one SDK subscription across hooks and filters by type per hook", async () => {
    const h = makeHarness();
    const all: string[] = [];
    const bansOnly: string[] = [];
    const { result } = renderHook(
      () => {
        const a = useGameEvents((e) => all.push(e.id));
        const b = useGameEvents((e) => bansOnly.push(e.id), { types: ["game.user.banned"] });
        return { a, b };
      },
      { wrapper: wrapper(h.client) },
    );
    await waitFor(() => expect(result.current.a.status).toBe("open"));
    expect(result.current.b.status).toBe("open");
    expect(h.subscribe).toHaveBeenCalledOnce();

    act(() => {
      capture(h).handler(banned("evt_1"), { position: "101" });
      capture(h).handler(unbanned("evt_2"), { position: "102" });
    });
    expect(all).toEqual(["evt_1", "evt_2"]);
    expect(bansOnly).toEqual(["evt_1"]);
    expect(result.current.a.position).toBe("102");
    expect(result.current.b.position).toBe("101");
  });

  it("uses the latest handler and types without resubscribing", async () => {
    const h = makeHarness();
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ handler, types }: { handler: () => void; types: JunjoEventType[] }) =>
        useGameEvents(handler, { types }),
      {
        wrapper: wrapper(h.client),
        initialProps: { handler: first, types: ["game.user.banned", "game.user.unbanned"] },
      },
    );
    await waitFor(() => expect(result.current.status).toBe("open"));

    // Same set in another order: no resubscribe.
    rerender({ handler: second, types: ["game.user.unbanned", "game.user.banned"] });
    act(() => capture(h).handler(banned("evt_1"), { position: "101" }));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();

    rerender({ handler: second, types: ["game.user.unbanned"] });
    act(() => capture(h).handler(banned("evt_2"), { position: "102" }));
    expect(second).toHaveBeenCalledOnce();

    expect(h.subscribe).toHaveBeenCalledOnce();
    expect(capture(h).close).not.toHaveBeenCalled();
  });

  it("reports reconnecting and returns to open after the SDK reconnects", async () => {
    const h = makeHarness();
    const { result } = renderHook(() => useGameEvents(() => {}), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.status).toBe("open"));

    act(() => capture(h).opts.onReconnecting?.({ attempt: 1, delayMs: 500 }));
    expect(result.current.status).toBe("reconnecting");
    expect(result.current.position).toBe("100");

    act(() => capture(h).opts.onReconnected?.({ position: "120" }));
    expect(result.current).toEqual({ status: "open", error: null, position: "120" });
  });

  it("fans onResync to every hook and reports the new live position", async () => {
    const h = makeHarness();
    const resyncA = vi.fn();
    const resyncB = vi.fn();
    const { result } = renderHook(
      () => ({
        a: useGameEvents(() => {}, { onResync: resyncA }),
        b: useGameEvents(() => {}, { onResync: resyncB }),
      }),
      { wrapper: wrapper(h.client) },
    );
    await waitFor(() => expect(result.current.a.status).toBe("open"));

    act(() => capture(h).opts.onReconnecting?.({ attempt: 1, delayMs: 0 }));
    act(() => capture(h).opts.onResync?.({ position: "900" }));
    expect(resyncA).toHaveBeenCalledWith({ position: "900" });
    expect(resyncB).toHaveBeenCalledWith({ position: "900" });
    expect(result.current.a).toEqual({ status: "open", error: null, position: "900" });
  });

  it("surfaces a fatal error on every hook and reopens a fresh stream on the next mount", async () => {
    const h = makeHarness();
    const first = renderHook(() => ({ a: useGameEvents(() => {}), b: useGameEvents(() => {}) }), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(first.result.current.a.status).toBe("open"));

    const fatal = new JunjoError("too many streams", "too_many_streams", 429);
    act(() => capture(h).opts.onError?.(fatal));
    expect(first.result.current.a).toEqual({ status: "closed", error: fatal, position: "100" });
    expect(first.result.current.b.error).toBe(fatal);
    expect(capture(h).close).toHaveBeenCalledOnce();

    first.unmount();

    // A new mount opens a fresh stream; the dead one delivers nothing.
    const late = vi.fn();

    const second = renderHook(() => useGameEvents(late), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(second.result.current.status).toBe("open"));
    expect(h.subscribe).toHaveBeenCalledTimes(2);
    act(() => capture(h, 0).handler(banned("evt_stale"), { position: "101" }));
    expect(late).not.toHaveBeenCalled();
    act(() => capture(h, 1).handler(banned("evt_fresh"), { position: "101" }));
    expect(late).toHaveBeenCalledOnce();
  });

  it("surfaces a rejected first connection as closed with the error", async () => {
    const h = makeHarness({ pending: true });
    const { result } = renderHook(() => useGameEvents(() => {}), { wrapper: wrapper(h.client) });
    const err = new JunjoError("bad key", "invalid_api_key", 401);
    await act(async () => h.reject(0, err));
    expect(result.current).toEqual({ status: "closed", error: err, position: null });
  });

  it("closes the stream when the last hook unmounts, not before", async () => {
    const h = makeHarness();
    const a = renderHook(() => useGameEvents(() => {}), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(a.result.current.status).toBe("open"));
    // A second hook under its own provider gets its own hub and stream;
    // two hooks under one provider share the stream.
    const both = renderHook(() => ({ x: useGameEvents(() => {}), y: useGameEvents(() => {}) }), {
      wrapper: wrapper(h.client),
    });
    await waitFor(() => expect(both.result.current.x.status).toBe("open"));
    expect(h.subscribe).toHaveBeenCalledTimes(2);

    a.unmount();
    expect(capture(h, 0).close).toHaveBeenCalledOnce();
    expect(capture(h, 1).close).not.toHaveBeenCalled();
    both.unmount();
    expect(capture(h, 1).close).toHaveBeenCalledOnce();
  });

  it("closes a handshake that resolves after every hook unmounted", async () => {
    const h = makeHarness({ pending: true });
    const { unmount } = renderHook(() => useGameEvents(() => {}), { wrapper: wrapper(h.client) });
    unmount();
    expect(capture(h).close).not.toHaveBeenCalled();
    await act(async () => h.resolve(0));
    expect(capture(h).close).toHaveBeenCalledOnce();
  });

  it("tells a hook that mounts onto an open stream that it is open", async () => {
    const h = makeHarness();
    const { result, rerender } = renderHook(
      ({ second }: { second: boolean }) => ({
        a: useGameEvents(() => {}),
        b: useGameEvents(() => {}, { enabled: second }),
      }),
      { wrapper: wrapper(h.client), initialProps: { second: false } },
    );
    await waitFor(() => expect(result.current.a.status).toBe("open"));
    expect(result.current.b).toEqual({ status: "closed", error: null, position: null });

    rerender({ second: true });
    await waitFor(() => expect(result.current.b.status).toBe("open"));
    expect(result.current.b.position).toBe("100");
    expect(h.subscribe).toHaveBeenCalledOnce();
  });

  it("does not subscribe while disabled and detaches when disabled again", async () => {
    const h = makeHarness();
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useGameEvents(() => {}, { enabled }),
      { wrapper: wrapper(h.client), initialProps: { enabled: false } },
    );
    expect(result.current.status).toBe("closed");
    expect(h.subscribe).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe("open"));
    rerender({ enabled: false });
    expect(result.current).toEqual({ status: "closed", error: null, position: null });
    expect(capture(h).close).toHaveBeenCalledOnce();
  });

  it("isolates a throwing handler from the other hooks and the stream", async () => {
    const h = makeHarness();
    const ok = vi.fn();
    const { result } = renderHook(
      () => ({
        bad: useGameEvents(() => {
          throw new Error("consumer bug");
        }),
        good: useGameEvents(ok),
      }),
      { wrapper: wrapper(h.client) },
    );
    await waitFor(() => expect(result.current.good.status).toBe("open"));

    expect(() => act(() => capture(h).handler(banned("evt_1"), { position: "101" }))).not.toThrow();
    expect(ok).toHaveBeenCalledOnce();
    expect(result.current.good.status).toBe("open");
    expect(capture(h).close).not.toHaveBeenCalled();
  });

  it("settles on one open stream under StrictMode", async () => {
    const h = makeHarness();
    const { result, unmount } = renderHook(() => useGameEvents(() => {}), {
      wrapper: wrapper(h.client, true),
    });
    await waitFor(() => expect(result.current.status).toBe("open"));
    const open = h.captures.filter((c) => c.close.mock.calls.length === 0);
    expect(open).toHaveLength(1);
    unmount();
    expect(h.captures.every((c) => c.close.mock.calls.length === 1)).toBe(true);
  });

  it("throws outside a JunjoProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useGameEvents(() => {}))).toThrow(/JunjoProvider/);
  });
});
