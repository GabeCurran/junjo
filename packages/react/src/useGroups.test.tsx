import { Junjo, JunjoError } from "@junjo.io/sdk";
import type { GameId, Group, GroupId, Page, UserId } from "@junjo.io/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JunjoProvider } from "./JunjoProvider.js";
import { useGroups } from "./useGroups.js";

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
  Object.assign(client.groups, { list, subscribe });
  return { client, list, subscribe };
}

function makeGroup(id: string, overrides: Partial<Group> = {}): Group {
  return {
    id: id as GroupId,
    gameId: GAME_ID,
    kind: "guild",
    name: `Group ${id}`,
    visibility: "public",
    metadata: {},
    defaultRoleId: null,
    parentGroupId: null,
    memberCount: 0,
    hasPasscode: false,
    createdAt: new Date("2026-04-28T00:00:00.000Z"),
    updatedAt: new Date("2026-04-28T00:00:00.000Z"),
    softDeletedAt: null,
    ...overrides,
  };
}

function groupsPage(items: Group[], nextCursor: string | null = null): Page<Group> {
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

describe("useGroups", () => {
  it("fetches the first page of groups on mount and exposes them on the result", async () => {
    const h = makeHarness();
    const a = makeGroup("grp_a");
    const b = makeGroup("grp_b");
    h.list.mockResolvedValue(groupsPage([a, b]));

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });

    expect(result.current.loading).toBe(true);
    expect(result.current.groups).toEqual([]);
    expect(result.current.error).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toEqual([a, b]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.error).toBeNull();
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith({});
  });

  it("passes gameId, viewer, and limit through to groups.list", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(groupsPage([]));
    const viewer = "user_viewer" as UserId;

    const { result } = renderHook(() => useGroups({ gameId: GAME_ID, viewer, limit: 5 }), {
      wrapper: wrapper(h.client),
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.list).toHaveBeenCalledWith({ limit: 5, gameId: GAME_ID, viewer });
  });

  it("does not open any SSE subscription (event streams are per-group)", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(groupsPage([makeGroup("grp_a")]));

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.subscribe).not.toHaveBeenCalled();
  });

  it("captures a JunjoError thrown by groups.list into result.error", async () => {
    const h = makeHarness();
    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValue(err);

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(err);
    expect(result.current.groups).toEqual([]);
  });

  it("refetch re-runs the list call and clears prior error", async () => {
    const h = makeHarness();
    h.list.mockRejectedValueOnce(new JunjoError("transient", "internal", 500));

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(JunjoError));

    const group = makeGroup("grp_a");
    h.list.mockResolvedValueOnce(groupsPage([group]));
    await act(async () => {
      await result.current.refetch();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.groups).toEqual([group]);
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("exposes hasMore and appends the next page on fetchMore", async () => {
    const h = makeHarness();
    const a = makeGroup("grp_a");
    const b = makeGroup("grp_b");
    const c = makeGroup("grp_c");
    h.list.mockResolvedValueOnce(groupsPage([a, b], "cursor_1"));

    const { result } = renderHook(() => useGroups({ limit: 2 }), { wrapper: wrapper(h.client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.groups).toEqual([a, b]);
    expect(result.current.hasMore).toBe(true);

    h.list.mockResolvedValueOnce(groupsPage([c], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.groups).toEqual([a, b, c]);
    expect(result.current.hasMore).toBe(false);
    expect(h.list).toHaveBeenLastCalledWith({ limit: 2, cursor: "cursor_1" });
  });

  it("fetchMore is a no-op when hasMore is false", async () => {
    const h = makeHarness();
    h.list.mockResolvedValue(groupsPage([makeGroup("grp_a")], null));

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("deduplicates groups already present when appending a page", async () => {
    const h = makeHarness();
    const a = makeGroup("grp_a");
    const b = makeGroup("grp_b");
    h.list.mockResolvedValueOnce(groupsPage([a], "cursor_1"));

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    h.list.mockResolvedValueOnce(groupsPage([a, b], null));
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.groups.map((g) => g.id)).toEqual(["grp_a", "grp_b"]);
  });

  it("captures a fetchMore error without dropping previous groups", async () => {
    const h = makeHarness();
    const a = makeGroup("grp_a");
    h.list.mockResolvedValueOnce(groupsPage([a], "cursor_1"));

    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(h.client) });
    await waitFor(() => expect(result.current.hasMore).toBe(true));

    const err = new JunjoError("boom", "internal", 500);
    h.list.mockRejectedValueOnce(err);
    await act(async () => {
      await result.current.fetchMore();
    });

    expect(result.current.error).toBe(err);
    expect(result.current.groups).toEqual([a]);
    expect(result.current.hasMore).toBe(true);
  });

  it("refetches from the first page when the viewer changes", async () => {
    const h = makeHarness();
    const open = makeGroup("grp_open");
    const secret = makeGroup("grp_secret", { visibility: "secret" });
    h.list.mockImplementation((opts: { viewer?: UserId }) =>
      Promise.resolve(groupsPage(opts.viewer === undefined ? [open, secret] : [open])),
    );

    const { result, rerender } = renderHook(
      ({ viewer }: { viewer?: UserId }) => useGroups({ viewer }),
      { initialProps: { viewer: undefined as UserId | undefined }, wrapper: wrapper(h.client) },
    );

    await waitFor(() => expect(result.current.groups).toEqual([open, secret]));

    rerender({ viewer: "user_outsider" as UserId });

    await waitFor(() => expect(result.current.groups).toEqual([open]));
    expect(h.list).toHaveBeenLastCalledWith({ viewer: "user_outsider" });
  });
});
