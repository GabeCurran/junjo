import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { Ban, GameId, Page, UserId } from "@junjo.io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useBans } from "./useBans.js";

const GAME_ID = "game_test" as GameId;

interface Harness {
  client: Junjo;
  list: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

function makeHarness(): Harness {
  const client = new Junjo({
    apiKey: "test_prefix.test_secret",
    fetch: vi.fn() as unknown as typeof fetch,
  });
  const list = vi.fn();
  const subscribe = vi.fn();
  Object.assign(client.bans, { list });
  Object.assign(client.groups, { subscribe });
  return { client, list, subscribe };
}

function makeBan(userId: string, overrides: Partial<Ban> = {}): Ban {
  return {
    id: `ban_${userId}`,
    gameId: GAME_ID,
    userId: userId as UserId,
    bannedAt: new Date("2026-04-28T00:00:00.000Z"),
    expiresAt: null,
    reason: null,
    bannedBy: null,
    ...overrides,
  };
}

function bansPage(items: Ban[], nextCursor: string | null = null): Page<Ban> {
  return { items, nextCursor };
}

function wrapper(client: Junjo) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <JunjoProvider client={client}>{children}</JunjoProvider>;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useBans", () => {
  it("fetches the first page of game bans on mount and exposes them on the result", async () => {
    const h = makeHarness();
    const a = makeBan("user_a");
    const b = makeBan("user_b");
    h.list.mockResolvedValue(bansPage([a, b]));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.bans).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bans).toEqual([a, b]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith({});
  });

  it("passes includeExpired and limit through to bans.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(bansPage([]));

    const { result } = renderHook(() => useBans({ includeExpired: true, limit: 10 }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.list).toHaveBeenCalledWith({ limit: 10, includeExpired: true });
  });

  it("does not open any SSE subscription (game bans are webhook-only)", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(bansPage([makeBan("user_a")]));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("captures a JunjoError thrown by bans.list into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.bans).toEqual([]);
  });

  it("refetch re-runs the list call and clears prior error", async () => {
    const h = makeHarness();
    h.list.mockRejectedValueOnce(new JunjoError("transient", "internal", 500));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(JunjoError));

    const ban = makeBan("user_a");
    h.list.mockResolvedValueOnce(bansPage([ban]));
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.bans).toEqual([ban]);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("exposes hasMore and appends the next page on fetchMore", async () => {
    const h = makeHarness();
    const a = makeBan("user_a");
    const b = makeBan("user_b");
    const c = makeBan("user_c");
    h.list.mockResolvedValueOnce(bansPage([a, b], "cursor_1"));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.bans).toEqual([a, b]);
    expect(result.current.hasMore).toBe(true);

    h.list.mockResolvedValueOnce(bansPage([c], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.bans).toEqual([a, b, c]);
    expect(result.current.hasMore).toBe(false);
    expect(h.list).toHaveBeenLastCalledWith({ cursor: "cursor_1" });
  });

  it("fetchMore is a no-op when hasMore is false", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(bansPage([makeBan("user_a")], null));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("deduplicates bans already present when appending a page", async () => {
    const h = makeHarness();
    const a = makeBan("user_a");
    const b = makeBan("user_b");
    h.list.mockResolvedValueOnce(bansPage([a], "cursor_1"));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    h.list.mockResolvedValueOnce(bansPage([a, b], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.bans.map((x) => x.userId)).toEqual(["user_a", "user_b"]);
  });

  it("captures a fetchMore error without dropping previous bans", async () => {
    const h = makeHarness();
    const a = makeBan("user_a");
    h.list.mockResolvedValueOnce(bansPage([a], "cursor_1"));

    const { result } = renderHook(() => useBans(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValueOnce(err);
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.error).toBe(err);
    expect(result.current.bans).toEqual([a]);
    expect(result.current.hasMore).toBe(true);
  });

  it("refetches from the first page when includeExpired changes", async () => {
    const h = makeHarness();
    const active = makeBan("user_a");
    const expired = makeBan("user_b", { expiresAt: new Date("2026-01-01T00:00:00.000Z") });
    h.list.mockImplementation((opts: { includeExpired?: boolean }) =>
      Promise.resolve(bansPage(opts.includeExpired === true ? [active, expired] : [active])),
    );

    const { result, rerender } = renderHook(
      ({ includeExpired }: { includeExpired: boolean }) => useBans({ includeExpired }),
      { initialProps: { includeExpired: false }, wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current.bans).toEqual([active]));

    rerender({ includeExpired: true });

    await waitFor(() => expect(result.current.bans).toEqual([active, expired]));
    expect(h.list).toHaveBeenLastCalledWith({ includeExpired: true });
  });
});
